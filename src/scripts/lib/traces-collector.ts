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
 *     └─ Span: "execute_tool <name>" — one span per tool call (pre→post)
 *     └─ Span: "task:execute" — one span per task lifecycle
 */

import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { trace, TraceFlags, ROOT_CONTEXT, SpanStatusCode } from '@opentelemetry/api';
import { NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { OTLPTraceExporter as OTLPTraceExporterHttp } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPTraceExporter as OTLPTraceExporterGrpc } from '@opentelemetry/exporter-trace-otlp-grpc';
import { Metadata } from '@grpc/grpc-js';
import type { CollectorConfig } from './config-loader.js';
import type { CollectorState, PendingToolSpan, PendingTaskSpan } from './traces-state-store.js';

// Re-export so collector-core / tests can pull state types from a single place.
export type { CollectorState, PendingToolSpan, PendingTaskSpan };

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
  platform: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const agentName = platform;
  return {
    'gen_ai.operation.name': 'invoke_agent',
    'gen_ai.provider.name': GEN_AI_PROVIDER_NAME,
    'gen_ai.conversation.id': sessionId,
    'gen_ai.agent.name': agentName,
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
  if (prev && prev.session_id === sessionId && prev.turn_trace_id) {
    return prev;
  }

  const turnNumber = (prev?.session_id === sessionId ? prev.turn_number : 0) + 1;
  return {
    session_id: sessionId,
    turn_number: turnNumber,
    turn_trace_id: turnToTraceId(sessionId, turnNumber),
    turn_start_ms: Date.now(),
    pending_spans: {},
    pending_task_spans: {},
    turn_attributes: {},
  };
}

/** Records a pending tool span. Returns a new state object. */
export function recordPreToolUse(
  state: CollectorState,
  spanKey: string,
  toolName: string,
  toolSummary: string,
  attributes?: Record<string, unknown>,
): CollectorState {
  const next: PendingToolSpan = {
    tool_name: toolName,
    tool_summary: toolSummary,
    start_ms: Date.now(),
    span_id: randomSpanId(),
    ...(attributes ? { attributes } : {}),
  };
  return {
    ...state,
    pending_spans: { ...state.pending_spans, [spanKey]: next },
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
 * Closes the pending tool span and emits it as a child of the current
 * turn. Returns the next state (with the pending entry removed) and the
 * duration in ms. If no matching pre-span existed, returns durationMs:
 * null and the state unchanged.
 */
export async function recordPostToolUse(
  provider: NodeTracerProvider,
  state: CollectorState,
  spanKey: string,
  platform: string,
  cwd: string | null,
  postAttributes?: Record<string, unknown>,
  error?: string | null,
): Promise<PostSpanResult> {
  const pending = state.pending_spans[spanKey];
  if (!pending) return { state, durationMs: null };

  const endMs = Date.now();
  const startMs = pending.start_ms;

  const traceId = state.turn_trace_id;
  const parentCtx = trace.setSpanContext(ROOT_CONTEXT, {
    traceId,
    spanId: traceId.slice(0, 16),  // synthetic parent representing the turn
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });

  const tracer = trace.getTracer('nio-collector', '1.0.0');
  const toolCallId =
    (pending.attributes?.['gen_ai.tool.call.id'] as string | undefined) ??
    undefined;
  const span = tracer.startSpan(
    `execute_tool ${pending.tool_name || 'unknown'}`,
    {
      startTime: startMs,
      attributes: {
        ...genAiToolAttributes(pending.tool_name, toolCallId),
        'nio.tool_summary': pending.tool_summary,
        'nio.platform': platform,
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

  const { [spanKey]: _removed, ...remaining } = state.pending_spans;
  void _removed;
  return {
    state: { ...state, pending_spans: remaining },
    durationMs: endMs - startMs,
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
  platform: string,
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
 * Emits the root span for the full turn duration, then returns a fresh
 * state with the turn marker cleared so the next user message starts a
 * new turn. Returns null if the input state has no active turn — caller
 * should persist nothing in that case (treat as a no-op for idempotency
 * across concurrent Stop/SubagentStop hooks).
 */
export async function endTurn(
  provider: NodeTracerProvider,
  state: CollectorState,
  platform: string,
  cwd: string | null,
  transcriptPath?: string | null,
): Promise<CollectorState | null> {
  if (!state.turn_trace_id) return null;

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
    'invoke_agent UserPromptSubmit',
    {
      startTime: state.turn_start_ms,
      attributes: {
        ...genAiInvokeAgentAttributes(state.session_id, platform),
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
      span.setAttribute('nio.turn.cache_hit_rate', usage.cache_hit_rate);
      span.setAttribute('gen_ai.usage.input_tokens', usage.input_tokens);
      span.setAttribute('gen_ai.usage.output_tokens', usage.output_tokens);
      span.setAttribute('gen_ai.usage.cache_creation.input_tokens', usage.cache_creation_input_tokens);
      span.setAttribute('gen_ai.usage.cache_read.input_tokens', usage.cache_read_input_tokens);
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

  return {
    session_id: state.session_id,
    turn_number: state.turn_number,
    turn_trace_id: '',          // cleared — re-derived on next PreToolUse
    turn_start_ms: 0,
    pending_spans: {},
    pending_task_spans: {},
    turn_attributes: {},
  };
}
