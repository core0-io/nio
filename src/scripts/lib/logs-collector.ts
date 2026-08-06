// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * OTEL Logs Collector — exports audit log entries as OTEL LogRecords.
 *
 * Follows the same provider factory pattern as metrics-collector.ts and
 * traces-collector.ts. Reuses the same collector endpoint/auth config.
 *
 * Attribute schema is aligned with the traces signal: shared concepts
 * (tool name, conversation/session, guard decision) use the same key
 * names that `traces-collector.ts` writes onto spans, so the same
 * dashboards work across logs and traces. Nio-specific extensions
 * (`nio.event`, `nio.platform`, `nio.phases.*`, etc.) keep their `nio.`
 * prefix.
 */

import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { trace, ROOT_CONTEXT, TraceFlags, type Context } from '@opentelemetry/api';
import { OTLPLogExporter as OTLPLogExporterHttp } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPLogExporter as OTLPLogExporterGrpc } from '@opentelemetry/exporter-logs-otlp-grpc';
import { Metadata } from '@grpc/grpc-js';
import { collectorRequestHeaders, type CollectorConfig } from './config-loader.js';
import { nioGuardAttributes, buildNioResource } from './traces-collector.js';
import { instrumentExporter } from './exporter-diagnostics.js';
import type { ContentRecord } from './content/emit.js';

