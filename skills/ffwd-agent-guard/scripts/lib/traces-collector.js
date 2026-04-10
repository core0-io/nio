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
// ---------------------------------------------------------------------------
// Redaction + truncation for span attribute payloads
// ---------------------------------------------------------------------------
const MAX_ATTR_BYTES = 2048;
const SECRET_KEY_RE = /(api[_-]?key|secret|token|password|passwd|authorization|bearer|private[_-]?key|mnemonic|seed|credential)/i;
export function redactAndTruncate(value, maxBytes = MAX_ATTR_BYTES) {
    const redact = (v) => {
        if (v === null || v === undefined)
            return v;
        if (typeof v === 'string')
            return v;
        if (typeof v !== 'object')
            return v;
        if (Array.isArray(v))
            return v.map(redact);
        const out = {};
        for (const [k, val] of Object.entries(v)) {
            out[k] = SECRET_KEY_RE.test(k) ? '[REDACTED]' : redact(val);
        }
        return out;
    };
    let s;
    try {
        s = typeof value === 'string' ? value : JSON.stringify(redact(value));
    }
    catch {
        s = String(value);
    }
    if (s && s.length > maxBytes)
        s = s.slice(0, maxBytes) + '…[truncated]';
    return s ?? '';
}
/**
 * Merge attributes onto the current turn; persisted so endTurn can emit them
 * on the root span. Safe to call from any hook.
 */
