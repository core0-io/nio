// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Traces Collector
 *
 * Pure functions that compute span lifecycles and emit OTEL spans. The
 * cross-process turn/span state is owned by `traces-state-store.ts`;
 * collector-core orchestrates load → call here → save around every hook
 * event. This module performs no filesystem IO of its own — only
 * network-bound span export through the OTEL provider.
 *
 * Trace hierarchy (OTel GenAI semantic conventions):
 *
 *   Trace: "invoke_agent UserPromptSubmit" — one trace per conversation turn
 *     └─ Span: "chat <model>" — one span per LLM call
 *          └─ Span: "execute_tool <name>" — the tools that call issued
 *     └─ Span: "execute_tool <name>" — tools that could not be attributed
 *     └─ Span: "task:execute" — one span per task lifecycle
 *
 * Why tool spans are deferred
 * ---------------------------
 * A tool span can only be nested under the LLM call that issued it, and
 * that attribution is unknown at PostToolUse time — it comes from the
 * conversation source once the turn is over. So finished tool spans park
 * in `state.deferred_spans` (`deferPostToolUse`) and the whole tree is
 * emitted together in `endTurn`.
 *
 * The one exception is the guard's block path: `recordPostToolUse` keeps
 * the old immediate-emit behaviour. A denied action is a security event,
 * and making it wait tens of seconds for the turn to end before it
 * becomes visible is not an acceptable trade for a nicer tree.
 */

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { trace, TraceFlags, ROOT_CONTEXT, SpanStatusCode, type Link } from '@opentelemetry/api';
import { NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { OTLPTraceExporter as OTLPTraceExporterHttp } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPTraceExporter as OTLPTraceExporterGrpc } from '@opentelemetry/exporter-trace-otlp-grpc';
import { Metadata } from '@grpc/grpc-js';
import { collectorRequestHeaders, type CollectorConfig } from './config-loader.js';
import { instrumentExporter } from './exporter-diagnostics.js';
import type {
  CollectorState, PendingToolSpan, PendingTaskSpan, DeferredSpan,
} from './traces-state-store.js';
import type { ChatCall } from './conversation/types.js';
import { buildSpanTree, chatSpanAttributes, chatSpanName } from './chat-span.js';

// Re-export so collector-core / tests can pull state types from a single place.
export type { CollectorState, PendingToolSpan, PendingTaskSpan, DeferredSpan };

// ---------------------------------------------------------------------------
// Redaction + truncation for span attribute payloads
// ---------------------------------------------------------------------------

const MAX_ATTR_BYTES = 2048;
const SECRET_KEY_RE = /(api[_-]?key|secret|token|password|passwd|authorization|bearer|private[_-]?key|mnemonic|seed|credential)/i;

export function redactAndTruncate(value: unknown, maxBytes: number = MAX_ATTR_BYTES): string {
  const redact = (v: unknown): unknown => {
    if (v === null || v === undefined) return v;
    if (typeof v === 'string') return v;
    if (typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(redact);
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? '[REDACTED]' : redact(val);
    }
    return out;
  };
  let s: string;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(redact(value));
  } catch {
    s = String(value);
  }
  if (s && s.length > maxBytes) s = s.slice(0, maxBytes) + '…[truncated]';
  return s ?? '';
}

// ---------------------------------------------------------------------------
// OTel GenAI semantic-convention attribute helpers
// ---------------------------------------------------------------------------

export const GEN_AI_PROVIDER_NAME = 'nio';

export function genAiInvokeAgentAttributes(
  sessionId: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    'gen_ai.operation.name': 'invoke_agent',
    'gen_ai.provider.name': GEN_AI_PROVIDER_NAME,
    'gen_ai.conversation.id': sessionId,
    'session.id': sessionId,
    ...extra,
  };
}

