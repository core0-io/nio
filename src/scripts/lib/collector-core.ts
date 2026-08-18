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
import { writeAuditLog, asText } from '../../adapters/common.js';
import { recordToolUse, recordTurn } from './metrics-collector.js';
import { forgetSession, sessionEndDisarms } from './monitor-check.js';
import {
  ensureTurn,
  recordPreToolUse,
  recordPostToolUse,
  recordPreTaskToolUse,
  recordPostTaskToolUse,
  endTurn,
  recordUserPrompt,
  genAiToolCallIdAttributes,
  genAiToolCallArgumentAttributes,
  genAiToolCallOutputAttributes,
  takePendingGuardAttrs,
} from './traces-collector.js';
import { loadState, saveState, type CollectorState } from './traces-state-store.js';
import { createSourceForPlatform, type SourceInput } from './conversation/factory.js';
import type { ChatCall } from './conversation/types.js';
import { createContentSink, emitToolInputContent, emitToolOutputContent } from './content/sink.js';
import { buildSpanContent, spanCarriesWholeContent } from './content/span-content.js';
import { loadContentLimits } from './config-loader.js';

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
  /**
   * Extra conversation-source input the caller holds and this module
   * cannot derive from `input`.
   *
   * The replay platforms (Claude Code, Codex) need nothing here — their
   * source is built from `input.transcript_path`. Hermes does: its calls
   * live in the raw `post_llm_call` envelope, which the canonical
   * `HookStdinPayload` has no field for. Merged over the transcript
   * path, so a caller can supply either or both.
   */
  conversationInput?: SourceInput;
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Coerce one tool argument to a string, for ANY runtime value.
 *
 * The `as string` casts this replaces were TypeScript fictions: every
 * `tool_input` reaching this module is either `JSON.parse`d hook stdin
 * (Claude Code / Codex / Hermes) or a live host object (the in-process
 * runtime), and neither is schema-checked before it gets here. A model
 * that emits `{"command": 123}` instead of `{"command": "123"}` used to
 * reach `(123 || '').slice(0, 300)` and throw a TypeError out of
 * `toolSummary` — see the block comment on {@link toolSummary} for what
 * that cost.
 *
 * One definition, shared with the adapters: `adapters/common.ts`'s
 * `asText` covers the same defect class on the guard-DECISION side of
 * the same payload (`parseInput` / `buildEnvelope`). Two copies of a
 * coercion this load-bearing would be two things to keep in step.
 */
const argText = asText;

/**
 * Best-effort summary of a tool invocation, suitable for span attributes
 * and audit log entries. Recognises Claude Code, OpenClaw, and Hermes
 * tool names; falls back to a JSON-stringified preview for unknowns.
 *
 * ── This function is on the GUARD path, so it must be total ───────────
 *
 * It is reached from three places that all run *after* the guard has
 * already decided and *before* that decision is handed to the host:
 * `guard-hook.ts`'s `spanKey()` (Claude Code / Codex), `hook-cli.ts`'s
 * `spanKey()` (Hermes), and `dispatchCollectorEvent`'s `baseFields`,
 * which is built OUTSIDE that function's own try/catch. A throw from
 * here therefore does not degrade telemetry — it kills the process
 * carrying a `deny`, and every host reads a dead hook as "no action":
 *
 *   hermes      `{"decision":"block",…}` on stdout, exit 0
 *                 → empty stdout, exit 1      (measured)
 *   claude code  exit 2 + reason on stderr
 *                 → exit 1 + a Node stack     (measured; exit 1 is
 *                    Claude Code's NON-blocking error code)
 *
 * Both were reproduced end-to-end against the shipped bundles with
 * `tool_input: { command: 123 | true | {…} }` on a `blocked_tools` deny.
 * Hence `argText` on every field read: a malformed tool argument is a
 * telemetry-quality problem, never an enforcement one.
 */
