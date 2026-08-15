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
 *     └─ Span: "execute_tool <name>" — one per tool call, a SIBLING of chat
 *     └─ Span: "task:execute" — one span per task lifecycle
 *
 * Why tool spans are eager
 * ------------------------
 * `recordPostToolUse` emits a finished tool span immediately, as a child
 * of the turn root. Only the chat layer and the turn root wait for
 * `endTurn`, because only they need the conversation source.
 *
 * Nesting a tool under the LLM call that issued it is not knowable at
 * PostToolUse time — the attribution comes from the conversation source
 * once the turn is over — so it can only be had by parking every
 * finished span until then. That was tried and measured: a live
 * seven-minute turn showed NOTHING on the backend while 38 finished
 * spans sat in its state shard, and a crash in that window left no
 * record of how far the agent got. The issuing call now survives as
 * DATA — `gen_ai.tool.call.id` on the tool span, joinable against the
 * chat call's `tool_use` block — instead of as a parent edge.
 *
 * `deferPostToolUse` and `state.deferred_spans` are kept and still
 * exercised. `PluginRuntimeOptions.eagerToolSpans: false` selects them,
 * the crash-salvage in `traces-state-store.ts` reads and writes them, and
 * a turn boundary still reclaims any span whose post-side event never
 * arrived. Nothing on the default path leaves anything parked.
 */

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { trace, TraceFlags, ROOT_CONTEXT, SpanStatusCode, type Link } from '@opentelemetry/api';
import { NodeTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
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
import { redactSecrets } from './content/redact.js';
import {
  buildSpanContent, spanCarriesWholeContent, spanContentAttributes, type SpanContent,
} from './content/span-content.js';

// Re-export so collector-core / tests can pull state types from a single place.
export type { CollectorState, PendingToolSpan, PendingTaskSpan, DeferredSpan };

/**
 * Callback invoked once per chat span, with the span id that span was
 * just given, so the caller can emit that call's content through the
 * logs signal already associated with its span.
 *
 * Declared here (not in `content/sink.ts`, which implements it) so this
 * module can accept one without importing the logs SDK: traces stays
 * free of any logs-side dependency, and the two signals only meet in the
 * layer that owns both providers.
 *
 * The sink emits the call's own blocks only. A tool call's arguments are
 * owned by the site that emits that tool's span (see
 * `content/emit.ts`'s module doc), and the chat call's claim on them —
 * "this call issued that tool" — rides the chat span as
 * `nio.chat.tool_call_ids` instead of a duplicate log record.
 */
export type ChatContentSink = (
  call: ChatCall,
  spanId: string,
  traceId: string,
) => void;

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
  if (s && s.length > maxBytes) s = flatten(s.slice(0, maxBytes)) + '…[truncated]';
  return s ?? '';
}

/**
 * Copy a string into a fresh, flat one.
 *
 * `s.slice(0, n)` does NOT bound the memory the result costs. V8 answers
 * a slice of a long string with a SlicedString — a view that keeps the
 * WHOLE parent alive — so `redactAndTruncate` was capping the value at
 * 2048 chars while still pinning every byte of the payload it was
 * handed. Measured (2000 truncations of a distinct 50 KB payload, forced
 * GC either side): **50,130 B retained per 2060-char output** without
 * this copy, **4,192 B with it** — 12×, and the multiplier is set by the
 * INPUT size, so it grows without bound as tool outputs get bigger.
 *
 * That matters most where truncated attributes are held rather than
 * emitted and dropped — the parking path (`eagerToolSpans: false`) holds
 * one closed tool span per call for the whole turn (see
 * MAX_DEFERRED_SPANS), each carrying `gen_ai.tool.call.arguments` +
 * `gen_ai.tool.call.result`. It is cheap enough to be worth keeping on
 * the eager path too, where the strings live only until the export.
 * The strings being pinned are Nio's own `JSON.stringify` intermediates,
 * which would otherwise be collectable the moment this function returns.
 *
 * utf16le round-trip rather than `split('').join('')` (one copy instead
 * of 2048 single-char strings) and rather than a utf8 round-trip, which
 * is NOT identity: truncating at a fixed number of UTF-16 code units can
 * split a surrogate pair, and utf8 would rewrite the resulting lone
 * surrogate as U+FFFD. Verified character-identical against the plain
 * slice over ASCII, multi-byte, split-surrogate-pair and lone-surrogate
 * inputs.
 */