export function genAiToolAttributes(
  toolName: string,
  toolCallId?: string,
  extra?: Record<string, unknown>,
  toolType?: string,
): Record<string, unknown> {
  return {
    'gen_ai.operation.name': 'execute_tool',
    'gen_ai.tool.name': toolName || 'unknown',
    ...(toolType ? { 'gen_ai.tool.type': toolType } : {}),
    ...(toolCallId ? { 'gen_ai.tool.call.id': toolCallId } : {}),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Tool / turn attribute builders (single source of truth)
//
// Every literal `gen_ai.*` / `nio.*` attribute key string lives inside
// one of these helpers. Consumers (collector-core, openclaw-plugin) call
// the helpers and never see the keys directly — schema changes happen in
// one place.
// ---------------------------------------------------------------------------

/** Tool-call input attrs (PreToolUse). Used by both deferred (CC/Hermes) and eager (OpenClaw) flows. */
export function genAiToolCallInputAttributes(
  toolInput: unknown,
  toolCallId?: string,
): Record<string, unknown> {
  return {
    'gen_ai.tool.call.arguments': redactAndTruncate(toolInput),
    ...(toolCallId ? { 'gen_ai.tool.call.id': toolCallId } : {}),
  };
}

/** Tool-call output attrs (PostToolUse). All fields optional; missing fields produce no key. */
export function genAiToolCallOutputAttributes(opts: {
  result?: unknown;
  error?: string | null;
  durationMs?: number;
}): Record<string, unknown> {
  return {
    ...(opts.result !== undefined ? { 'gen_ai.tool.call.result': redactAndTruncate(opts.result) } : {}),
    ...(opts.error ? { 'nio.tool.error': redactAndTruncate(opts.error) } : {}),
    ...(typeof opts.durationMs === 'number' ? { 'nio.tool.duration_ms': opts.durationMs } : {}),
  };
}

/** Nio guard-decision attrs (vendor extension). Decision in {allow, deny, confirm_allowed, confirm_denied}. */
export function nioGuardAttributes(
  decision: string,
  riskLevel: string,
  riskScore: number,
  riskTags?: string[],
  phaseStopped?: number,
  topFindingRule?: string,
): Record<string, unknown> {
  return {
    'nio.guard.decision': decision,
    'nio.guard.risk_level': riskLevel,
    'nio.guard.risk_score': riskScore,
    ...(riskTags?.length ? { 'nio.guard.risk_tags': riskTags.join(',') } : {}),
    ...(typeof phaseStopped === 'number' ? { 'nio.guard.phase_stopped': phaseStopped } : {}),
    ...(topFindingRule ? { 'nio.guard.top_finding_rule': topFindingRule } : {}),
  };
}

/** Token usage attrs (turn span). Absolute values; missing fields default to 0. */
export function genAiUsageAttributes(usage: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}): Record<string, unknown> {
  return {
    'gen_ai.usage.input_tokens': usage.input ?? 0,
    'gen_ai.usage.output_tokens': usage.output ?? 0,
    'gen_ai.usage.cache_creation.input_tokens': usage.cacheWrite ?? 0,
    'gen_ai.usage.cache_read.input_tokens': usage.cacheRead ?? 0,
  };
}

/** OpenClaw run-id extension. Single-key wrapper so the literal lives here, not in openclaw-plugin. */
export function nioToolRunIdAttribute(runId: string): Record<string, unknown> {
  return { 'nio.tool.run_id': runId };
}

// ---------------------------------------------------------------------------
// Turn-state operation helpers (state-in / state-out)
// ---------------------------------------------------------------------------

/** Record user prompt onto turn state (UserPromptSubmit / before_agent_reply). */
export function recordUserPrompt(state: CollectorState, prompt: string): CollectorState {
  return setTurnAttributes(state, { 'nio.turn.user_prompt': redactAndTruncate(prompt) });
}

/** Record assistant reply onto turn state (currently OpenClaw llm_output). */
export function recordAssistantReply(state: CollectorState, reply: string): CollectorState {
  return setTurnAttributes(state, { 'nio.turn.assistant_reply': redactAndTruncate(reply) });
}

/** Add per-event LLM usage delta to state.turn_attributes. */
export function accumulateGenAiUsage(
  state: CollectorState,
  delta: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
): CollectorState {
  const a = state.turn_attributes ?? {};
  return setTurnAttributes(state, {
    'gen_ai.usage.input_tokens':
      ((a['gen_ai.usage.input_tokens'] as number) ?? 0) + (delta.input ?? 0),
    'gen_ai.usage.output_tokens':
      ((a['gen_ai.usage.output_tokens'] as number) ?? 0) + (delta.output ?? 0),
    'gen_ai.usage.cache_creation.input_tokens':
      ((a['gen_ai.usage.cache_creation.input_tokens'] as number) ?? 0) + (delta.cacheWrite ?? 0),
    'gen_ai.usage.cache_read.input_tokens':
      ((a['gen_ai.usage.cache_read.input_tokens'] as number) ?? 0) + (delta.cacheRead ?? 0),
  });
}

/** Internal: cache hit rate = cache_read / (input + cache_creation + cache_read). */
function computeCacheHitRate(state: CollectorState): number {
  const a = state.turn_attributes ?? {};
  const input = (a['gen_ai.usage.input_tokens'] as number) ?? 0;
  const cacheRead = (a['gen_ai.usage.cache_read.input_tokens'] as number) ?? 0;
  const cacheWrite = (a['gen_ai.usage.cache_creation.input_tokens'] as number) ?? 0;
  const total = input + cacheRead + cacheWrite;
  return total > 0 ? Math.round((cacheRead / total) * 1000) / 1000 : 0;
}

/** Compute and write cache hit rate onto turn state (called at endTurn). */
export function recordCacheHitRate(state: CollectorState): CollectorState {
  return setTurnAttributes(state, { 'nio.turn.cache_hit_rate': computeCacheHitRate(state) });
}

// ---------------------------------------------------------------------------
// Trace ID derivation
// ---------------------------------------------------------------------------

/**
 * Generate a fresh OTel trace id (16 bytes / 32 hex chars).
 *
 * Earlier versions derived this from `MD5(session_id + ":" + turn_number)`
 * so PRE and POST hook processes could agree on the id without sharing
 * memory. But that's deterministic — any (session_id, turn_number)
 * combination produces the same trace id forever. Two failure modes:
 *
 *   1. Cross-day collision: Hermes session `agent:main:...:539162220`
 *      runs for hours and at turn N today derives the same id as turn N
 *      yesterday — span IDs from yesterday's emit appear stitched
 *      into today's trace tree on the backend.
 *   2. Session-promotion turn_number reset: when ensureTurn promotes
 *      a sentinel-session state to a real session, turn_number resets
 *      to 1. Every promoted turn re-derives MD5(real:1), so every
 *      turn within one Hermes session collapses onto the same trace.
 *
 * The pre/post bridge is now state-file-based — both processes
 * `loadState()` and read the persisted `turn_trace_id` directly.
 * That means we no longer need a deterministic derivation; a random
 * id stored in state works for everyone.
 */
function freshTraceId(): string {
  return randomBytes(16).toString('hex');
}

function randomSpanId(): string {
  return randomBytes(8).toString('hex');
}

// ---------------------------------------------------------------------------
// OTEL provider factory
// ---------------------------------------------------------------------------

/**
 * Compute the nio resource attributes: service.name, nio.platform, and
 * gen_ai.agent.name (only when agentName is a non-empty string).
 * Pure builder for the Resource contract — no OTel provider creation.
 */
export function nioResourceAttributes(
  platform: string,
  agentName?: string,
): Record<string, string> {
  return {
    [ATTR_SERVICE_NAME]: `nio-${platform}`,
    'nio.platform': platform,
    ...(agentName && agentName.length > 0 ? { 'gen_ai.agent.name': agentName } : {}),
  };
}

/**
 * Build the shared resource for every OTel provider nio constructs.
 * Three attributes promoted to resource-level so they surface as
 * top-level columns / filter chips in backends:
 *   - `service.name`        = `nio-<platform>`   (splits hermes / claude-code / codex / openclaw into separate services)
 *   - `nio.platform`        = `<platform>`      (raw value for users who want to filter without parsing service.name)
 *   - `gen_ai.agent.name`   = `<agentName>`    (when configured) — auto-attached to every span / log / metric record
 *
 * These three are emitted ONLY on the Resource — never duplicated onto
 * individual spans / log records / metric labels. Per-event builders rely
 * on the Resource for platform + agent identity.
 */
export function buildNioResource(platform: string, agentName?: string) {
  return resourceFromAttributes(nioResourceAttributes(platform, agentName));
}

export function createTracerProvider(
  config: CollectorConfig,
  platform: string,
  agentName?: string,
): NodeTracerProvider | null {
  if (!config.endpoint) return null;
  if (!config.traces_enabled) return null;

  const headers = collectorRequestHeaders(config);

  const base = config.endpoint.replace(/\/$/, '');
  const tracesUrl = config.protocol === 'grpc' ? base : `${base}/v1/traces`;

  let exporter;
  if (config.protocol === 'grpc') {
    const grpcMetadata = new Metadata();
    for (const [k, v] of Object.entries(headers)) {
      grpcMetadata.set(k, v);
    }
    exporter = new OTLPTraceExporterGrpc({
      url: tracesUrl,
      metadata: grpcMetadata,
      timeoutMillis: config.timeout,
    });
  } else {
    exporter = new OTLPTraceExporterHttp({
      url: tracesUrl,
      headers,
      timeoutMillis: config.timeout,
    });
  }
  instrumentExporter(exporter, 'traces', config.endpoint);

  const provider = new NodeTracerProvider({
    resource: buildNioResource(platform, agentName),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
  return provider;
}

// ---------------------------------------------------------------------------
// State transitions (pure — caller persists via collector-state)
// ---------------------------------------------------------------------------

/**
 * Merge attributes onto the current turn's state. Returns a new state
 * object; the input is not mutated.
 */
export function setTurnAttributes(
  state: CollectorState,
  attributes: Record<string, unknown>,
): CollectorState {
  return {
    ...state,
    turn_attributes: { ...(state.turn_attributes ?? {}), ...attributes },
  };
}

/**
 * Returns the existing turn state if the session matches and a turn is
 * active; otherwise starts a new turn. Pure: caller is responsible for
 * persisting the returned state.
 */
export function ensureTurn(
  prev: CollectorState | null,
  sessionId: string,
): CollectorState {
  // Hermes asymmetry: `pre_tool_call` shell-hook payload sometimes
  // arrives with `session_id=""` while the matching `post_tool_call`
  // carries the real session id. If we accept the sentinel "" at face
  // value we'd reset turn_number, derive a new turn_trace_id, and
  // wipe pending_spans — three different ways to corrupt the
  // pre/post bridge. Instead, when a sentinel ("" or "unknown")
  // arrives but we already know the real session, ignore the
  // sentinel and continue the existing turn.
  const isSentinelIn = sessionId === '' || sessionId === 'unknown';
  if (
    isSentinelIn
    && prev?.session_id
    && prev.session_id !== ''
    && prev.session_id !== 'unknown'
  ) {
    sessionId = prev.session_id;
  }

  if (prev && prev.session_id === sessionId && prev.turn_trace_id) {
    return prev;
  }

  // Migration: when the prev state was on a sentinel session and a
  // real one is arriving, carry the pending tool-call state into the
  // new turn instead of resetting it. Covers the case where the very
  // first event of a turn was a sentinel pre, followed by a real
  // post (state file initially empty so the sentinel-passthrough
  // above couldn't kick in).
  // pending_task_spans + turn_attributes are NOT migrated — they're
  // genuinely turn-scoped and shouldn't outlive a session change.
  const prevWasSentinel = prev && (prev.session_id === '' || prev.session_id === 'unknown');
  // deferred_spans rides along for the same reason pending_spans does:
  // a tool that closed while the session was still a sentinel has its
  // finished span parked here, and dropping it on promotion would lose
  // the span outright (nothing emits it — the emit happens at endTurn).
  const carryPending = prevWasSentinel
    ? {
        pending_spans: prev.pending_spans ?? {},
        pending_guard_attrs: prev.pending_guard_attrs ?? {},
        deferred_spans: prev.deferred_spans ?? [],
      }
    : { pending_spans: {}, pending_guard_attrs: {}, deferred_spans: [] };

  // Session identity (session_trace_id/session_span_id/session_start_ms)
  // is minted once at SessionStart and lives for the whole session, not
  // just one turn — but this function's "start new turn" branch below
  // builds its return value from scratch, so without this it would be
  // silently dropped on every single turn (including the very first:
  // SessionStart writes it onto a state whose turn_trace_id is still
  // '', so turn 1 always takes this branch). Only carried forward when
  // `prev` genuinely IS this session's state (same id, or the sentinel-
  // promotion case where it's the same session under its prior alias) —
  // a real cross-session mismatch must NOT leak one session's trace
  // link into another's turns.
  const carrySessionTrace = prev && (prev.session_id === sessionId || prevWasSentinel)
    ? {
        ...(prev.session_trace_id !== undefined ? { session_trace_id: prev.session_trace_id } : {}),
        ...(prev.session_span_id !== undefined ? { session_span_id: prev.session_span_id } : {}),
        ...(prev.session_start_ms !== undefined ? { session_start_ms: prev.session_start_ms } : {}),
      }
    : {};

  const turnNumber = (prev?.session_id === sessionId ? prev.turn_number : 0) + 1;
  return {
    session_id: sessionId,
    turn_number: turnNumber,
    // Random per-turn id stored in state; PRE/POST processes share it
    // via the on-disk state file rather than re-deriving from
    // (session_id, turn_number). See freshTraceId() for the why.
    turn_trace_id: freshTraceId(),
    turn_start_ms: Date.now(),
    ...carryPending,
    pending_task_spans: {},
    turn_attributes: {},
    ...carrySessionTrace,
  };
}

/**
 * Mint session-level trace/span ids at `SessionStart`. Pure — caller
 * persists the returned state.
 *
 * The session is deliberately NOT a span tree that wraps every turn (see
 * the module's session-link design note near `endTurn`) — just an id
 * pair minted here, held in state, and later emitted as its own root
 * span by `emitSessionSpan` at `SessionEnd`. Every turn root links to it.
 *
 * When `prev` belongs to a DIFFERENT session (or there is no `prev`),
 * this starts from a clean turn-state skeleton rather than layering
 * fresh session ids onto stale turn/pending data — otherwise a crashed
 * session's leftover `turn_trace_id` could outlive it and get mistaken
 * for an active turn under the new session id by `ensureTurn`'s no-op
 * check (`prev.session_id === sessionId && prev.turn_trace_id`).
 */
export function startSessionTrace(
  prev: CollectorState | null,
  sessionId: string,
): CollectorState {
  const sessionChanged = prev !== null && prev.session_id !== sessionId;
  const base: CollectorState = !prev || sessionChanged
    ? {
        session_id: sessionId,
        turn_number: 0,
        turn_trace_id: '',
        turn_start_ms: 0,
        pending_spans: {},
        pending_task_spans: {},
        pending_guard_attrs: {},
        turn_attributes: {},
        deferred_spans: [],
      }
    : prev;

  return {
    ...base,
    session_trace_id: freshTraceId(),
    session_span_id: randomSpanId(),
    session_start_ms: Date.now(),
  };
}

/** Records a pending tool span. Returns a new state object.
 *
 * `startMs` overrides the default `Date.now()` — callers that emit a
 * complete span synchronously (guard deny path) pass the real eval-start
 * time so the span's wall-clock matches the guard window, not the sync
 * emit moment.
 */
export function recordPreToolUse(
  state: CollectorState,
  spanKey: string,
  toolName: string,
  toolSummary: string,
  attributes?: Record<string, unknown>,
  startMs?: number,
): CollectorState {
  const next: PendingToolSpan = {
    tool_name: toolName,
    tool_summary: toolSummary,
    start_ms: startMs ?? Date.now(),
    span_id: randomSpanId(),
    ...(attributes ? { attributes } : {}),
  };
  return {
    ...state,
    pending_spans: { ...state.pending_spans, [spanKey]: next },
  };
}

/**
 * Park guard-decision attrs against `spanKey` so a later
 * `recordPostToolUse` (possibly in a separate process) can merge them
 * into the closing tool span. Written by the guard-hook process on
 * every decision (allow / ask / deny); drained by the collector-hook
 * PostToolUse handler via `takePendingGuardAttrs`.
 */
export function setPendingGuardAttrs(
  state: CollectorState,
  spanKey: string,
  attrs: Record<string, unknown>,
): CollectorState {
  return {
    ...state,
    pending_guard_attrs: { ...(state.pending_guard_attrs ?? {}), [spanKey]: attrs },
  };
}

/**
 * Drain the guard attrs stashed for `spanKey` (if any). Returns the
 * attrs map and a state object with the entry removed. When no entry
 * exists, returns `{}` for `attrs` and `state` unchanged.
 */
export function takePendingGuardAttrs(
  state: CollectorState,
  spanKey: string,
): { state: CollectorState; attrs: Record<string, unknown> } {
  const map = state.pending_guard_attrs ?? {};
  const attrs = map[spanKey];
  if (!attrs) return { state, attrs: {} };
  const { [spanKey]: _removed, ...remaining } = map;
  void _removed;
  return {
    state: { ...state, pending_guard_attrs: remaining },
    attrs,
  };
}

/** Records a pending task span. Returns a new state object. */
export function recordPreTaskToolUse(
  state: CollectorState,
  taskId: string,
  taskSummary: string,
): CollectorState {
  const next: PendingTaskSpan = {
    task_summary: taskSummary,
    start_ms: Date.now(),
    span_id: randomSpanId(),
  };
  return {
    ...state,
    pending_task_spans: { ...(state.pending_task_spans ?? {}), [taskId]: next },
  };
}

// ---------------------------------------------------------------------------
// Span lifecycle (close + emit OTEL span)
// ---------------------------------------------------------------------------

export interface PostSpanResult {
  state: CollectorState;
  durationMs: number | null;
}

/**
 * Closes the pending tool span and parks it in `deferred_spans` for the
 * end-of-turn flush. Returns the next state (with the pending entry
 * removed, the deferred entry appended) and the duration in ms. If no
 * matching pre-span existed, returns durationMs: null and the state
 * unchanged.
 *
 * Nothing is emitted here — see the module doc for why attribution
 * forces the wait.
 */
export function deferPostToolUse(
  state: CollectorState,
  spanKey: string,
  cwd: string | null,
  postAttributes?: Record<string, unknown>,
  error?: string | null,
): PostSpanResult {
  const pending = state.pending_spans[spanKey];
  if (!pending) return { state, durationMs: null };

  const endMs = Date.now();
  const startMs = pending.start_ms;

  const toolCallId =
    (pending.attributes?.['gen_ai.tool.call.id'] as string | undefined) ??
    undefined;

  const deferred: DeferredSpan = {
    kind: 'tool',
    name: `execute_tool ${pending.tool_name || 'unknown'}`,
    span_id: pending.span_id,
    start_ms: startMs,
    end_ms: endMs,
    attributes: {
      ...genAiToolAttributes(pending.tool_name, toolCallId),
      'nio.tool_summary': pending.tool_summary,
      'nio.turn_number': state.turn_number,
      ...(cwd ? { 'nio.cwd': cwd } : {}),
      ...(pending.attributes ?? {}),
      ...(postAttributes ?? {}),
    },
    ...(error ? { error } : {}),
    ...(toolCallId ? { tool_use_id: toolCallId } : {}),
  };

  const { [spanKey]: _removed, ...remaining } = state.pending_spans;
  void _removed;
  return {
    state: {
      ...state,
      pending_spans: remaining,
      deferred_spans: [...(state.deferred_spans ?? []), deferred],
    },
    durationMs: endMs - startMs,
  };
}

/**
 * Emit one finished span under `parentSpanId`.
 *
 * The span's own id is forced to the id minted at PreToolUse so content
 * log records — which were emitted while the tool was still running and
 * carry that id — join back to the span the backend receives.
 */
function emitDeferredSpan(
  provider: NodeTracerProvider,
  traceId: string,
  parentSpanId: string,
  deferred: DeferredSpan,
): void {
  const parentCtx = trace.setSpanContext(ROOT_CONTEXT, {
    traceId,
    spanId: parentSpanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });

  // Use provider.getTracer instead of trace.getTracer(global) so that
  // bundled hook scripts emit spans correctly. Bun's hook-cli bundle
  // can resolve @opentelemetry/api separately from
  // @opentelemetry/sdk-trace-node, leaving the global registry split
  // between two API instances — provider.register() writes to one,
  // trace.getTracer() reads from the other and gets a no-op tracer.
  // Going through the provider directly side-steps the global path.
  const tracer = provider.getTracer('nio-collector', '1.0.0');
  const span = tracer.startSpan(
    deferred.name,
    {
      startTime: deferred.start_ms,
      attributes: deferred.attributes as Record<string, string | number | boolean>,
    },
    parentCtx,
  );
  if (deferred.span_id) {
    (span.spanContext() as { spanId: string }).spanId = deferred.span_id;
  }
  if (deferred.error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: deferred.error });
    span.recordException(deferred.error);
  }
  span.end(deferred.end_ms);
}

/**
 * Close a pending tool span and emit it immediately, as a direct child
 * of the turn.
 *
 * Thin wrapper over `deferPostToolUse` + a single-span flush, kept for
 * the callers that cannot wait for the end of turn:
 *
 *  - the guard's block path (guard-hook / hook-cli / openclaw-plugin):
 *    PostToolUse will never fire for a denied call, and a security event
 *    that only surfaces once the turn closes is not observable when it
 *    matters.
 *  - OpenClaw's eager per-tool export and its end-of-session sweep of
 *    leftover pending spans.
 *
 * Behaviourally identical to the pre-deferral implementation: the span
 * goes out now, `deferred_spans` is left exactly as it was found.
 */
export async function recordPostToolUse(
  provider: NodeTracerProvider,
  state: CollectorState,
  spanKey: string,
  cwd: string | null,
  postAttributes?: Record<string, unknown>,
  error?: string | null,
): Promise<PostSpanResult> {
  const result = deferPostToolUse(state, spanKey, cwd, postAttributes, error);
  if (result.durationMs === null) return result;

  const queued = result.state.deferred_spans ?? [];
  const deferred = queued[queued.length - 1]!;
  const traceId = result.state.turn_trace_id;
  // Synthetic parent representing the turn — the same id endTurn forces
  // onto the turn's own span.
  emitDeferredSpan(provider, traceId, traceId.slice(0, 16), deferred);

  await provider.forceFlush();

  return {
    state: { ...result.state, deferred_spans: queued.slice(0, -1) },
    durationMs: result.durationMs,
  };
}

/**
 * Closes the pending task span and emits it as a child of the current
 * turn. Returns the next state (with the pending task removed) and the
 * duration. Missing pending task → durationMs: null, state unchanged.
 */
export async function recordPostTaskToolUse(
  provider: NodeTracerProvider,
  state: CollectorState,
  taskId: string,
  cwd: string | null,
): Promise<PostSpanResult> {
  const pending = state.pending_task_spans?.[taskId];
  if (!pending) return { state, durationMs: null };

  const endMs = Date.now();
  const startMs = pending.start_ms;

  const traceId = state.turn_trace_id;
  const parentCtx = trace.setSpanContext(ROOT_CONTEXT, {
    traceId,
    spanId: traceId.slice(0, 16),
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });

  // Use provider.getTracer instead of trace.getTracer(global) so that
  // bundled hook scripts emit spans correctly. Bun's hook-cli bundle
  // can resolve @opentelemetry/api separately from
  // @opentelemetry/sdk-trace-node, leaving the global registry split
  // between two API instances — provider.register() writes to one,
  // trace.getTracer() reads from the other and gets a no-op tracer.
  // Going through the provider directly side-steps the global path.
  const tracer = provider.getTracer('nio-collector', '1.0.0');
  const span = tracer.startSpan(
    'task:execute',
    {
      startTime: startMs,
      attributes: {
        'nio.task_id': taskId,
        'nio.task_summary': pending.task_summary,
        'nio.session_id': state.session_id,
        'nio.turn_number': state.turn_number,
        ...(cwd ? { 'nio.cwd': cwd } : {}),
      },
    },
    parentCtx,
  );
  span.end(endMs);

  await provider.forceFlush();

  const { [taskId]: _removed, ...remainingTasks } = state.pending_task_spans;
  void _removed;
  return {
    state: { ...state, pending_task_spans: remainingTasks },
    durationMs: endMs - startMs,
  };
}

// ---------------------------------------------------------------------------
// Transcript token usage
// ---------------------------------------------------------------------------

export interface TurnUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cache_hit_rate: number;
}

