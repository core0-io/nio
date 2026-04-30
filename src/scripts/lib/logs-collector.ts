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

import { LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { OTLPLogExporter as OTLPLogExporterHttp } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPLogExporter as OTLPLogExporterGrpc } from '@opentelemetry/exporter-logs-otlp-grpc';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { Metadata } from '@grpc/grpc-js';
import type { CollectorConfig } from './config-loader.js';
import { nioGuardAttributes } from './traces-collector.js';

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

export function createLoggerProvider(config: CollectorConfig): LoggerProvider | null {
  if (!config.endpoint) return null;

  const headers: Record<string, string> = {};
  if (config.api_key) {
    headers['Authorization'] = `Bearer ${config.api_key}`;
  }

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

  return new LoggerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'nio' }),
    processors: [new SimpleLogRecordProcessor(exporter)],
  });
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
 * `nio.event`, `nio.platform`, `nio.event_type`, `nio.action_type`,
 * `nio.phase_stopped`, `nio.max_finding_severity`, `nio.explanation`,
 * `nio.phases.{name}.{score,finding_count,duration_ms}`, `nio.tool_summary`,
 * `nio.task_id`, `nio.task_summary`, `nio.cwd`, `nio.transcript_path`.
 */
export function auditEntryAttributes(entry: AuditEntry): Record<string, string | number> {
  const attrs: Record<string, string | number> = {
    'nio.event': entry.event,
    'nio.platform': entry.platform,
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

export function emitAuditLog(provider: LoggerProvider, entry: AuditEntry): void {
  const logger = provider.getLogger('nio-audit', '1.0.0');
  const severityLevel = ('risk_level' in entry ? entry.risk_level : 'low') as string;

  logger.emit({
    severityNumber: RISK_TO_SEVERITY[severityLevel] ?? SeverityNumber.INFO,
    severityText: severityLevel,
    body: JSON.stringify(entry),
    attributes: auditEntryAttributes(entry),
  });
}
