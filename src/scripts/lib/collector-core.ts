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
  deferPostToolUse,
  recordPreTaskToolUse,
  recordPostTaskToolUse,
  endTurn,
  recordUserPrompt,
  genAiToolCallIdAttributes,
  genAiToolCallOutputAttributes,
  takePendingGuardAttrs,
  startSessionTrace,
  emitSessionSpan,
  hasOrphanedDeferredTree,
  recoverDeferredTree,
  createTracerProvider,
} from './traces-collector.js';
import {
  loadState, saveState, discardState, takeAbandonedShards, type CollectorState,
} from './traces-state-store.js';
import { createSourceForPlatform, type SourceInput } from './conversation/factory.js';
import type { ChatCall } from './conversation/types.js';
import { createContentSink, emitToolInputContent, emitToolOutputContent } from './content/sink.js';
import { loadContentLimits, type CollectorConfig as ExporterConfig } from './config-loader.js';

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
   * the traces-state-store shard location (the state files sit next to
   * the audit log). When omitted, both default to `${NIO_HOME ?? ~/.nio}/`.
   */
  logsConfig?: CollectorLogsConfig;
  /**
   * Extra conversation-source input the caller holds and this module
   * cannot derive from `input`.
   *
   * The replay platforms (Claude Code, Codex) need nothing here — their
   * source is built from `input.transcript_path`. The streaming ones do:
   * Hermes's calls live in the raw `post_llm_call` envelope, which the
   * canonical `HookStdinPayload` has no field for. Merged over the
   * transcript path, so a caller can supply either or both.
   */
  conversationInput?: SourceInput;
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * How every metrics call in this module records its point: land it in the
 * aggregator, do NOT wait for the wire.
 *
 * All three of this module's callers — `collector-hook.ts` (Claude Code /
 * Codex), `hook-cli.ts`'s Hermes collector path and its Hermes GUARD path
 * — wrap the whole dispatch in one shared `createFlushBudget` deadline and
 * then end with their own budgeted `meterProvider.forceFlush()` before
 * exiting. A metrics flush *inside* dispatch therefore adds no delivery
 * and spends the shared budget: measured 5.07s (refused endpoint) and
 * 5.21s (stalled endpoint) per dispatch at the default
 * `collector.timeout: 5000`, versus ~0.2s once the flush is dropped.
 *
 * What that cost bought, end-to-end with metrics stalled and traces
 * healthy: `SessionEnd`'s `await recordTurn` burned the caller's remaining
 * budget, the caller abandoned the dispatch, and the three things that
 * come AFTER it — `emitSessionSpan`, `discardState`, `forgetSession` —
 * never ran. Observed on the wire: one `/v1/traces` POST (the turn tree)
 * instead of two, and the session's state shard still on disk. With a
 * healthy sink, byte-identical fixtures produced both POSTs and no shard.
 *
 * The in-process runtime (`plugin-runtime.ts`) keeps the default — it is a
 * long-lived daemon with no process exit to flush at — and so does
 * `recordGuardDecision` on the guard hooks, which is bounded by
 * `createFlushBudget` at each of its call sites instead.
 */
const NO_EARLY_FLUSH = { flush: false } as const;

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
 * Never throws: a value that cannot be serialised (circular object from
 * an in-process host, BigInt) degrades to the empty string rather than
 * taking the caller down with it.
 */
function argText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? '';
    } catch {
      return '';
    }
  }
  // number / boolean / symbol / bigint / function
  try {
    return String(value);
  } catch {
    return '';
  }
}

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

/**
 * Pick a pending-span key that is free right now.
 *
 * `spanKey`'s composite fallback (`name:summary`) collides when two
 * identical calls are in flight at once — the second PRE overwrites the
 * first's pending entry, and the first POST then closes the second's
 * span. Suffixing keeps concurrent calls apart.
 *
 * A real `tool_use_id` is unique by construction, so it is returned
 * untouched: a collision there would mean the host reused an id, and
 * silently renaming it would hide that bug rather than surface it.
 */
export function allocateSpanKey(
  state: CollectorState,
  input: HookStdinPayload,
): string {
  const base = spanKey(input);
  if (input.tool_use_id) return base;
  if (!state.pending_spans[base]) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}#${n}`;
    if (!state.pending_spans[candidate]) return candidate;
  }
}

/**
 * Split an MCP tool name into its server and tool halves.
 *
 * MCP tools arrive as `mcp__<server>__<tool>`. Splitting them lets the
 * span carry `nio.mcp.server` as its own dimension, so "how much of this
 * agent's work goes through MCP" and "which server is slow" become
 * answerable without string-matching tool names at query time.
 *
 * Returns null for anything that is not a well-formed MCP name — the
 * caller then emits the span exactly as before.
 */