function flatten(s: string): string {
  return Buffer.from(s, 'utf16le').toString('utf16le');
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

/**
 * Tool-call identity only — no payload.
 *
 * Used by the hook flow (Claude Code / Codex / Hermes) at PreToolUse,
 * where the span's identity has to survive a process boundary through
 * the on-disk state file and every hook event rewrites that file whole.
 * Carrying the tool's arguments and result there made it grow with each
 * call in a long turn.
 *
 * The span still ENDS UP with its arguments. `collector-core.ts` attaches
 * them at PostToolUse via `genAiToolCallArgumentAttributes`, off the live
 * hook payload — and since `recordPostToolUse` drains the entry it
 * appends, they reach the exporter without ever being written to disk.
 * The in-process runtime has the params in hand at the pre side and uses
 * `genAiToolCallInputAttributes` below instead; its state is in memory,
 * so it has no file to keep small.
 */
export function genAiToolCallIdAttributes(
  toolCallId?: string,
): Record<string, unknown> {
  return toolCallId ? { 'gen_ai.tool.call.id': toolCallId } : {};
}

/** Tool-call input attrs (PreToolUse). Eager flows only — see `genAiToolCallIdAttributes`. */
export function genAiToolCallInputAttributes(
  toolInput: unknown,
  toolCallId?: string,
): Record<string, unknown> {
  return {
    'gen_ai.tool.call.arguments': redactAndTruncate(toolInput),
    ...(toolCallId ? { 'gen_ai.tool.call.id': toolCallId } : {}),
  };
}

/**
 * Tool-call argument attrs for a DEFERRED tool span, built at end of turn
 * from a body that `buildSpanContent` has already redacted and size-
 * capped.
 *
 * Same attribute key as the eager path's `genAiToolCallInputAttributes`,
 * so a consumer reads arguments off one key regardless of which flow
 * produced the span. The difference is provenance: this one takes an
 * already-prepared `SpanContent` (redacted, byte-capped, with a
 * truncation flag) instead of raw input, because the placement decision
 * — span or logs — is made on that same value and the two must not
 * disagree.
 */
export function genAiToolCallArgumentAttributes(args: SpanContent): Record<string, unknown> {
  return {
    'gen_ai.tool.call.arguments': args.text,
    ...spanContentAttributes(args),
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

/**
 * Marker attrs for a *reclaimed* tool span — one closed by the turn
 * flush because the host never delivered a post-side event for it.
 *
 * The canonical case is opencode: `tool.execute.after` does not fire
 * when a tool throws, so `session.idle` → `flushSessionTurn` is what
 * closes the span. At that moment the tool's real outcome is unknown:
 * marking the span ERROR would be as much of a lie as leaving it
 * indistinguishable from a success.
 *
 * The OTel status field cannot carry this. `UNSET` is already the status
 * a *successfully* closed Nio tool span gets (nothing ever calls
 * `setStatus(OK)`), and the SDK drops the `message` on a non-ERROR
 * status — verified against @opentelemetry/sdk-trace-node in this repo:
 * `setStatus({ code: UNSET, message: 'x' })` exports as `{ code: 0 }`.
 * So "outcome unknown" is expressed as explicit `nio.*` attributes,
 * which is also why this does not collide with any `gen_ai.*` key.
 *
 * A reclaimed span is still degraded in two ways that no attribute can
 * repair: its end timestamp is the turn flush rather than the tool's
 * real finish, and it carries no `gen_ai.tool.call.result`. The absence
 * of that result attribute is itself a second signal of the same fact.
 */
export function nioReclaimedSpanAttributes(): Record<string, unknown> {
  return {
    'nio.span.reclaimed': true,
    'nio.span.reclaim_reason': 'no_post_tool_event',
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

/**
 * Record user prompt onto turn state (UserPromptSubmit / before_agent_reply).
 *
 * `redactAndTruncate` is a straight passthrough on strings — it only
 * scans JSON *key names*, so a prompt like "here's my key, sk-live-..."
 * would ride straight through untouched. Free-text prose is exactly what
 * `redactSecrets` (content/redact.ts) scans for, and the user prompt is
 * the single most likely place for a pasted credential to show up — so
 * it runs first, same redact-then-truncate order the content pipeline
 * uses everywhere else.
 */
export function recordUserPrompt(state: CollectorState, prompt: string): CollectorState {
  return setTurnAttributes(state, { 'nio.turn.user_prompt': redactAndTruncate(redactSecrets(prompt).text) });
}

/** Record assistant reply onto turn state (currently OpenClaw llm_output). See recordUserPrompt for why redactSecrets runs first. */
export function recordAssistantReply(state: CollectorState, reply: string): CollectorState {
  return setTurnAttributes(state, { 'nio.turn.assistant_reply': redactAndTruncate(redactSecrets(reply).text) });
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

export interface TracerProviderOptions {
  /**
   * Install this provider as the OTel global (`provider.register()`).
   *
   * Defaults to true, which is what every hook entrypoint wants. It is
   * turned OFF for the short-lived providers `collector-core` builds to
   * re-emit an abandoned shard under ITS OWN platform identity: identity
   * lives on the Resource, one Resource belongs to one provider, and a
   * second `register()` would either be dropped (the registry is a
   * singleton) or clobber the process's real provider. Spans are emitted
   * through `provider.getTracer(...)` rather than the global API, so a
   * non-registered provider exports normally.
   */
  register?: boolean;
}

export function createTracerProvider(
  config: CollectorConfig,
  platform: string,
  agentName?: string,
  options: TracerProviderOptions = {},
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
    // BatchSpanProcessor, not SimpleSpanProcessor. Simple starts one
    // export per `span.end()`, and `endTurn` ends a turn's whole tree in
    // one synchronous burst — so a turn with more than 30 spans blew
    // straight through the OTLP exporter's in-flight cap
    // (`otlp-exporter-base`'s `concurrencyLimit: 30`, not reachable from
    // our config surface). The overflow was rejected by
    // `otlp-export-delegate` with 'Concurrent export limit reached' and
    // returned without retry or requeue. The turn root is ended LAST, so
    // it was always among the casualties: live traces arrived at SigNoz
    // with exactly 30 spans and 0 roots. Batching turns that burst into
    // one request, so the cap is never approached.
    spanProcessors: [new BatchSpanProcessor(exporter, {
      // Must hold a whole large turn between flushes. 2048 is the SDK
      // default and is far above the largest turn observed.
      maxQueueSize: 2048,
      // One request per 512 spans instead of one per span.
      maxExportBatchSize: 512,
      // Every emit path force-flushes right after ending its spans, so
      // this only bounds the worst case where a process exits between
      // events.
      scheduledDelayMillis: 1000,
    })],
  });
  if (options.register !== false) provider.register();
  return provider;
}

/**
 * Flush the provider without ever throwing.
 *
 * `SimpleSpanProcessor.forceFlush()` resolves whatever the export result
 * was; `BatchSpanProcessor.forceFlush()` REJECTS when the batch's export
 * fails (`_flushOneBatch` rejects on a non-SUCCESS result or after its
 * own timeout). Every emit helper below awaits the flush inline, so
 * without this the processor swap would turn "the collector endpoint is
 * unreachable" into a thrown exception inside `recordPostToolUse` /
 * `endTurn` / `emitSessionSpan` — i.e. telemetry taking the host down
 * with it, on paths (the guard's deny close-out among them) whose whole
 * point is to survive a broken collector.
 *
 * Nothing is lost by swallowing it: the underlying failure is already
 * audited by `instrumentExporter`, which reports every FAILED export as
 * an `otlp_export_failed` diagnostic with the endpoint in the hint.
 */
async function flushSpans(provider: NodeTracerProvider): Promise<void> {
  try {
    await provider.forceFlush();
  } catch {
    // Already audited at the exporter. Telemetry must not throw.
  }
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
  /**
   * Attributes known only at emit time — currently the tool's arguments,
   * recovered from the chat call that issued it. Kept out of
   * `deferred.attributes` on purpose: everything in there is written to
   * the state file on every hook event.
   */
  extraAttributes?: Record<string, unknown>,
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
      attributes: {
        ...deferred.attributes,
        ...extraAttributes,
      } as Record<string, string | number | boolean>,
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
 * Emit the oldest parked spans past `max` right now, as direct children
 * of the turn root, and drop them from the queue. Returns the state
 * unchanged when the queue is within budget.
 *
 * A bound on `deferred_spans` that DROPPED spans would be the wrong
 * trade twice over: the whole point of parking one is that it is going
 * to be exported at turn close, and its `tool_input` / `tool_output`
 * content log records — emitted at PreToolUse / PostToolUse, carrying
 * this span's id — are already on the logs signal, so dropping the span
 * would leave the backend permanently holding records that name a span
 * it will never receive. Flushing early costs only the attribution: an
 * overflow span hangs off the turn root instead of the chat call that
 * issued it, exactly the shape `eagerToolSpans: true` accepts on
 * purpose.
 *
 * The loss is therefore parentage, not data — and it is marked rather
 * than silent (`nio.span.deferred_overflow`), so a flat-looking subtree
 * can be told apart from one that was never attributable.
 *
 * Callers own the policy (the `max`); this function owns the mechanism.
 */
export function overflowDeferredSpans(
  provider: NodeTracerProvider,
  state: CollectorState,
  max: number,
): CollectorState {
  const deferred = state.deferred_spans ?? [];
  if (deferred.length <= max) return state;
  const traceId = state.turn_trace_id;
  // No turn trace id means there is no root to parent onto and no trace
  // to join; keeping the spans parked is strictly better than emitting
  // them into a trace that does not exist.
  if (!traceId) return state;

  const cut = deferred.length - max;
  for (let i = 0; i < cut; i++) {
    const span = deferred[i]!;
    emitDeferredSpan(provider, traceId, traceId.slice(0, 16), {
      ...span,
      attributes: {
        ...span.attributes,
        'nio.span.deferred_overflow': true,
        'nio.span.deferred_cap': max,
      },
    });
  }
  return { ...state, deferred_spans: deferred.slice(cut) };
}

/**
 * Close a pending tool span and emit it immediately, as a direct child
 * of the turn.
 *
 * Thin wrapper over `deferPostToolUse` + a single-span flush, kept for
 * the callers that cannot wait for the end of turn:
 *
 *  - the NORMAL post-side close, on every platform. This is the default
 *    path now; see `PluginRuntimeOptions.eagerToolSpans` for the
 *    measurement that made it so.
 *  - the guard's block path (guard-hook / hook-cli / openclaw-plugin):
 *    PostToolUse will never fire for a denied call, and a security event
 *    that only surfaces once the turn closes is not observable when it
 *    matters.
 *  - the turn/session sweep of leftover pending spans.
 *
 * The span goes out now and `deferred_spans` is left exactly as it was
 * found — the entry `deferPostToolUse` appends is drained again before
 * returning, which is also why the arguments passed in `postAttributes`
 * never reach the on-disk state file.
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

  await flushSpans(provider);

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

  await flushSpans(provider);

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
 *
 * `contentSink` receives every chat call together with the span id it
 * was just given. This is the earliest moment a chat call HAS a span id
 * — `buildSpanTree` mints it here — which is why conversation content
 * goes out with the tree rather than "live" as the design originally
 * assumed. A throwing sink is contained: content is telemetry and must
 * never cost the span tree.
 */
export async function endTurn(
  provider: NodeTracerProvider,
  state: CollectorState,
  cwd: string | null,
  transcriptPath?: string | null,
  calls?: ChatCall[],
  contentSink?: ChatContentSink,
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

    // Tool arguments ride on the tool span when they fit the span budget
    // (see content/span-content.ts). The payload comes from the chat
    // call's own `tool_use` block — already in memory, never from the
    // state file — so this costs nothing on disk. Only reachable on the
    // parking path (`eagerToolSpans: false`); `node.tools` is empty
    // whenever tool spans are eager, which is the production default.
    for (const tool of node.tools) {
      const args = toolArgumentsFor(node.call, tool.tool_use_id);
      emitDeferredSpan(
        provider, traceId, node.span_id, tool,
        args ? genAiToolCallArgumentAttributes(args) : undefined,
      );
    }

    if (contentSink) {
      try {
        contentSink(node.call, node.span_id, traceId);
      } catch {
        // Content is telemetry; a failure here must not cost the tree.
      }
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

  await flushSpans(provider);

  return {
    session_id: state.session_id,
    turn_number: state.turn_number,
    turn_trace_id: '',          // cleared — re-minted by the next turn's first ensureTurn (UserPromptSubmit)
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
 * The arguments a chat call passed to one of its tool calls, prepared for
 * a span attribute.
 *
 * `null` when the tool span carries no `tool_use_id` (it was attributed
 * by time, not identity — see `buildSpanTree`), when the call declares no
 * matching block, or when the argument body is empty. In every one of
 * those cases the tool span simply gets no arguments attribute and the
 * `tool_input` content record remains the only copy.
 */
function toolArgumentsFor(call: ChatCall, toolUseId?: string): SpanContent | null {
  if (!toolUseId) return null;
  for (const block of call.blocks) {
    if (block.type !== 'tool_use') continue;
    if (block.toolUse?.id !== toolUseId) continue;
    return buildSpanContent(block.content);
  }
  return null;
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
// Session span (Task 4) + crash recovery (Task 5)
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

  await flushSpans(provider);
}

/**
 * Detects a deferred-span tree left behind by a process that was killed
 * before it ever reached `Stop`/`SubagentStop`/`SessionEnd`.
 *
 * Only reachable from a shard the PARKING path wrote — an older nio, or
 * a runtime with `PluginRuntimeOptions.eagerToolSpans: false`. Under the
 * default nothing is ever parked, so `deferred_spans` is empty and this
 * returns false for every shard the current code produces. Kept because
 * those shards outlive the upgrade that stopped producing them.
 *
 * What it was for: deferral moved the crash blast radius. Before it, a
 * killed process only cost the turn's root span, every tool span having
 * gone out individually. Under deferral the whole tree — root AND every
 * finished tool span — sat unflushed in `state.deferred_spans` until
 * endTurn ran, and if that never happened all of it silently vanished.
 * Note the limit even then: this adopts a shard whose turn is already
 * CLOSED (or belongs to another session). A LIVE turn's queue is not
 * salvage material, which is why the parked spans of a crashed long turn
 * were never recoverable at all.
 *
 * True when the loaded state carries a non-empty `deferred_spans` that
 * the CURRENT event's turn cannot own — either because the incoming
 * event belongs to a different session, or because the persisted turn
 * was already closed (`turn_trace_id` empty) while deferred_spans
 * somehow survived. Mirrors `ensureTurn`'s own "is this still the active
 * turn" check (`prev.session_id === sessionId && prev.turn_trace_id`) —
 * this is its negation, gated on deferred_spans actually having
 * something to lose.
 */
export function hasOrphanedDeferredTree(
  state: CollectorState | null,
  incomingSessionId: string,
): boolean {
  if (!state) return false;
  if (!state.deferred_spans || state.deferred_spans.length === 0) return false;
  return state.session_id !== incomingSessionId || !state.turn_trace_id;
}

/**
 * Flush a crash-orphaned deferred-span tree.
 *
 * Every span in `state.deferred_spans` is emitted as a direct child of a
 * synthetic turn root (no chat-call attribution attempt — the
 * conversation source for a dead turn may no longer be reconstructable,
 * and guessing is worse than a flat tree). The root is tagged
 * `nio.turn.incomplete: true` so the backend can tell a real turn close
 * from a forced one apart.
 *
 * Reuses `state.turn_trace_id` as the trace id when one exists — this is
 * load-bearing, not cosmetic: content log records for this turn's tool
 * calls were already emitted (by the logs signal, as they happened) tagged
 * with that same trace id. Minting a fresh id here would orphan those log
 * records from the spans being recovered. Only mints a fresh id when
 * `turn_trace_id` is itself empty (the state has nothing valid to reuse —
 * see `hasOrphanedDeferredTree`'s second trigger condition).
 *
 * Idempotent: returns `deferred_spans: []`, so calling this twice on the
 * (now-empty) result is a no-op on the second call.
 */
export interface RecoverOptions {
  /**
   * Give the synthetic root a RANDOM span id instead of the usual
   * `traceId.slice(0, 16)`.
   *
   * That derived id is the one `endTurn` forces onto a real turn root, so
   * the two collide whenever the turn this tree came from is still open —
   * which is exactly the case on the salvage path, where the shard is
   * written back with its `turn_trace_id` intact so a session that was
   * merely idle can carry on. Two spans sharing a (trace id, span id) are
   * not a hard error but backends merge or duplicate them, and the salvage
   * root is a different span from the real close: it ends early and is
   * tagged `nio.turn.incomplete`.
   *
   * Detaching only changes the root's id. The trace id is unchanged, so
   * the salvaged spans still sit in the same trace as the content log
   * records already emitted for them and as the eventual real turn root.
   */
  detachedRoot?: boolean;
}

export async function recoverDeferredTree(
  provider: NodeTracerProvider,
  state: CollectorState,
  options: RecoverOptions = {},
): Promise<CollectorState> {
  const deferred = state.deferred_spans ?? [];
  if (deferred.length === 0) return state;

  const traceId = state.turn_trace_id || freshTraceId();
  const turnSpanId = options.detachedRoot ? randomSpanId() : traceId.slice(0, 16);

  const rootCtx = trace.setSpanContext(ROOT_CONTEXT, {
    traceId,
    spanId: turnSpanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });

  // provider.getTracer, not the global — see emitDeferredSpan.
  const tracer = provider.getTracer('nio-collector', '1.0.0');
  const rootSpan = tracer.startSpan(
    'invoke_agent UserPromptSubmit',
    {
      startTime: state.turn_start_ms || Date.now(),
      attributes: {
        ...genAiInvokeAgentAttributes(state.session_id),
        'nio.turn_number': state.turn_number,
        'nio.turn.incomplete': true,
        ...(state.turn_attributes ?? {}),
      } as Record<string, string | number | boolean>,
    },
    rootCtx,
  );
  (rootSpan.spanContext() as { spanId: string }).spanId = turnSpanId;
  (rootSpan as unknown as { parentSpanContext?: unknown }).parentSpanContext = undefined;
  (rootSpan as unknown as { parentSpanId?: string }).parentSpanId = undefined;
  rootSpan.end();

  for (const span of deferred) {
    emitDeferredSpan(provider, traceId, turnSpanId, span);
  }

  await flushSpans(provider);

  return {
    ...state,
    turn_trace_id: '',
    turn_start_ms: 0,
    pending_spans: {},
    pending_task_spans: {},
    pending_guard_attrs: {},
    turn_attributes: {},
    deferred_spans: [],
  };
}
