export {};

/**
 * Traces Collector
 *
 * Manages turn-scoped OTEL traces and tool-call spans across stateless hook
 * invocations. State is persisted to a JSON file between hook calls so that
 * PreToolUse and PostToolUse (which run in separate processes) can share
 * span start times and trace context.
 *
 * Trace hierarchy:
 *
 *   Trace: "turn:<N>" — one trace per conversation turn
 *     └─ Span: "tool:<name>" — one span per tool call (pre→post)
 *     └─ Span: "task:execute" — one span per Task tool invocation
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { trace, TraceFlags, ROOT_CONTEXT, SpanStatusCode } from '@opentelemetry/api';
import { NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { OTLPTraceExporter as OTLPTraceExporterHttp } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPTraceExporter as OTLPTraceExporterGrpc } from '@opentelemetry/exporter-trace-otlp-grpc';
import { Metadata } from '@grpc/grpc-js';
import type { CollectorConfig } from './config-loader.js';

// ---------------------------------------------------------------------------
// State types
// ---------------------------------------------------------------------------

interface PendingToolSpan {
  tool_name: string;
  tool_summary: string;
  start_ms: number;
  span_id: string;  // 8-byte random hex, stable across pre/post
  attributes?: Record<string, unknown>;
}

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

interface PendingTaskSpan {
  task_summary: string;
  start_ms: number;
  span_id: string;
}

export interface CollectorState {
  session_id: string;
  turn_number: number;
  turn_trace_id: string;    // MD5(session_id + ":" + turn_number)
  turn_start_ms: number;
  pending_spans: Record<string, PendingToolSpan>;  // keyed by tool_use_id or fallback
  pending_task_spans: Record<string, PendingTaskSpan>;  // keyed by task_id
  turn_attributes?: Record<string, unknown>;
}

/**
 * Merge attributes onto the current turn; persisted so endTurn can emit them
 * on the root span. Safe to call from any hook.
 */
export function setTurnAttributes(
  config: CollectorConfig,
  state: CollectorState,
  attributes: Record<string, unknown>,
): void {
  state.turn_attributes = { ...(state.turn_attributes ?? {}), ...attributes };
  saveState(stateFilePath(config), state);
}

// ---------------------------------------------------------------------------
// State file helpers
// ---------------------------------------------------------------------------

function stateFilePath(config: CollectorConfig): string {
  // Derive state directory from the log path or use default
  const base = config.log
    ? dirname(config.log)
    : `${process.env['HOME'] ?? '~'}/.nio`;
  return `${base}/collector-state.json`;
}

function loadState(statePath: string): CollectorState | null {
  try {
    const raw = readFileSync(statePath, 'utf-8');
    return JSON.parse(raw) as CollectorState;
  } catch {
    return null;
  }
}