/** Minimal audit entry shape for OTEL log emission (avoids cross-rootDir import). */
interface AuditEntry {
  event: string;
  platform: string;
  session_id?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Severity mapping
// ---------------------------------------------------------------------------

const RISK_TO_SEVERITY: Record<string, SeverityNumber> = {
  low: SeverityNumber.INFO,
  medium: SeverityNumber.WARN,
  high: SeverityNumber.ERROR,
  critical: SeverityNumber.FATAL,
};

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export function createLoggerProvider(
  config: CollectorConfig,
  platform: string,
  agentName?: string,
): LoggerProvider | null {
  if (!config.endpoint) return null;
  if (!config.logs_enabled) return null;

  const headers = collectorRequestHeaders(config);

  const base = config.endpoint.replace(/\/$/, '');
  const logsUrl = config.protocol === 'grpc' ? base : `${base}/v1/logs`;

  let exporter;
  if (config.protocol === 'grpc') {
    const grpcMetadata = new Metadata();
    for (const [k, v] of Object.entries(headers)) {
      grpcMetadata.set(k, v);
    }
    exporter = new OTLPLogExporterGrpc({
      url: logsUrl,
      metadata: grpcMetadata,
      timeoutMillis: config.timeout,
    });
  } else {
    exporter = new OTLPLogExporterHttp({
      url: logsUrl,
      headers,
      timeoutMillis: config.timeout,
    });
  }
  instrumentExporter(exporter, 'logs', config.endpoint);

  return new LoggerProvider({
    resource: buildNioResource(platform, agentName),
    // BatchLogRecordProcessor, not SimpleLogRecordProcessor. Simple
    // starts one export per `logger.emit()`, and a turn's content sink
    // emits the whole turn's records — thinking, text, tool_input — in
    // one synchronous burst (`emitContentRecords`' loop below). So a
    // turn with more than 30 content records blew straight through the
    // OTLP exporter's in-flight cap (`otlp-exporter-base`'s
    // `concurrencyLimit: 30`, not reachable from our config surface).
    // The overflow was rejected by `otlp-export-delegate` with
    // 'Concurrent export limit reached' and returned without retry or
    // requeue. This is the same defect the traces signal carried until
    // `SimpleSpanProcessor` was swapped out, and it is why the measured
    // live content distribution (137 tool_input / 116 tool_output) is a
    // count of survivors rather than of what was produced. Batching
    // turns that burst into one request, so the cap is never approached.
    processors: [new BatchLogRecordProcessor(exporter, {
      // Must hold a whole large turn between flushes. 2048 is the SDK
      // default and is far above the largest burst observed.
      maxQueueSize: 2048,
      // One request per 512 records instead of one per record.
      maxExportBatchSize: 512,
      // Every entry point force-flushes at its turn/session boundary, so
      // this only bounds the worst case where a process exits between
      // events.
      scheduledDelayMillis: 1000,
    })],
  });
}

/**
 * Flush the logger provider without ever throwing.
 *
 * Note the asymmetry with the traces SDK, because it is easy to get
 * backwards. `BatchSpanProcessorBase._flushOneBatch` REJECTS on a
 * non-SUCCESS export result, which is why `traces-collector`'s
 * `flushSpans` exists. `BatchLogRecordProcessor` does NOT: its
 * `_export` routes a failed result to `globalErrorHandler` and resolves
 * (`sdk-logs@0.214.0`, `BatchLogRecordProcessorBase.js:122-131`).
 * Verified rather than assumed — 40 records against a refused endpoint
 * resolve in ~30 ms.
 *
 * The rejection vector that DOES exist is the timeout:
 * `_flushOneBatch` wraps the export in `callWithTimeout(...,
 * exportTimeoutMillis)`, so an endpoint that accepts the connection and
 * never answers makes `forceFlush()` reject with 'Operation timed out'
 * (verified: rejects at the configured bound). Callers await this flush
 * on the host's turn and session boundaries, and a collector that hangs
 * must not take the Stop handler down with it — least of all on the
 * guard's deny close-out, whose whole point is to survive a broken
 * collector.
 *
 * Nothing is lost by swallowing: the underlying failure is already
 * audited by `instrumentExporter`, which reports every FAILED export as
 * an `otlp_export_failed` diagnostic with the endpoint in the hint.
 */
export async function flushLogRecords(provider: LoggerProvider): Promise<void> {
  try {
    await provider.forceFlush();
  } catch {
    // Already audited at the exporter. Telemetry must not throw.
  }
}

// ---------------------------------------------------------------------------
// Attribute projection (shared with traces signal where concepts overlap)
// ---------------------------------------------------------------------------

/**
 * Project an `AuditEntry` into the flat OTEL LogRecord attribute set.
 *
 * Cross-signal alignment:
 * - `tool_name`     → `gen_ai.tool.name`         (matches tool span)
 * - `tool_use_id`   → `gen_ai.tool.call.id`      (matches tool span)
 * - `session_id`    → `gen_ai.conversation.id` + `session.id` (matches turn span)
 * - `decision` / `risk_level` / `risk_score` / `risk_tags`
 *                   → `nioGuardAttributes(...)` from traces-collector
 *                     (produces `nio.guard.decision` etc. — matches the
 *                     OpenClaw tool span guard attrs)
 *
 * Nio-specific (no GenAI equivalent, kept under `nio.*`):
 * `nio.event`, `nio.event_type`, `nio.action_type`,
 * `nio.phase_stopped`, `nio.max_finding_severity`, `nio.explanation`,
 * `nio.phases.{name}.{score,finding_count,duration_ms}`, `nio.tool_summary`,
 * `nio.task_id`, `nio.task_summary`, `nio.cwd`, `nio.transcript_path`.
 */
export function auditEntryAttributes(entry: AuditEntry): Record<string, string | number> {
  const attrs: Record<string, string | number> = {
    'nio.event': entry.event,
  };

  // Tool identity (overlaps with tool span)
  const toolName = entry['tool_name'];
  if (typeof toolName === 'string') attrs['gen_ai.tool.name'] = toolName;

  const toolUseId = entry['tool_use_id'];
  if (typeof toolUseId === 'string') attrs['gen_ai.tool.call.id'] = toolUseId;

  // Session identity (overlaps with turn span)
  if (entry.session_id) {
    attrs['gen_ai.conversation.id'] = entry.session_id;
    attrs['session.id'] = entry.session_id;
  }

  // Guard decision attributes (shared helper from traces-collector)
  const decision = entry['decision'];
  const riskLevel = entry['risk_level'];
  const riskScore = entry['risk_score'];
  const riskTags = entry['risk_tags'];
  if (typeof decision === 'string' && typeof riskLevel === 'string') {
    const guard = nioGuardAttributes(
      decision,
      riskLevel,
      typeof riskScore === 'number' ? riskScore : 0,
      Array.isArray(riskTags) ? riskTags as string[] : undefined,
    );
    for (const [k, v] of Object.entries(guard)) {
      if (typeof v === 'string' || typeof v === 'number') attrs[k] = v;
    }
  }

  // Nio-specific extensions (no GenAI counterpart)
  const maxFindingSeverity = entry['max_finding_severity'];
  if (typeof maxFindingSeverity === 'string') attrs['nio.max_finding_severity'] = maxFindingSeverity;

  const phaseStopped = entry['phase_stopped'];
  if (typeof phaseStopped === 'number') attrs['nio.phase_stopped'] = phaseStopped;

  const actionType = entry['action_type'];
  if (typeof actionType === 'string') attrs['nio.action_type'] = actionType;

  const eventType = entry['event_type'];
  if (typeof eventType === 'string') attrs['nio.event_type'] = eventType;

  const explanation = entry['explanation'];
  if (typeof explanation === 'string') attrs['nio.explanation'] = explanation;

  // AuditHookEntry-only fields (PreToolUse / PostToolUse / TaskCreated etc.)
  const toolSummary = entry['tool_summary'];
  if (typeof toolSummary === 'string') attrs['nio.tool_summary'] = toolSummary;

  const taskId = entry['task_id'];
  if (typeof taskId === 'string') attrs['nio.task_id'] = taskId;

  const taskSummary = entry['task_summary'];
  if (typeof taskSummary === 'string') attrs['nio.task_summary'] = taskSummary;

  const cwd = entry['cwd'];
  if (typeof cwd === 'string') attrs['nio.cwd'] = cwd;

  const transcriptPath = entry['transcript_path'];
  if (typeof transcriptPath === 'string') attrs['nio.transcript_path'] = transcriptPath;

  // Per-phase breakdown (Nio-specific Phase 0–6 evaluation telemetry)
  const phases = entry['phases'];
  if (phases && typeof phases === 'object') {
    for (const [k, v] of Object.entries(phases as Record<string, { score: number; finding_count: number; duration_ms: number }>)) {
      if (v && typeof v === 'object') {
        attrs[`nio.phases.${k}.score`] = Math.round(v.score * 1000) / 1000;
        attrs[`nio.phases.${k}.finding_count`] = v.finding_count;
        attrs[`nio.phases.${k}.duration_ms`] = v.duration_ms;
      }
    }
  }

  return attrs;
}

// ---------------------------------------------------------------------------
// Emit audit log as OTEL LogRecord
// ---------------------------------------------------------------------------

/**
 * The (trace, span) pair a log record should be stamped with.
 *
 * Nio builds every span through `trace.setSpanContext(ROOT_CONTEXT, …)`
 * rather than by entering an active context (hook processes are short-
 * lived and the pre/post halves of a span live in different processes),
 * so there is never an ambient context for the logs SDK to pick up. The
 * association has to be passed in explicitly or the emitted record's
 * built-in `trace_id` / `span_id` fields stay empty.
 */
export interface LogSpanContext {
  traceId: string;
  spanId: string;
}

/**
 * Build the OTEL `Context` carrying `sc`, or undefined when either half
 * is missing. Returned as-is to `logger.emit({ context })`; the SDK
 * validates the ids and silently drops an invalid pair (all-zero or
 * malformed hex), which is exactly the behaviour we want — a bad id
 * must not become a fake association.
 */
function spanContextFor(sc?: LogSpanContext): Context | undefined {
  if (!sc || !sc.traceId || !sc.spanId) return undefined;
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: sc.traceId,
    spanId: sc.spanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });
}

