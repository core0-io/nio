#!/usr/bin/env node

export {};

/**
 * FFWD AgentGuard — Collector Hook
 *
 * Async hook that captures telemetry from Claude Code hook events and exports
 * it via two separate pipelines:
 *
 *   Metrics  →  metrics-collector.ts  (counters + histograms)
 *   Traces   →  traces-collector.ts   (turn-scoped OTEL spans)
 *
 * Trace model:
 *   - One OTEL trace per conversation turn (user prompt → Stop event)
 *   - One span per tool call, covering PreToolUse → PostToolUse
 *   - One span per Task execution (same pre/post pattern)
 *
 * Completely independent from guard-hook.js — never influences allow/deny
 * decisions. Always exits 0.
 *
 * Configuration: ~/.ffwd-agent-guard/config.json (metrics section).
 * At least one of metrics.endpoint or metrics.log must be set, otherwise
 * the hook exits immediately without doing anything.
 */

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

import { loadCollectorConfig } from './lib/config-loader.js';
import { createMeterProvider, recordToolUse, recordTurn } from './lib/metrics-collector.js';
import {
  createTracerProvider,
  ensureTurn,
  recordPreToolUse,
  recordPostToolUse,
  recordPreTaskToolUse,
  recordPostTaskToolUse,
  endTurn,
  redactAndTruncate,
  setTurnAttributes,
} from './lib/traces-collector.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HookStdinPayload {
  // Common fields (all events)
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  // UserPromptSubmit
  prompt?: string;
  // PreToolUse / PostToolUse
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: {
    output?: string;
    error?: string;
    interrupted?: boolean;
  };
  // Stop / SubagentStop
  stop_reason?: string;
  // TaskCreated / TaskCompleted
  task_id?: string;
  task_input?: { prompt?: string; [key: string]: unknown };
  task_output?: unknown;
}

const platform = 'claude-code';

// ---------------------------------------------------------------------------
// Load config
// ---------------------------------------------------------------------------

const config = loadCollectorConfig();
if (!config.enabled) {
  process.exit(0);
}

// ---------------------------------------------------------------------------
// stdin reader
// ---------------------------------------------------------------------------

function readStdin(): Promise<HookStdinPayload | null> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => (data += chunk));
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(data) as HookStdinPayload);
      } catch {
        resolve(null);
      }
    });
    setTimeout(() => resolve(null), 5000);
  });
}

// ---------------------------------------------------------------------------
// Tool summary extractor
// ---------------------------------------------------------------------------

function toolSummary(toolName: string, toolInput: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
      return ((toolInput['command'] as string) || '').slice(0, 300);
    case 'Write':
    case 'Edit':
      return (toolInput['file_path'] as string) || (toolInput['path'] as string) || '';
    case 'WebFetch':
    case 'WebSearch':
      return (toolInput['url'] as string) || (toolInput['query'] as string) || '';
    default:
      return JSON.stringify(toolInput).slice(0, 300);
  }
}

// ---------------------------------------------------------------------------
// Local JSONL log
// ---------------------------------------------------------------------------

function writeToLog(record: Record<string, unknown>): void {
  if (!config.log) return;
  const dir = dirname(config.log);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  appendFileSync(config.log, JSON.stringify(record) + '\n');
}

// ---------------------------------------------------------------------------
// Span key: prefer tool_use_id, fall back to tool_name+timestamp
// ---------------------------------------------------------------------------