function saveState(statePath: string, state: CollectorState): void {
  const dir = dirname(statePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Trace ID derivation
// ---------------------------------------------------------------------------

function turnToTraceId(sessionId: string, turnNumber: number): string {
  return createHash('md5').update(`${sessionId}:${turnNumber}`).digest('hex');
}

function randomSpanId(): string {
  return randomBytes(8).toString('hex');
}

// ---------------------------------------------------------------------------
// OTEL provider factory
// ---------------------------------------------------------------------------

export function createTracerProvider(config: CollectorConfig): NodeTracerProvider | null {
  if (!config.endpoint) return null;

  const headers: Record<string, string> = {};
  if (config.api_key) {
    headers['Authorization'] = `Bearer ${config.api_key}`;
  }

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

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'nio' }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
  return provider;
}

// ---------------------------------------------------------------------------
// Turn management
// ---------------------------------------------------------------------------

/**
 * Ensures an active turn exists for the given session. If none exists (or the
 * session changed), starts a new turn and persists the state.
 */
export function ensureTurn(
  config: CollectorConfig,
  sessionId: string,
): CollectorState {
  const statePath = stateFilePath(config);
  const existing = loadState(statePath);

  if (existing && existing.session_id === sessionId && existing.turn_trace_id) {
    return existing;
  }

  // New session or no active turn
  const turnNumber = (existing?.session_id === sessionId ? existing.turn_number : 0) + 1;
  const state: CollectorState = {
    session_id: sessionId,
    turn_number: turnNumber,
    turn_trace_id: turnToTraceId(sessionId, turnNumber),
    turn_start_ms: Date.now(),
    pending_spans: {},
    pending_task_spans: {},
    turn_attributes: {},
  };
  saveState(statePath, state);
  return state;
}

// ---------------------------------------------------------------------------
// Span lifecycle
// ---------------------------------------------------------------------------

/**
 * Called at PreToolUse: records span start time and span_id to state.
 */
export function recordPreToolUse(
  config: CollectorConfig,
  state: CollectorState,
  spanKey: string,
  toolName: string,
  toolSummary: string,
  attributes?: Record<string, unknown>,
): void {
  const statePath = stateFilePath(config);
  state.pending_spans[spanKey] = {
    tool_name: toolName,
    tool_summary: toolSummary,
    start_ms: Date.now(),
    span_id: randomSpanId(),
    ...(attributes ? { attributes } : {}),
  };
  saveState(statePath, state);
}

/**
 * Called at PreTaskToolUse: records task span start time to state.
 */
export function recordPreTaskToolUse(
  config: CollectorConfig,
  state: CollectorState,
  taskId: string,
  taskSummary: string,
): void {
  const statePath = stateFilePath(config);
  if (!state.pending_task_spans) state.pending_task_spans = {};
  state.pending_task_spans[taskId] = {
    task_summary: taskSummary,
    start_ms: Date.now(),
    span_id: randomSpanId(),
  };
  saveState(statePath, state);
}

/**
 * Called at PostTaskToolUse: emits a task span as a child of the current turn,
 * removes it from state, and returns the duration in ms.
 */
export async function recordPostTaskToolUse(
  config: CollectorConfig,
  provider: NodeTracerProvider,
  state: CollectorState,
  taskId: string,
  platform: string,
  cwd: string | null,
): Promise<number | null> {
  const pending = state.pending_task_spans?.[taskId];
  if (!pending) return null;

  const endMs = Date.now();
  const startMs = pending.start_ms;

  const traceId = state.turn_trace_id;
  const parentCtx = trace.setSpanContext(ROOT_CONTEXT, {
    traceId,
    spanId: traceId.slice(0, 16),
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });

  const tracer = trace.getTracer('nio-collector', '1.0.0');
  const span = tracer.startSpan(
    'task:execute',
    {
      startTime: startMs,
      attributes: {
        'nio.task_id': taskId,
        'nio.task_summary': pending.task_summary,
        'nio.platform': platform,
        'nio.session_id': state.session_id,
        'nio.turn_number': state.turn_number,
        ...(cwd ? { 'nio.cwd': cwd } : {}),
      },
    },
    parentCtx,
  );
  span.end(endMs);

  await provider.forceFlush();

  const statePath = stateFilePath(config);
  delete state.pending_task_spans[taskId];
  saveState(statePath, state);

  return endMs - startMs;
}

/**
 * Called at PostToolUse: retrieves the pending span, emits it with correct
 * start/end times, removes it from state, and returns the duration in ms.
 * Returns null if no matching pre-span was found.
 */
export async function recordPostToolUse(
  config: CollectorConfig,
  provider: NodeTracerProvider,
  state: CollectorState,
  spanKey: string,
  platform: string,
  cwd: string | null,
  postAttributes?: Record<string, unknown>,
  error?: string | null,
): Promise<number | null> {
  const pending = state.pending_spans[spanKey];
  if (!pending) return null;

  const endMs = Date.now();
  const startMs = pending.start_ms;

  const traceId = state.turn_trace_id;
  const parentCtx = trace.setSpanContext(ROOT_CONTEXT, {
    traceId,
    spanId: traceId.slice(0, 16),  // synthetic parent span representing the turn
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });

  const tracer = trace.getTracer('nio-collector', '1.0.0');
  const span = tracer.startSpan(
    `tool:${pending.tool_name}`,
    {
      startTime: startMs,
      attributes: {
        'nio.tool_name': pending.tool_name,
        'nio.tool_summary': pending.tool_summary,
        'nio.platform': platform,
        'nio.session_id': state.session_id,
        'nio.turn_number': state.turn_number,
        ...(cwd ? { 'nio.cwd': cwd } : {}),
        ...(pending.attributes ?? {}),
        ...(postAttributes ?? {}),
      } as Record<string, string | number | boolean>,
    },
    parentCtx,
  );
  if (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error });
    span.recordException(error);
  }
  span.end(endMs);

  await provider.forceFlush();

  // Remove from state
  const statePath = stateFilePath(config);
  delete state.pending_spans[spanKey];
  saveState(statePath, state);

  return endMs - startMs;
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
 * Called on Stop / SubagentStop: emits a root span for the full turn duration,
 * then resets turn state so the next user message starts a fresh turn.
 */
export async function endTurn(
  config: CollectorConfig,
  provider: NodeTracerProvider,
  _state: CollectorState,
  platform: string,
  cwd: string | null,
  transcriptPath?: string | null,
): Promise<void> {
  // Reload state from disk to serialize against concurrent endTurn calls —
  // if turn_trace_id has already been cleared by a sibling handler, bail.
  const statePath = stateFilePath(config);
  const state = loadState(statePath);
  if (!state || !state.turn_trace_id) return;
  const endMs = Date.now();
  const traceId = state.turn_trace_id;

  // Build a remote parent context with the turn's trace ID so the root span
  // sits at the top of the trace.
  const rootCtx = trace.setSpanContext(ROOT_CONTEXT, {
    traceId,
    spanId: traceId.slice(0, 16),
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });

  const tracer = trace.getTracer('nio-collector', '1.0.0');
  const span = tracer.startSpan(
    `turn:${state.turn_number}`,
    {
      startTime: state.turn_start_ms,
      attributes: {
        'nio.session_id': state.session_id,
        'nio.turn_number': state.turn_number,
        'nio.platform': platform,
        ...(cwd ? { 'nio.cwd': cwd } : {}),
        ...(state.turn_attributes ?? {}),
      } as Record<string, string | number | boolean>,
    },
    rootCtx,
  );
  // Attach token usage from transcript
  if (transcriptPath) {
    const usage = parseTranscriptUsage(transcriptPath, state.turn_start_ms);
    if (usage) {
      span.setAttribute('nio.turn.input_tokens', usage.input_tokens);
      span.setAttribute('nio.turn.output_tokens', usage.output_tokens);
      span.setAttribute('nio.turn.cache_creation_input_tokens', usage.cache_creation_input_tokens);
      span.setAttribute('nio.turn.cache_read_input_tokens', usage.cache_read_input_tokens);
      span.setAttribute('nio.turn.cache_hit_rate', usage.cache_hit_rate);
    }
  }

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

  // Clear the turn so the next PreToolUse starts fresh
  const next: CollectorState = {
    session_id: state.session_id,
    turn_number: state.turn_number,
    turn_trace_id: '',          // cleared — will be re-derived on next PreToolUse
    turn_start_ms: 0,
    pending_spans: {},
    pending_task_spans: {},
    turn_attributes: {},
  };
  saveState(statePath, next);
}