export function parseMcpToolName(
  toolName: string,
): { server: string; tool: string } | null {
  if (!toolName.startsWith('mcp__')) return null;
  const rest = toolName.slice(5);
  const sep = rest.indexOf('__');
  if (sep <= 0) return null;
  const server = rest.slice(0, sep);
  const tool = rest.slice(sep + 2);
  if (!server || !tool) return null;
  return { server, tool };
}

/** Resolve the actual key that has a pending entry — primary spanKey
 * first, composite-fallback second, suffixed-composite scan third.
 *
 * Handles the Hermes asymmetry where pre's tool_use_id is empty
 * (composite key saved) but post has the real tool_use_id (would
 * generate a tool_use_id-based key that misses the composite entry).
 *
 * The third tier handles `allocateSpanKey`'s `#N` suffixes (minted
 * when two or more concurrent calls share the same tool_name +
 * tool_summary). Neither `primary` nor `fallback` above ever carries
 * a `#N` suffix — spanKey() never mints one — so without this tier a
 * post that resolves to a still-suffixed key (because the unsuffixed
 * base was already closed by an earlier, unrelated post) never
 * matches anything: no span, and a `#N` entry leaks in pending_spans
 * until endTurn.
 *
 * Picks the SMALLEST pending `#N` (FIFO dequeue — earliest allocated,
 * i.e. earliest still-open call). This is the best a stateless
 * composite key can do: nothing here can recover which physical call
 * a given post response truly belongs to (no id crosses the pre/post
 * boundary in this fallback), so the contract is narrower than
 * "correct" — every post, in any arrival order, resolves to a
 * DIFFERENT still-open entry, so no span is silently dropped and
 * pending_spans always drains empty by end of turn.
 */
function resolveSpanKey(
  state: CollectorState,
  input: HookStdinPayload,
): string {
  const primary = spanKey(input);
  if (state.pending_spans[primary]) return primary;

  const name = input.tool_name ?? 'unknown';
  const compositeBase = `${name}:${toolSummary(name, input.tool_input ?? {})}`;
  if (state.pending_spans[compositeBase]) return compositeBase;

  const prefix = `${compositeBase}#`;
  let best: string | null = null;
  let bestN = Infinity;
  for (const key of Object.keys(state.pending_spans)) {
    if (!key.startsWith(prefix)) continue;
    const suffix = key.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;
    const n = Number(suffix);
    if (n < bestN) {
      bestN = n;
      best = key;
    }
  }
  if (best) return best;

  return primary;
}