function spanKey(input: HookStdinPayload): string {
  return input.tool_use_id || `${input.tool_name ?? 'unknown'}:${Date.now()}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const meterProvider = createMeterProvider(config);
const tracerProvider = createTracerProvider(config);

async function main(): Promise<void> {
  const input = await readStdin();
  if (!input) process.exit(0);

  const event = input.hook_event_name ?? '';
  const toolName = input.tool_name ?? '';
  const sessionId = input.session_id ?? 'unknown';
  const cwd = input.cwd ?? null;
  const transcriptPath = input.transcript_path ?? null;
  const toolInput = input.tool_input ?? {};

  writeToLog({
    timestamp: new Date().toISOString(),
    platform,
    event,
    tool_name: toolName,
    session_id: sessionId,
    tool_use_id: input.tool_use_id,
    cwd,
    ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
    tool_summary: toolName ? toolSummary(toolName, toolInput) : undefined,
  });

  try {
    if (event === 'UserPromptSubmit') {
      if (tracerProvider && input.prompt) {
        const state = ensureTurn(config, sessionId);
        setTurnAttributes(config, state, {
          'agentguard.turn.user_prompt': redactAndTruncate(input.prompt),
        });
      }

    } else if (event === 'PreToolUse') {
      const summary = toolSummary(toolName, toolInput);
      const key = spanKey(input);

      if (tracerProvider) {
        const state = ensureTurn(config, sessionId);
        const preAttrs: Record<string, unknown> = {
          'agentguard.tool.input': redactAndTruncate(toolInput),
        };
        if (input.tool_use_id) preAttrs['agentguard.tool.call_id'] = input.tool_use_id;
        recordPreToolUse(config, state, key, toolName, summary, preAttrs);
      }

      if (meterProvider) {
        await recordToolUse(meterProvider, toolName, event, platform);
      }

    } else if (event === 'PostToolUse') {
      const key = spanKey(input);

      if (tracerProvider) {
        const state = ensureTurn(config, sessionId);
        // tool_response shape varies by tool (Bash: {stdout,stderr,…},
        // Read: {file,numLines}, …). Serialize the whole thing so we always
        // capture something; extract error for span status when present.
        const resp = (input.tool_response ?? {}) as Record<string, unknown>;
        const postAttrs: Record<string, unknown> = {
          'agentguard.tool.output': redactAndTruncate(resp),
        };
        const err = (resp.error ?? resp.stderr) as string | undefined;
        if (err) postAttrs['agentguard.tool.error'] = redactAndTruncate(err);
        await recordPostToolUse(config, tracerProvider, state, key, platform, cwd, postAttrs, err ?? null);
      }

      if (meterProvider) {
        await recordToolUse(meterProvider, toolName, event, platform);
      }

    } else if (event === 'TaskCreated') {
      const taskId = input.task_id ?? spanKey(input);
      const prompt = input.task_input?.prompt ?? JSON.stringify(input.task_input ?? {});
      const summary = (prompt as string).slice(0, 300);

      writeToLog({
        timestamp: new Date().toISOString(),
        platform,
        event,
        task_id: taskId,
        session_id: sessionId,
        cwd,
        task_summary: summary,
      });

      if (tracerProvider) {
        const state = ensureTurn(config, sessionId);
        recordPreTaskToolUse(config, state, taskId, summary);
      }

      if (meterProvider) {
        await recordToolUse(meterProvider, 'Task', event, platform);
      }

    } else if (event === 'TaskCompleted') {
      const taskId = input.task_id ?? spanKey(input);

      writeToLog({
        timestamp: new Date().toISOString(),
        platform,
        event,
        task_id: taskId,
        session_id: sessionId,
        cwd,
      });

      if (tracerProvider) {
        const state = ensureTurn(config, sessionId);
        await recordPostTaskToolUse(config, tracerProvider, state, taskId, platform, cwd);
      }

      if (meterProvider) {
        await recordToolUse(meterProvider, 'Task', event, platform);
      }

    } else if (event === 'Stop' || event === 'SubagentStop') {
      if (tracerProvider) {
        const state = ensureTurn(config, sessionId);
        // Only emit turn span if there was actually an active turn
        if (state.turn_trace_id) {
          await endTurn(config, tracerProvider, state, platform, cwd, transcriptPath);
        }
      }

      if (meterProvider) {
        await recordTurn(meterProvider, platform);
      }
    }
  } catch (err) {
    console.error('[agentguard] collector-hook error:', err);
  }

  process.exit(0);
}

main();
