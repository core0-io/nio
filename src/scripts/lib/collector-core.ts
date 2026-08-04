// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Platform-agnostic collector core.
 *
 * Routes a canonical hook event into the OTEL metrics + traces stack and
 * the audit log. Both the Claude Code stdin wrapper
 * ([../collector-hook.ts](../collector-hook.ts)) and the Hermes shell-
 * hook dispatcher in [../hook-cli.ts](../hook-cli.ts) call into this
 * module so the per-platform script stays thin.
 *
 * Cross-process trace state (turn_trace_id, pending span starts, …) is
 * loaded from `traces-state-store` at the top of each branch, mutated via the
 * pure functions in `traces-collector`, and saved back. The trace module
 * itself never touches the filesystem.
 *
 * Hook event audit records flow through `writeAuditLog` (shared with
 * guard / scan / lifecycle entries), landing in `~/.nio/audit.jsonl` by
 * default or `collector.logs.path` when configured.
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
 *   SessionStart / SessionEnd — session boundary audit (Hermes-driven;
 *                      SessionEnd doubles as defensive turn-close)
 *
 * Unknown events are silently ignored, matching the legacy collector-
 * hook behaviour. Always returns; never throws to the caller.
 */

import type { MeterProvider } from '@opentelemetry/sdk-metrics';
import type { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { LoggerProvider } from '@opentelemetry/sdk-logs';

import type { ResolvedMetricsConfig as CollectorConfig } from '../../adapters/common.js';
import type { CollectorLogsConfig } from '../../adapters/config-schema.js';
import type { AuditHookEntry, HookEventName } from '../../adapters/audit-types.js';
import { writeAuditLog } from '../../adapters/common.js';
import { recordToolUse, recordTurn } from './metrics-collector.js';
import { forgetSession } from './monitor-check.js';
import {
  ensureTurn,
  recordPreToolUse,
  recordPostToolUse,
  recordPreTaskToolUse,
  recordPostTaskToolUse,
  endTurn,
  recordUserPrompt,
  genAiToolCallInputAttributes,
  genAiToolCallOutputAttributes,
  takePendingGuardAttrs,
} from './traces-collector.js';
import { loadState, saveState, type CollectorState } from './traces-state-store.js';

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
  /**
   * User-configured telemetry identity (from `agent_name` in ~/.nio/config.yaml).
   * Lands as `gen_ai.agent.name` on traces + log records, and as `agent_name`
   * on audit-log entries. Empty string / undefined means "fall back to platform".
   */
  agentName?: string;
  config: CollectorConfig;
  meterProvider: MeterProvider | null;
  tracerProvider: NodeTracerProvider | null;
  /** OTEL Logs provider for audit-record export. Optional. */
  loggerProvider?: LoggerProvider | null;
  /**
   * Audit log + trace state path config. Used to resolve audit.jsonl AND
   * the traces-state-store.json location (state file sits next to audit
   * log). When omitted, both default to `${NIO_HOME ?? ~/.nio}/`.
   */
  logsConfig?: CollectorLogsConfig;
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

/** Stable per-tool-call key. Prefers tool_use_id when supplied;
 * otherwise falls back to a DETERMINISTIC composite of
 * `tool_name + tool_summary` so the PRE and POST sides can compute
 * the same key without sharing identifiers. Hermes's pre_tool_call
 * shell-hook payload doesn't include tool_call_id (see
 * agent/agent_runtime_helpers.py invoke_tool() — it passes only
 * task_id to get_pre_tool_call_block_message), while post_tool_call
 * does include it. With the old `Date.now()` fallback, every
 * Hermes pre/post pair ended up under different keys and no
 * execute_tool span ever reached OTLP for the allow path.
 *
 * Composite fallback risk: two SIMULTANEOUS calls of the same tool
 * with identical args would collide on the same key (second pre
 * overwrites first; first post closes second pre's pending). Worth
 * the trade-off since Hermes tool calls in a single session run
 * serially, and tool_use_id-bearing platforms (Claude Code,
 * OpenClaw, Codex) bypass this branch entirely. */
export function spanKey(input: HookStdinPayload): string {
  if (input.tool_use_id) return input.tool_use_id;
  const name = input.tool_name ?? 'unknown';
  const summary = toolSummary(name, input.tool_input ?? {});
  return `${name}:${summary}`;
}

/** Resolve the actual key that has a pending entry — primary spanKey
 * first, composite-fallback second. Handles the Hermes asymmetry
 * where pre's tool_use_id is empty (composite key saved) but post
 * has the real tool_use_id (would generate a tool_use_id-based key
 * that misses the composite entry). */
function resolveSpanKey(
  state: CollectorState,
  input: HookStdinPayload,
): string {
  const primary = spanKey(input);
  if (state.pending_spans[primary]) return primary;
  const name = input.tool_name ?? 'unknown';
  const fallback = `${name}:${toolSummary(name, input.tool_input ?? {})}`;
  if (state.pending_spans[fallback]) return fallback;
  return primary;
}

const KNOWN_HOOK_EVENTS: ReadonlySet<HookEventName> = new Set<HookEventName>([
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'TaskCreated',
  'TaskCompleted',
  'Stop',
  'SubagentStop',
  'SessionStart',
  'SessionEnd',
]);

function isKnownHookEvent(event: string): event is HookEventName {
  return KNOWN_HOOK_EVENTS.has(event as HookEventName);
}

// ── Core dispatcher ─────────────────────────────────────────────────────

/**
 * Route a single hook event through the metrics + traces + audit log
 * pipeline.
 *
 * All platforms share this; the only platform-specific concern is
 * translating the native event name into the canonical names listed at
 * the top of this module before calling dispatch.
 */
export async function dispatchCollectorEvent(opts: DispatchOptions): Promise<void> {
  const {
    event, input, platform, agentName,
    meterProvider, tracerProvider,
    loggerProvider = null, logsConfig,
  } = opts;

  const toolName = input.tool_name ?? '';
  const sessionId = input.session_id ?? 'unknown';
  const cwd = input.cwd ?? null;
  const transcriptPath = input.transcript_path ?? null;
  const toolInput = input.tool_input ?? {};
  const auditOpts = { loggerProvider, logsConfig };

  // Shared base fields for every audit entry shape. Branches augment with
  // event-specific fields (task_id/task_summary, …) before writing. We
  // include agent_name on the entry only when the user configured an alias
  // (distinct from platform) — the fallback-to-platform case keeps the
  // entry shape minimal for unconfigured users.
  const baseFields: Omit<AuditHookEntry, 'event'> = {
    timestamp: new Date().toISOString(),
    platform,
    ...(agentName && agentName.length > 0 ? { agent_name: agentName } : {}),
    session_id: sessionId,
    cwd,
    ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
    ...(toolName ? {
      tool_name: toolName,
      tool_summary: toolSummary(toolName, toolInput),
    } : {}),
    ...(input.tool_use_id ? { tool_use_id: input.tool_use_id } : {}),
  };

  try {
    if (event === 'UserPromptSubmit') {
      writeAuditLog({ event, ...baseFields }, auditOpts);

      if (tracerProvider && input.prompt) {
        const prev = loadState(logsConfig);
        let state = ensureTurn(prev, sessionId);
        state = recordUserPrompt(state, input.prompt);
        saveState(logsConfig, state);
      }

    } else if (event === 'PreToolUse') {
      writeAuditLog({ event, ...baseFields }, auditOpts);

      const summary = toolSummary(toolName, toolInput);
      const key = spanKey(input);

      if (tracerProvider) {
        const prev = loadState(logsConfig);
        let state = ensureTurn(prev, sessionId);
        state = recordPreToolUse(
          state, key, toolName, summary,
          genAiToolCallInputAttributes(toolInput, input.tool_use_id),
        );
        saveState(logsConfig, state);
      }

      if (meterProvider) {
        await recordToolUse(meterProvider, toolName, event);
      }

    } else if (event === 'PostToolUse') {
      writeAuditLog({ event, ...baseFields }, auditOpts);

      if (tracerProvider) {
        const prev = loadState(logsConfig);
        let state = ensureTurn(prev, sessionId);
        // Resolve the pending entry's key with composite-fallback. Hermes's
        // pre_tool_call hook doesn't carry tool_call_id while post_tool_call
        // does, so pre saved under `${tool_name}:${tool_summary}` while
        // post would by default look up by tool_use_id and miss.
        const key = resolveSpanKey(state, input);
        // Drain guard attrs parked by the PreToolUse-side guard process
        // (separate Node process on Claude Code / Codex). Merged into
        // the closing span so allow-path spans carry nio.guard.* too.
        const drained = takePendingGuardAttrs(state, key);
        state = drained.state;
        const resp = (input.tool_response ?? {}) as Record<string, unknown>;
        const err = (resp.error ?? resp.stderr) as string | undefined;
        const result = await recordPostToolUse(
          tracerProvider, state, key, cwd,
          {
            ...drained.attrs,
            ...genAiToolCallOutputAttributes({ result: resp, error: err ?? null }),
          },
          err ?? null,
        );
        saveState(logsConfig, result.state);
      }

      if (meterProvider) {
        await recordToolUse(meterProvider, toolName, event);
      }

    } else if (event === 'TaskCreated') {
      const taskId = input.task_id ?? spanKey(input);
      const prompt = input.task_input?.prompt ?? JSON.stringify(input.task_input ?? {});
      const summary = (prompt as string).slice(0, 300);

      writeAuditLog(
        { event, ...baseFields, task_id: taskId, task_summary: summary },
        auditOpts,
      );

      if (tracerProvider) {
        const prev = loadState(logsConfig);
        let state = ensureTurn(prev, sessionId);
        state = recordPreTaskToolUse(state, taskId, summary);
        saveState(logsConfig, state);
      }

      if (meterProvider) {
        await recordToolUse(meterProvider, 'Task', event);
      }

    } else if (event === 'TaskCompleted') {
      const taskId = input.task_id ?? spanKey(input);

      writeAuditLog(
        { event, ...baseFields, task_id: taskId },
        auditOpts,
      );

      if (tracerProvider) {
        const prev = loadState(logsConfig);
        const state = ensureTurn(prev, sessionId);
        const result = await recordPostTaskToolUse(
          tracerProvider, state, taskId, cwd,
        );
        saveState(logsConfig, result.state);
      }

      if (meterProvider) {
        await recordToolUse(meterProvider, 'Task', event);
      }

    } else if (event === 'Stop' || event === 'SubagentStop' || event === 'SessionEnd') {
      // SessionEnd is a Hermes-driven addition: on Claude Code, Stop /
      // SubagentStop already close the turn. SessionEnd in Hermes is the
      // hard session boundary; we treat it the same way as a defensive
      // turn-close so any in-flight span gets flushed.
      writeAuditLog({ event, ...baseFields }, auditOpts);

      if (tracerProvider) {
        const prev = loadState(logsConfig);
        const state = ensureTurn(prev, sessionId);
        if (state.turn_trace_id) {
          const next = await endTurn(tracerProvider, state, cwd, transcriptPath);
          if (next) saveState(logsConfig, next);
        }
      }

      if (meterProvider) {
        await recordTurn(meterProvider);
      }

      if (event === 'SessionEnd') {
        forgetSession(sessionId, logsConfig);
      }

    } else if (event === 'SessionStart') {
      writeAuditLog({ event, ...baseFields }, auditOpts);

    } else if (isKnownHookEvent(event)) {
      // Future hook events that are typed but have no specific handling
      // yet — still write an audit entry so they're observable.
      writeAuditLog(
        { event: event as HookEventName, ...baseFields },
        auditOpts,
      );
    }
    // Unknown event names: silently no-op (matches the legacy contract).
  } catch (err) {
    // Telemetry must never break the host; report as a diagnostic so the
    // failure is auditable instead of just appearing on stderr.
    const { reportDiagnostic } = await import('../../adapters/diagnostics.js');
    reportDiagnostic({
      severity: 'warning',
      source: 'collector',
      kind: 'collector_core_error',
      message: '[nio] collector-core failed to process a hook event',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