export function emitAuditLog(
  provider: LoggerProvider,
  entry: AuditEntry,
  spanContext?: LogSpanContext,
): void {
  const logger = provider.getLogger('nio-audit', '1.0.0');
  const severityLevel = ('risk_level' in entry ? entry.risk_level : 'low') as string;
  const context = spanContextFor(spanContext);

  logger.emit({
    severityNumber: RISK_TO_SEVERITY[severityLevel] ?? SeverityNumber.INFO,
    severityText: severityLevel,
    body: JSON.stringify(entry),
    attributes: auditEntryAttributes(entry),
    ...(context ? { context } : {}),
  });
}

// ---------------------------------------------------------------------------
// Emit conversation content as OTEL LogRecords
// ---------------------------------------------------------------------------

/**
 * Send the content records built by `content/emit.ts`.
 *
 * Each record carries its own (traceId, spanId): chat content is stamped
 * with the chat span minted at end of turn, tool output with the tool
 * span id pre-allocated at PreToolUse. Both are set as the LogRecord's
 * built-in fields (via the explicit context) AND as plain string
 * attributes by the builder — see content/emit.ts for why that
 * redundancy is deliberate.
 */
export function emitContentRecords(
  provider: LoggerProvider,
  records: readonly ContentRecord[],
): void {
  if (records.length === 0) return;
  const logger = provider.getLogger('nio-content', '1.0.0');
  for (const record of records) {
    const context = spanContextFor({ traceId: record.traceId, spanId: record.spanId });
    logger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: 'low',
      body: record.body,
      attributes: record.attributes as unknown as Record<string, string | number | boolean>,
      ...(context ? { context } : {}),
    });
  }
}