export function toolSummary(toolName: string, toolInput: Record<string, unknown>): string {
  switch (toolName) {
    // Claude Code
    case 'Bash':
      return argText(toolInput['command']).slice(0, 300);
    case 'Write':
    case 'Edit':
      return argText(toolInput['file_path']) || argText(toolInput['path']);
    case 'WebFetch':
    case 'WebSearch':
      return argText(toolInput['url']) || argText(toolInput['query']);
    // Hermes
    case 'terminal':
    case 'exec':
    case 'shell':
      return argText(toolInput['command']).slice(0, 300);
    case 'write_file':
    case 'patch':
    case 'read_file':
      return argText(toolInput['path']) || argText(toolInput['file_path']);
    case 'fetch':
    case 'http_request':
      return argText(toolInput['url']);
    default:
      return argText(toolInput).slice(0, 300);
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

/**
 * Reconstruct this turn's LLM calls so `endTurn` can emit one chat span
 * per call.
 *
 * Returns undefined — never throws — whenever the calls can't be had:
 * a platform with no `ConversationSource`, a source whose input is
 * missing (no transcript path), or an unreadable session file. The
 * caller then emits the pre-chat-layer `turn → tool` shape, which is a
 * degraded trace rather than a broken one.
 *
 * The replay platforms (Claude Code, Codex) are served straight from
 * `transcript_path`. Hermes's calls ride in the raw `post_llm_call`
 * envelope, which the canonical payload has no field for, so
 * `hook-cli.ts` passes it through `DispatchOptions.conversationInput`.
 * OpenClaw never reaches this function: its daemon calls `endTurn`
 * directly.
 */
async function resolveTurnCalls(
  platform: string,
  sourceInput: SourceInput,
  turnStartMs: number,
): Promise<ChatCall[] | undefined> {
  try {
    const source = createSourceForPlatform(platform, sourceInput);
    if (!source) return undefined;
    return source.callsSince(turnStartMs);
  } catch (err) {
    const { reportDiagnostic } = await import('../../adapters/diagnostics.js');
    reportDiagnostic({
      severity: 'warning',
      source: 'collector',
      kind: 'conversation_source_error',
      message: '[nio] could not reconstruct the turn\'s LLM calls; the turn exports without a chat layer',
      detail: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
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

  // `argText`, not `?? ''`: `tool_name` is unvalidated host input and this
  // value is read by string methods downstream. That throw is caught by
  // this function's own try/catch, so it costs enforcement nothing — but
  // it costs the WHOLE branch: no audit entry, no span opened or closed,
  // for every tool call in the session that carries a non-string name.
  const toolName = argText(input.tool_name);
  const sessionId = input.session_id ?? 'unknown';
  const cwd = input.cwd ?? null;
  const transcriptPath = input.transcript_path ?? null;
  const toolInput = input.tool_input ?? {};
  const auditOpts = { loggerProvider, logsConfig };

  // Content limits are read from config lazily and at most once per
  // dispatch: only the branches that actually emit content need them,
  // and most events are neither.
  let cachedLimits: ReturnType<typeof loadContentLimits> | null = null;
  const contentLimits = (): ReturnType<typeof loadContentLimits> => {
    if (cachedLimits === null) cachedLimits = loadContentLimits();
    return cachedLimits;
  };

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
          genAiToolCallIdAttributes(input.tool_use_id),
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
        // The tool span's id was minted at PreToolUse, so the content
        // records below can name it. Read before `recordPostToolUse` —
        // that call removes the pending entry.
        const toolSpanId = state.pending_spans[key]?.span_id ?? '';
        // The arguments come from the live hook payload, not from the
        // state file: PreToolUse parks identity only, so this is the
        // first moment the span and the payload are in hand together.
        // The result is deliberately NOT among these attrs — see the
        // tool-output emit below.
        const argumentText = Object.keys(toolInput).length > 0 ? JSON.stringify(toolInput) : '';
        const spanArgs = buildSpanContent(argumentText);
        const result = await recordPostToolUse(
          tracerProvider, state, key, cwd,
          {
            ...drained.attrs,
            ...(spanArgs ? genAiToolCallArgumentAttributes(spanArgs) : {}),
            ...genAiToolCallOutputAttributes({ error: err ?? null }),
          },
          err ?? null,
        );
        state = result.state;
        saveState(logsConfig, result.state);

        // A plain `output` string is the common shape and is emitted
        // verbatim; anything else is serialised whole so structured
        // responses aren't silently dropped. An absent/empty response
        // produces '' and `emitToolOutputContent` skips it rather than
        // shipping an empty record.
        const resultText = typeof resp['output'] === 'string'
          ? (resp['output'] as string)
          : Object.keys(resp).length > 0 ? JSON.stringify(resp) : '';
        emitToolOutputContent(loggerProvider, contentLimits(), {
          result: resultText,
          spanId: toolSpanId,
          traceId: state.turn_trace_id,
          ...(input.tool_use_id ? { toolCallId: input.tool_use_id } : {}),
        });

        // Arguments go out on the logs signal ONLY when the span above
        // could not carry the whole body. Decided from `spanArgs` — the
        // very value that went onto the span two statements ago — so the
        // span and the record cannot disagree about who owns the bytes.
        // `spanCarriesWholeContent` is false for a truncated body and
        // for no body at all; the latter emits nothing anyway
        // (`emitToolInputContent` skips an empty input).
        if (!spanCarriesWholeContent(spanArgs)) {
          emitToolInputContent(loggerProvider, contentLimits(), {
            input: argumentText,
            spanId: toolSpanId,
            traceId: state.turn_trace_id,
            ...(input.tool_use_id ? { toolCallId: input.tool_use_id } : {}),
          });
        }
      }

      if (meterProvider) {
        await recordToolUse(meterProvider, toolName, event);
      }

    } else if (event === 'TaskCreated') {
      const taskId = input.task_id ?? spanKey(input);
      // `argText`, not `as string`: a `task_input.prompt` that is not a
      // string used to throw here. Caught by this function's try/catch, so
      // again no enforcement cost — but the throw happens BEFORE
      // `writeAuditLog`, so the whole TaskCreated record and its span were
      // lost rather than degraded.
      const summary = argText(
        input.task_input?.prompt ?? JSON.stringify(input.task_input ?? {}),
      ).slice(0, 300);

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
          const calls = await resolveTurnCalls(
            platform,
            { transcriptPath, ...(opts.conversationInput ?? {}) },
            state.turn_start_ms,
          );
          // No provider (unmonitored session, logs disabled) → no sink →
          // endTurn emits the tree and nothing else. This is where the
          // /nio-monitor master switch gates conversation content.
          const contentSink = loggerProvider
            ? createContentSink(loggerProvider, contentLimits())
            : undefined;
          const next = await endTurn(
            tracerProvider, state, cwd, transcriptPath, calls, contentSink,
          );
          if (next) saveState(logsConfig, next);
        }
      }

      if (meterProvider) {
        await recordTurn(meterProvider);
      }

      if (event === 'SessionEnd' && sessionEndDisarms(platform)) {
        // The arm record outlives the session on any platform whose
        // SessionEnd is really a turn boundary — see `sessionEndDisarms`.
        // Dropping it there is the one part of teardown that cannot heal
        // itself: nothing re-creates the arm, and the user is never told
        // their `/nio monitor on` stopped applying.
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