/**
 * Reconstruct this turn's LLM calls so `endTurn` can nest each tool span
 * under the call that issued it.
 *
 * Returns undefined — never throws — whenever the calls can't be had:
 * a platform with no `ConversationSource`, a source whose input is
 * missing (no transcript path), or an unreadable session file. The
 * caller then emits the pre-chat-layer `turn → tool` shape, which is a
 * degraded trace rather than a broken one.
 *
 * The replay platforms (Claude Code, Codex) are served straight from
 * `transcript_path` — their calls come from a session file this process
 * can open. Hermes's calls ride in the raw `post_llm_call` envelope,
 * which the canonical payload has no field for, so `hook-cli.ts` passes
 * it through `DispatchOptions.conversationInput`. OpenClaw never reaches
 * this function: its daemon calls `endTurn` directly.
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
      message: '[nio] could not reconstruct the turn\'s LLM calls; tool spans will hang off the turn',
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

  /**
   * Every write goes through here so the shard always carries the
   * identity of the process that owns it. A shard outlives its process
   * and can be swept by a different platform (see `CollectorState.platform`).
   */
  const persist = (state: CollectorState): void => {
    saveState(logsConfig, {
      ...state,
      platform,
      ...(agentName && agentName.length > 0 ? { agent_name: agentName } : {}),
    }, sessionId);
  };

  /**
   * Flush an abandoned shard's deferred tree under the identity of the
   * session that PRODUCED it, not the one doing the sweep.
   *
   * `nio.platform`, `service.name` and `gen_ai.agent.name` live only on
   * the OTEL Resource (9da6c81), and a Resource belongs to a provider —
   * so re-using this process's `tracerProvider` for a foreign shard emits
   * a dead Codex session's spans as `service.name=nio-claude-code` while
   * the spans themselves still carry the Codex `session.id`. All four
   * platforms share `$NIO_HOME` by default and cc/codex are the same
   * scripts behind a different `--platform` flag, so that mismatch is a
   * routine configuration rather than an exotic one.
   *
   * A shard with a matching identity (or one written before the identity
   * fields existed) is emitted on the process's own provider, which is
   * both correct and free. Anything else gets a short-lived,
   * NON-registered provider carrying the shard's own Resource, shut down
   * as soon as the tree is out. Both paths run inside the caller's flush
   * budget, so a dead endpoint cannot turn recovery into a hang.
   */
  const recoverShard = async (state: CollectorState): Promise<void> => {
    if (!tracerProvider) return;
    // `detachedRoot`: the salvage leg leaves the shard's turn OPEN (see
    // SHARD_STALE_MS), so the session may still emit a real turn root on
    // this trace later. A random root span id keeps the two apart.
    const opts_ = { detachedRoot: true } as const;
    const shardPlatform = state.platform ?? platform;
    const shardAgent = state.agent_name ?? agentName ?? '';
    if (shardPlatform === platform && shardAgent === (agentName ?? '')) {
      await recoverDeferredTree(tracerProvider, state, opts_);
      return;
    }
    // `DispatchOptions.config` is the narrower ResolvedMetricsConfig, but
    // every production caller passes the loader's CollectorConfig, which
    // also carries `headers`. Default it so a test fixture built from the
    // narrow type still resolves — `collectorRequestHeaders` derives the
    // auth header from `api_key` regardless.
    const exporterConfig: ExporterConfig = {
      headers: {},
      ...(opts.config as Partial<ExporterConfig>),
    } as ExporterConfig;
    const foreign = createTracerProvider(
      exporterConfig, shardPlatform, shardAgent, { register: false },
    );
    if (!foreign) {
      // No endpoint / traces disabled: cannot happen while
      // `tracerProvider` is non-null, but losing the tree outright would
      // be worse than emitting it under the wrong label.
      await recoverDeferredTree(tracerProvider, state, opts_);
      return;
    }
    try {
      await recoverDeferredTree(foreign, state, opts_);
    } finally {
      try { await foreign.shutdown(); } catch { /* best effort */ }
    }
  };

  const toolName = input.tool_name ?? '';
  const sessionId = input.session_id ?? 'unknown';
  const cwd = input.cwd ?? null;
  const transcriptPath = input.transcript_path ?? null;
  const toolInput = input.tool_input ?? {};

  /**
   * Content limits are read from config lazily and at most once per
   * dispatch: only the two branches that actually emit content need
   * them, and most events are neither.
   */
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

  // Assigned by the crash-recovery block below, which already has the
  // state loaded — every audit entry written after it gets stamped with
  // the turn it belongs to. Left undefined when there is no active turn
  // for this session (SessionStart, a first event, a closed turn): an
  // entry with no turn has no honest association to claim.
  let auditSpanContext: { traceId: string; spanId: string } | undefined;
  const auditOptsFor = (): {
    loggerProvider: LoggerProvider | null;
    logsConfig?: CollectorLogsConfig;
    spanContext?: { traceId: string; spanId: string };
  } => ({
    loggerProvider,
    logsConfig,
    ...(auditSpanContext ? { spanContext: auditSpanContext } : {}),
  });

  try {
    // Crash recovery (lazy, any event): deferring tool-span emission to
    // end-of-turn means a killed process can now lose the WHOLE tree
    // (root + every closed tool span), not just the root as before. The
    // data survives on disk, though — so before doing anything else,
    // check whether the state we're about to build on top of is carrying
    // a tree nobody will ever flush (wrong session, or its turn already
    // closed) and flush it now, tagged incomplete. This one check covers
    // both "some other event arrives first" and "SessionStart is the
    // first thing to arrive" — SessionStart is just another event here.
    if (tracerProvider) {
      const stale = loadState(logsConfig, sessionId);
      if (hasOrphanedDeferredTree(stale, sessionId)) {
        const recovered = await recoverDeferredTree(tracerProvider, stale!);
        persist(recovered);
      } else if (stale?.turn_trace_id && stale.session_id === sessionId) {
        // Same synthetic turn span id endTurn forces onto the root, so
        // audit records land on the turn span itself, not a phantom.
        auditSpanContext = {
          traceId: stale.turn_trace_id,
          spanId: stale.turn_trace_id.slice(0, 16),
        };
      }
    }

    if (event === 'UserPromptSubmit') {
      writeAuditLog({ event, ...baseFields }, auditOptsFor());

      if (tracerProvider && input.prompt) {
        const prev = loadState(logsConfig, sessionId);
        let state = ensureTurn(prev, sessionId);
        state = recordUserPrompt(state, input.prompt);
        persist(state);
      }

    } else if (event === 'PreToolUse') {
      writeAuditLog({ event, ...baseFields }, auditOptsFor());

      const summary = toolSummary(toolName, toolInput);

      if (tracerProvider) {
        const prev = loadState(logsConfig, sessionId);
        let state = ensureTurn(prev, sessionId);
        const key = allocateSpanKey(state, input);
        // Identity only — the tool's arguments are NOT parked in state.
        // They ride out on the logs signal instead, as the `tool_use`
        // block of the chat call that issued them; `nio.tool_summary`
        // (set by deferPostToolUse) keeps the span scannable on its own.
        state = recordPreToolUse(
          state, key, toolName, summary,
          genAiToolCallIdAttributes(input.tool_use_id),
        );
        persist(state);
      }

      if (meterProvider) {
        await recordToolUse(meterProvider, toolName, event, NO_EARLY_FLUSH);
      }

    } else if (event === 'PostToolUse') {
      writeAuditLog({ event, ...baseFields }, auditOptsFor());

      if (tracerProvider) {
        const prev = loadState(logsConfig, sessionId);
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
        // MCP tool calls (`mcp__<server>__<tool>`) get their own OTEL
        // dimension so "how much traffic is MCP" and "which server is
        // slow" are answerable without string-matching tool names.
        const mcp = parseMcpToolName(toolName);
        const mcpAttrs = mcp
          ? { 'gen_ai.tool.type': 'mcp', 'nio.mcp.server': mcp.server, 'nio.mcp.tool': mcp.tool }
          : {};
        // The tool span's id was minted at PreToolUse and survives the
        // defer, so the result content can go out NOW, already
        // associated with the span the backend receives later. Read
        // before deferPostToolUse — that call removes the pending entry.
        const toolSpanId = state.pending_spans[key]?.span_id ?? '';
        // Parked, not emitted: the span can only be nested under the
        // LLM call that issued it, and that is not knowable until the
        // turn ends. endTurn emits the whole tree.
        //
        // The result payload is deliberately NOT among the attrs parked
        // here — see the tool-output emit below.
        const result = deferPostToolUse(
          state, key, cwd,
          {
            ...drained.attrs,
            ...genAiToolCallOutputAttributes({ error: err ?? null }),
            ...mcpAttrs,
          },
          err ?? null,
        );
        persist(result.state);

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

        // Arguments go out here too, against the same pre-minted tool
        // span id. This is the ONLY tool-argument record a session
        // without a ConversationSource (no transcript_path, unreadable
        // session file) ever gets: PreToolUse now parks identity only,
        // and the chat call's `tool_use` block requires a source that
        // such a session does not have. Without this, degrading the
        // STRUCTURE (turn → tool instead of turn → chat → tool) would
        // also silently degrade the CONTENT down to `nio.tool_summary`'s
        // 300 chars. See buildToolInputRecord for why the overlap with
        // the chat-call block is intentional rather than deduplicated.
        const inputText = Object.keys(toolInput).length > 0 ? JSON.stringify(toolInput) : '';
        emitToolInputContent(loggerProvider, contentLimits(), {
          input: inputText,
          spanId: toolSpanId,
          traceId: state.turn_trace_id,
          ...(input.tool_use_id ? { toolCallId: input.tool_use_id } : {}),
        });
      }

      if (meterProvider) {
        await recordToolUse(meterProvider, toolName, event, NO_EARLY_FLUSH);
      }

    } else if (event === 'TaskCreated') {
      const taskId = input.task_id ?? spanKey(input);
      const prompt = input.task_input?.prompt ?? JSON.stringify(input.task_input ?? {});
      const summary = (prompt as string).slice(0, 300);

      writeAuditLog(
        { event, ...baseFields, task_id: taskId, task_summary: summary },
        auditOptsFor(),
      );

      if (tracerProvider) {
        const prev = loadState(logsConfig, sessionId);
        let state = ensureTurn(prev, sessionId);
        state = recordPreTaskToolUse(state, taskId, summary);
        persist(state);
      }

      if (meterProvider) {
        await recordToolUse(meterProvider, 'Task', event, NO_EARLY_FLUSH);
      }

    } else if (event === 'TaskCompleted') {
      const taskId = input.task_id ?? spanKey(input);

      writeAuditLog(
        { event, ...baseFields, task_id: taskId },
        auditOptsFor(),
      );

      if (tracerProvider) {
        const prev = loadState(logsConfig, sessionId);
        const state = ensureTurn(prev, sessionId);
        const result = await recordPostTaskToolUse(
          tracerProvider, state, taskId, cwd,
        );
        persist(result.state);
      }

      if (meterProvider) {
        await recordToolUse(meterProvider, 'Task', event, NO_EARLY_FLUSH);
      }

    } else if (event === 'Stop' || event === 'SubagentStop' || event === 'SessionEnd') {
      // SessionEnd is a Hermes-driven addition: on Claude Code, Stop /
      // SubagentStop already close the turn. SessionEnd is a defensive
      // turn-close so any in-flight span gets flushed on platforms that
      // fire it as the hard session boundary.
      writeAuditLog({ event, ...baseFields }, auditOptsFor());

      // Do NOT call ensureTurn here: it mints a fresh turn when the
      // previous one was already closed (turn_trace_id === ''), which
      // endTurn would then export as an empty span. A turn boundary with
      // no active turn is a no-op, not a new turn. This matters on any
      // platform that fires more than one of Stop / SubagentStop /
      // SessionEnd for the same session — e.g. Claude Code firing both
      // Stop (closes the turn) and SessionEnd (would otherwise mint and
      // immediately export a phantom empty turn on top of it).
      const prev = loadState(logsConfig, sessionId);
      const hasActiveTurn = Boolean(prev?.turn_trace_id);

      if (hasActiveTurn && tracerProvider) {
        const calls = await resolveTurnCalls(
          platform,
          { transcriptPath, ...(opts.conversationInput ?? {}) },
          prev!.turn_start_ms,
        );
        // No provider (unmonitored session, logs disabled) → no sink →
        // endTurn emits the tree and nothing else. This is where the
        // /nio-monitor master switch gates conversation content.
        const contentSink = loggerProvider
          ? createContentSink(loggerProvider, contentLimits())
          : undefined;
        const next = await endTurn(
          tracerProvider, prev!, cwd, transcriptPath, calls, contentSink,
        );
        if (next) persist(next);
      }

      if (hasActiveTurn && meterProvider) {
        await recordTurn(meterProvider, NO_EARLY_FLUSH);
      }

      if (event === 'SessionEnd') {
        // Session span goes out last, after the turn it might still be
        // closing has had its chance to save — reload rather than reuse
        // `prev`/`next` so this sees whichever of them actually landed.
        if (tracerProvider) {
          const sessionState = loadState(logsConfig, sessionId) ?? prev;
          if (sessionState?.session_trace_id && sessionState?.session_span_id) {
            await emitSessionSpan(tracerProvider, sessionState);
          }
        }
        // The session is over, so drop its shard instead of writing the
        // cleared session-span fields back. Sharding means one file per
        // session that is never reused, so something has to collect
        // them; this is the clean-exit half. The other half is
        // `takeAbandonedShards`, run from SessionStart, which salvages the
        // parked tree of a session whose host died before SessionEnd could
        // fire and GCs its shard a week later. Removing the file subsumes what clearing
        // session_trace_id / session_span_id in place used to do — stop
        // a second SessionEnd re-emitting the session span — because the
        // reload above then returns null, and `prev` (loaded earlier in
        // this same dispatch) has already had its turn closed.
        discardState(logsConfig, sessionId);
        forgetSession(sessionId, logsConfig);
      }

    } else if (event === 'SessionStart') {
      writeAuditLog({ event, ...baseFields }, auditOptsFor());

      if (tracerProvider) {
        // Sweep the shards left by sessions whose host died before
        // SessionEnd. Pre-sharding this happened for free — a new session
        // simply loaded the dead one's state out of the one shared file —
        // and COLLECTOR-SIGNALS.md documents it ("the parked tree is
        // flushed by the next event that finds it, or by the next
        // SessionStart"). Per-session files mean it has to be done on
        // purpose. Each tree is emitted on its OWN session's trace id,
        // tagged nio.turn.incomplete, AND under its own platform identity
        // (see recoverShard), so recovery never re-attributes a dead
        // session's spans to this one. SessionStart only — see
        // takeAbandonedShards for why not on every event.
        for (const shard of takeAbandonedShards(logsConfig, sessionId)) {
          await recoverShard(shard.state);
        }

        const prev = loadState(logsConfig, sessionId);
        const state = startSessionTrace(prev, sessionId);
        persist(state);
      }

    } else if (isKnownHookEvent(event)) {
      // Future hook events that are typed but have no specific handling
      // yet — still write an audit entry so they're observable.
      writeAuditLog(
        { event: event as HookEventName, ...baseFields },
        auditOptsFor(),
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