/**
 * Parse the transcript JSONL and sum token usage for the current turn.
 *
 * Reads the file from the end backwards (last 256 KB) to limit I/O.
 * Only extracts `message.usage` numeric fields — never touches message content.
 */
export function parseTranscriptUsage(
  transcriptPath: string,
  turnStartMs: number,
): TurnUsage | null {
  try {
    const content = readFileSync(transcriptPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreation = 0;
    let cacheRead = 0;

    for (const line of lines) {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      // Only look at assistant messages with usage
      if (entry['type'] !== 'assistant') continue;
      const message = entry['message'] as Record<string, unknown> | undefined;
      if (!message) continue;

      // Skip entries before this turn started
      const timestamp = entry['timestamp'] as string | undefined;
      if (timestamp && new Date(timestamp).getTime() < turnStartMs) continue;

      const usage = message['usage'] as Record<string, unknown> | undefined;
      if (!usage) continue;

      inputTokens += (usage['input_tokens'] as number) || 0;
      outputTokens += (usage['output_tokens'] as number) || 0;
      cacheCreation += (usage['cache_creation_input_tokens'] as number) || 0;
      cacheRead += (usage['cache_read_input_tokens'] as number) || 0;
    }

    if (inputTokens === 0 && outputTokens === 0) return null;

    const totalInput = inputTokens + cacheCreation + cacheRead;
    const cacheHitRate = totalInput > 0 ? cacheRead / totalInput : 0;

    return {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: cacheCreation,
      cache_read_input_tokens: cacheRead,
      cache_hit_rate: Math.round(cacheHitRate * 1000) / 1000,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Turn end
// ---------------------------------------------------------------------------

/**
 * Emits the turn's whole span tree — chat spans, the tool spans nested
 * under them, the tool spans that could not be attributed, and finally
 * the turn root — then returns a fresh state with the turn marker
 * cleared so the next user message starts a new turn. Returns null if
 * the input state has no active turn — caller should persist nothing in
 * that case (treat as a no-op for idempotency across concurrent
 * Stop/SubagentStop hooks).
 *
 * `calls` are the LLM calls the conversation source reconstructed for
 * this turn. Omitted or empty (unrecognised platform, unreadable session
 * file, a streaming source with nothing gathered) degrades cleanly to
 * the pre-chat-layer shape: every deferred span hangs off the turn.
 */
export async function endTurn(
  provider: NodeTracerProvider,
  state: CollectorState,
  cwd: string | null,
  transcriptPath?: string | null,
  calls?: ChatCall[],
): Promise<CollectorState | null> {
  if (!state.turn_trace_id) return null;

  // If usage came via a transcript file (CC pattern), accumulate it onto
  // turn_attributes so the spread below picks it up — same code path as
  // OpenClaw, which feeds turn_attributes incrementally via llm_output.
  if (transcriptPath) {
    const usage = parseTranscriptUsage(transcriptPath, state.turn_start_ms);
    if (usage) {
      state = accumulateGenAiUsage(state, {
        input: usage.input_tokens,
        output: usage.output_tokens,
        cacheRead: usage.cache_read_input_tokens,
        cacheWrite: usage.cache_creation_input_tokens,
      });
      state = recordCacheHitRate(state);
    }
  }

  const endMs = Date.now();
  const traceId = state.turn_trace_id;
  const turnSpanId = traceId.slice(0, 16);

  // Build a remote parent context with the turn's trace ID so the root span
  // sits at the top of the trace.
  const rootCtx = trace.setSpanContext(ROOT_CONTEXT, {
    traceId,
    spanId: turnSpanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });

  // Chat spans first, then the tools beneath each of them, then the
  // tools nobody could claim, then the turn root. Order matters only for
  // readability of the exporter's output — every parent link is by id,
  // not by emission order.
  const tree = buildSpanTree(calls ?? [], state.deferred_spans ?? []);
  for (const node of tree.chats) {
    emitChatSpan(provider, traceId, turnSpanId, node.span_id, node.call);
    for (const tool of node.tools) {
      emitDeferredSpan(provider, traceId, node.span_id, tool);
    }
  }
  for (const orphan of tree.orphans) {
    emitDeferredSpan(provider, traceId, turnSpanId, orphan);
  }

  // Use provider.getTracer instead of trace.getTracer(global) so that
  // bundled hook scripts emit spans correctly. Bun's hook-cli bundle
  // can resolve @opentelemetry/api separately from
  // @opentelemetry/sdk-trace-node, leaving the global registry split
  // between two API instances — provider.register() writes to one,
  // trace.getTracer() reads from the other and gets a no-op tracer.
  // Going through the provider directly side-steps the global path.
  const tracer = provider.getTracer('nio-collector', '1.0.0');
  // Link the turn root back to the session span, when a session trace
  // was minted for it (SessionStart ran). Missing session fields — a
  // platform that never fires SessionStart, or a state file predating
  // this feature — degrade to no link rather than an error; the turn
  // still exports on its own.
  const sessionLinks: Link[] = state.session_trace_id && state.session_span_id
    ? [{
        context: {
          traceId: state.session_trace_id,
          spanId: state.session_span_id,
          traceFlags: TraceFlags.SAMPLED,
        },
      }]
    : [];
  const span = tracer.startSpan(
    'invoke_agent UserPromptSubmit',
    {
      startTime: state.turn_start_ms,
      attributes: {
        ...genAiInvokeAgentAttributes(state.session_id),
        'nio.turn_number': state.turn_number,
        ...(cwd ? { 'nio.cwd': cwd } : {}),
        ...(state.turn_attributes ?? {}),
      } as Record<string, string | number | boolean>,
      ...(sessionLinks.length > 0 ? { links: sessionLinks } : {}),
    },
    rootCtx,
  );

  // Force the turn span's own spanId to match the synthetic parent spanId that
  // child tool/task spans use (traceId.slice(0,16)). This makes the turn span
  // the actual parent of its children in the trace tree instead of a sibling
  // under a missing span. Also clear parentSpanId so the turn is a true root.
  const sc = span.spanContext() as { traceId: string; spanId: string };
  sc.spanId = traceId.slice(0, 16);
  // Newer OTEL SDKs expose the parent reference as `parentSpanContext`, older
  // ones as `parentSpanId`. Clear both so the turn span becomes a true root.
  (span as unknown as { parentSpanContext?: unknown }).parentSpanContext = undefined;
  (span as unknown as { parentSpanId?: string }).parentSpanId = undefined;
  span.end(endMs);

  await provider.forceFlush();

  return {
    session_id: state.session_id,
    turn_number: state.turn_number,
    turn_trace_id: '',          // cleared — re-derived on next PreToolUse
    turn_start_ms: 0,
    pending_spans: {},
    pending_task_spans: {},
    pending_guard_attrs: {},
    turn_attributes: {},
    deferred_spans: [],
    // Session identity outlives the turn — carried forward so the NEXT
    // turn's root can still link back to it. Without this, endTurn would
    // silently sever every turn after the first from its session.
    ...(state.session_trace_id !== undefined ? { session_trace_id: state.session_trace_id } : {}),
    ...(state.session_span_id !== undefined ? { session_span_id: state.session_span_id } : {}),
    ...(state.session_start_ms !== undefined ? { session_start_ms: state.session_start_ms } : {}),
  };
}

/**
 * Emit one `chat` span under the turn.
 *
 * Its span id is the one `buildSpanTree` minted, so the tool spans that
 * name it as their parent land underneath it.
 */
function emitChatSpan(
  provider: NodeTracerProvider,
  traceId: string,
  turnSpanId: string,
  chatSpanId: string,
  call: ChatCall,
): void {
  const parentCtx = trace.setSpanContext(ROOT_CONTEXT, {
    traceId,
    spanId: turnSpanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });

  // provider.getTracer, not the global — see emitDeferredSpan.
  const tracer = provider.getTracer('nio-collector', '1.0.0');
  const span = tracer.startSpan(
    chatSpanName(call),
    {
      startTime: call.startMs,
      attributes: chatSpanAttributes(call) as Record<string, string | number | boolean>,
    },
    parentCtx,
  );
  (span.spanContext() as { spanId: string }).spanId = chatSpanId;
  span.end(call.endMs);
}

// ---------------------------------------------------------------------------
// Session span (Task 4)
// ---------------------------------------------------------------------------


/**
 * Emit the session's own root span at `SessionEnd`, using the trace/span
 * ids minted by `startSessionTrace` at `SessionStart`. A no-op — not an
 * error — when those fields are missing (platform never fired
 * SessionStart, or the state predates this feature): the caller decides
 * whether to persist any state change, this function only exports.
 */
export async function emitSessionSpan(
  provider: NodeTracerProvider,
  state: CollectorState,
): Promise<void> {
  const traceId = state.session_trace_id;
  const spanId = state.session_span_id;
  if (!traceId || !spanId) return;

  const rootCtx = trace.setSpanContext(ROOT_CONTEXT, {
    traceId,
    spanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });

  // provider.getTracer, not the global — see emitDeferredSpan.
  const tracer = provider.getTracer('nio-collector', '1.0.0');
  const span = tracer.startSpan(
    'session',
    {
      startTime: state.session_start_ms ?? Date.now(),
      attributes: genAiInvokeAgentAttributes(state.session_id, {
        'gen_ai.operation.name': 'session',
      }) as Record<string, string | number | boolean>,
    },
    rootCtx,
  );
  (span.spanContext() as { spanId: string }).spanId = spanId;
  (span as unknown as { parentSpanContext?: unknown }).parentSpanContext = undefined;
  (span as unknown as { parentSpanId?: string }).parentSpanId = undefined;
  span.end();

  await provider.forceFlush();
}
