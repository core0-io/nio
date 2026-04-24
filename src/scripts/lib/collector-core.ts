// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Platform-agnostic collector core.
 *
 * Routes a canonical hook event into the OTEL metrics/traces stack and
 * the local JSONL log. Both the Claude Code stdin wrapper
 * ([../collector-hook.ts](../collector-hook.ts)) and the Hermes shell-
 * hook dispatcher in [../hook-cli.ts](../hook-cli.ts) call into this
 * module so the per-platform script stays thin.
 *
 * Canonical event names (Claude Code shape — adapters at the call site
 * translate their native event names to these before dispatch):
 *
 *   UserPromptSubmit  — turn-start metadata
 *   PreToolUse        — tool span open + tool_use counter
 *   PostToolUse       — tool span close + tool_use counter
 *   TaskCreated       — task span open
 *   TaskCompleted     — task span close
 *   Stop / SubagentStop — turn span close + turn counter
 *   SessionEnd        — defensive turn close (Hermes-driven, no-op on CC)
 *
 * Unknown events are silently ignored, matching the legacy collector-
 * hook behaviour. Always returns; never throws to the caller.
 */

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MeterProvider } from '@opentelemetry/sdk-metrics';
import type { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import type { ResolvedMetricsConfig as CollectorConfig } from '../../adapters/common.js';
import { recordToolUse, recordTurn } from './metrics-collector.js';
import {
  ensureTurn,
  recordPreToolUse,
  recordPostToolUse,
  recordPreTaskToolUse,
  recordPostTaskToolUse,
  endTurn,
  redactAndTruncate,
  setTurnAttributes,
} from './traces-collector.js';

// ── Public types ────────────────────────────────────────────────────────

export interface HookStdinPayload {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: {
    output?: string;
    error?: string;
    interrupted?: boolean;
  };
  stop_reason?: string;
  task_id?: string;
  task_input?: { prompt?: string; [key: string]: unknown };
  task_output?: unknown;
}

export interface DispatchOptions {
  /** Canonical event name (Claude Code shape). */
  event: string;
  input: HookStdinPayload;
  /** Platform tag for span/metric attributes ('claude-code' / 'hermes' / 'openclaw'). */
  platform: string;
  config: CollectorConfig;
  meterProvider: MeterProvider | null;
  tracerProvider: NodeTracerProvider | null;
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Best-effort summary of a tool invocation, suitable for span attributes
 * and audit log entries. Recognises Claude Code, OpenClaw, and Hermes
 * tool names; falls back to a JSON-stringified preview for unknowns.
 */
export function toolSummary(toolName: string, toolInput: Record<string, unknown>): string {
  switch (toolName) {
    // Claude Code
    case 'Bash':
      return ((toolInput['command'] as string) || '').slice(0, 300);
    case 'Write':
    case 'Edit':
      return (toolInput['file_path'] as string) || (toolInput['path'] as string) || '';
    case 'WebFetch':
    case 'WebSearch':
      return (toolInput['url'] as string) || (toolInput['query'] as string) || '';
    // Hermes
    case 'terminal':
    case 'exec':
    case 'shell':
      return ((toolInput['command'] as string) || '').slice(0, 300);
    case 'write_file':
    case 'patch':
    case 'read_file':
      return (toolInput['path'] as string) || (toolInput['file_path'] as string) || '';
    case 'fetch':
    case 'http_request':
      return (toolInput['url'] as string) || '';
    default:
      return JSON.stringify(toolInput).slice(0, 300);
  }
}

/** Stable per-tool-call key. Prefers tool_use_id when supplied. */
export function spanKey(input: HookStdinPayload): string {
  return input.tool_use_id || `${input.tool_name ?? 'unknown'}:${Date.now()}`;
}

/** Append a JSONL record to config.log if configured. Best-effort; no throw. */
export function writeToLog(config: CollectorConfig, record: Record<string, unknown>): void {
  if (!config.log) return;
  try {
    const dir = dirname(config.log);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(config.log, JSON.stringify(record) + '\n');
  } catch {
    // Disk full / permission denied / etc — telemetry never blocks the host.
  }
}

// ── Core dispatcher ─────────────────────────────────────────────────────

/**
 * Route a single hook event through the metrics + traces pipeline.
 *
 * All platforms share this; the only platform-specific concern is
 * translating the native event name into the canonical names listed at
 * the top of this module before calling dispatch.
 */
export async function dispatchCollectorEvent(opts: DispatchOptions): Promise<void> {
  const { event, input, platform, config, meterProvider, tracerProvider } = opts;

  const toolName = input.tool_name ?? '';
  const sessionId = input.session_id ?? 'unknown';
  const cwd = input.cwd ?? null;
  const transcriptPath = input.transcript_path ?? null;
  const toolInput = input.tool_input ?? {};

  writeToLog(config, {
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
          'nio.turn.user_prompt': redactAndTruncate(input.prompt),
        });
      }

    } else if (event === 'PreToolUse') {
      const summary = toolSummary(toolName, toolInput);
      const key = spanKey(input);

      if (tracerProvider) {
        const state = ensureTurn(config, sessionId);
        const preAttrs: Record<string, unknown> = {
          'nio.tool.input': redactAndTruncate(toolInput),
        };
        if (input.tool_use_id) preAttrs['nio.tool.call_id'] = input.tool_use_id;
        recordPreToolUse(config, state, key, toolName, summary, preAttrs);
      }

      if (meterProvider) {
        await recordToolUse(meterProvider, toolName, event, platform);
      }

    } else if (event === 'PostToolUse') {
      const key = spanKey(input);

      if (tracerProvider) {
        const state = ensureTurn(config, sessionId);
        const resp = (input.tool_response ?? {}) as Record<string, unknown>;
        const postAttrs: Record<string, unknown> = {
          'nio.tool.output': redactAndTruncate(resp),
        };
        const err = (resp.error ?? resp.stderr) as string | undefined;
        if (err) postAttrs['nio.tool.error'] = redactAndTruncate(err);
        await recordPostToolUse(config, tracerProvider, state, key, platform, cwd, postAttrs, err ?? null);
      }

      if (meterProvider) {
        await recordToolUse(meterProvider, toolName, event, platform);
      }

    } else if (event === 'TaskCreated') {
      const taskId = input.task_id ?? spanKey(input);
      const prompt = input.task_input?.prompt ?? JSON.stringify(input.task_input ?? {});
      const summary = (prompt as string).slice(0, 300);

      writeToLog(config, {
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

      writeToLog(config, {
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

    } else if (event === 'Stop' || event === 'SubagentStop' || event === 'SessionEnd') {
      // SessionEnd is a Hermes-driven addition: on Claude Code, Stop /
      // SubagentStop already close the turn. SessionEnd in Hermes is the
      // hard session boundary; we treat it the same way as a defensive
      // turn-close so any in-flight span gets flushed.
      if (tracerProvider) {
        const state = ensureTurn(config, sessionId);
        if (state.turn_trace_id) {
          await endTurn(config, tracerProvider, state, platform, cwd, transcriptPath);
        }
      }

      if (meterProvider) {
        await recordTurn(meterProvider, platform);
      }
    }
  } catch (err) {
    // Telemetry must never break the host; log and continue.
    console.error('[nio] collector-core error:', err);
  }
}