export function setTurnAttributes(config, state, attributes) {
    state.turn_attributes = { ...(state.turn_attributes ?? {}), ...attributes };
    saveState(stateFilePath(config), state);
}
// ---------------------------------------------------------------------------
// State file helpers
// ---------------------------------------------------------------------------
function stateFilePath(config) {
    // Derive state directory from the log path or use default
    const base = config.log
        ? dirname(config.log)
        : `${process.env['HOME'] ?? '~'}/.ffwd-agent-guard`;
    return `${base}/collector-state.json`;
}
function loadState(statePath) {
    try {
        const raw = readFileSync(statePath, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
function saveState(statePath, state) {
    const dir = dirname(statePath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
}
// ---------------------------------------------------------------------------
// Trace ID derivation
// ---------------------------------------------------------------------------
function turnToTraceId(sessionId, turnNumber) {
    return createHash('md5').update(`${sessionId}:${turnNumber}`).digest('hex');
}
function randomSpanId() {
    return randomBytes(8).toString('hex');
}
// ---------------------------------------------------------------------------
// OTEL provider factory
// ---------------------------------------------------------------------------
export function createTracerProvider(config) {
    if (!config.endpoint)
        return null;
    const headers = {};
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
    }
    else {
        exporter = new OTLPTraceExporterHttp({
            url: tracesUrl,
            headers,
            timeoutMillis: config.timeout,
        });
    }
    const provider = new NodeTracerProvider({
        resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'agentguard' }),
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
export function ensureTurn(config, sessionId) {
    const statePath = stateFilePath(config);
    const existing = loadState(statePath);
    if (existing && existing.session_id === sessionId && existing.turn_trace_id) {
        return existing;
    }
    // New session or no active turn
    const turnNumber = (existing?.session_id === sessionId ? existing.turn_number : 0) + 1;
    const state = {
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
export function recordPreToolUse(config, state, spanKey, toolName, toolSummary, attributes) {
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
export function recordPreTaskToolUse(config, state, taskId, taskSummary) {
    const statePath = stateFilePath(config);
    if (!state.pending_task_spans)
        state.pending_task_spans = {};
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
export async function recordPostTaskToolUse(config, provider, state, taskId, platform, cwd) {
    const pending = state.pending_task_spans?.[taskId];
    if (!pending)
        return null;
    const endMs = Date.now();
    const startMs = pending.start_ms;
    const traceId = state.turn_trace_id;
    const parentCtx = trace.setSpanContext(ROOT_CONTEXT, {
        traceId,
        spanId: traceId.slice(0, 16),
        traceFlags: TraceFlags.SAMPLED,
        isRemote: true,
    });
    const tracer = trace.getTracer('agentguard-collector', '1.0.0');
    const span = tracer.startSpan('task:execute', {
        startTime: startMs,
        attributes: {
            'agentguard.task_id': taskId,
            'agentguard.task_summary': pending.task_summary,
            'agentguard.platform': platform,
            'agentguard.session_id': state.session_id,
            'agentguard.turn_number': state.turn_number,
            ...(cwd ? { 'agentguard.cwd': cwd } : {}),
        },
    }, parentCtx);
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
export async function recordPostToolUse(config, provider, state, spanKey, platform, cwd, postAttributes, error) {
    const pending = state.pending_spans[spanKey];
    if (!pending)
        return null;
    const endMs = Date.now();
    const startMs = pending.start_ms;
    const traceId = state.turn_trace_id;
    const parentCtx = trace.setSpanContext(ROOT_CONTEXT, {
        traceId,
        spanId: traceId.slice(0, 16), // synthetic parent span representing the turn
        traceFlags: TraceFlags.SAMPLED,
        isRemote: true,
    });
    const tracer = trace.getTracer('agentguard-collector', '1.0.0');
    const span = tracer.startSpan(`tool:${pending.tool_name}`, {
        startTime: startMs,
        attributes: {
            'agentguard.tool_name': pending.tool_name,
            'agentguard.tool_summary': pending.tool_summary,
            'agentguard.platform': platform,
            'agentguard.session_id': state.session_id,
            'agentguard.turn_number': state.turn_number,
            ...(cwd ? { 'agentguard.cwd': cwd } : {}),
            ...(pending.attributes ?? {}),
            ...(postAttributes ?? {}),
        },
    }, parentCtx);
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
// Turn end
// ---------------------------------------------------------------------------
/**
 * Called on Stop / SubagentStop: emits a root span for the full turn duration,
 * then resets turn state so the next user message starts a fresh turn.
 */
export async function endTurn(config, provider, _state, platform, cwd) {
    // Reload state from disk to serialize against concurrent endTurn calls —
    // if turn_trace_id has already been cleared by a sibling handler, bail.
    const statePath = stateFilePath(config);
    const state = loadState(statePath);
    if (!state || !state.turn_trace_id)
        return;
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
    const tracer = trace.getTracer('agentguard-collector', '1.0.0');
    const span = tracer.startSpan(`turn:${state.turn_number}`, {
        startTime: state.turn_start_ms,
        attributes: {
            'agentguard.session_id': state.session_id,
            'agentguard.turn_number': state.turn_number,
            'agentguard.platform': platform,
            ...(cwd ? { 'agentguard.cwd': cwd } : {}),
            ...(state.turn_attributes ?? {}),
        },
    }, rootCtx);
    // Force the turn span's own spanId to match the synthetic parent spanId that
    // child tool/task spans use (traceId.slice(0,16)). This makes the turn span
    // the actual parent of its children in the trace tree instead of a sibling
    // under a missing span. Also clear parentSpanId so the turn is a true root.
    const sc = span.spanContext();
    sc.spanId = traceId.slice(0, 16);
    // Newer OTEL SDKs expose the parent reference as `parentSpanContext`, older
    // ones as `parentSpanId`. Clear both so the turn span becomes a true root.
    span.parentSpanContext = undefined;
    span.parentSpanId = undefined;
    span.end(endMs);
    await provider.forceFlush();
    // Clear the turn so the next PreToolUse starts fresh
    const next = {
        session_id: state.session_id,
        turn_number: state.turn_number,
        turn_trace_id: '', // cleared — will be re-derived on next PreToolUse
        turn_start_ms: 0,
        pending_spans: {},
        pending_task_spans: {},
        turn_attributes: {},
    };
    saveState(statePath, next);
}
