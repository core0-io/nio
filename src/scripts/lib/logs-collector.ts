export {};

/**
 * OTEL Logs Collector — exports audit log entries as OTEL LogRecords.
 *
 * Follows the same provider factory pattern as metrics-collector.ts and
 * traces-collector.ts. Reuses the same collector endpoint/auth config.
 */

import { LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { OTLPLogExporter as OTLPLogExporterHttp } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPLogExporter as OTLPLogExporterGrpc } from '@opentelemetry/exporter-logs-otlp-grpc';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { Metadata } from '@grpc/grpc-js';
import type { CollectorConfig } from './config-loader.js';

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
// Emit audit log as OTEL LogRecord
// ---------------------------------------------------------------------------

export function emitAuditLog(provider: LoggerProvider, entry: AuditEntry): void {
  const logger = provider.getLogger('nio-audit', '1.0.0');
  const severityLevel = ('risk_level' in entry ? entry.risk_level : 'low') as string;

  const attributes: Record<string, string | number> = {
    'nio.event': entry.event,
    'nio.platform': entry.platform,
  };

  const decision = entry['decision'];
  if (typeof decision === 'string') attributes['nio.decision'] = decision;

  const riskLevel = entry['risk_level'];
  if (typeof riskLevel === 'string') attributes['nio.risk_level'] = riskLevel;

  const maxFindingSeverity = entry['max_finding_severity'];
  if (typeof maxFindingSeverity === 'string') attributes['nio.max_finding_severity'] = maxFindingSeverity;

  const riskScore = entry['risk_score'];
  if (typeof riskScore === 'number') attributes['nio.risk_score'] = riskScore;

  const toolName = entry['tool_name'];
  if (typeof toolName === 'string') attributes['nio.tool_name'] = toolName;

  if (entry.session_id) attributes['nio.session_id'] = entry.session_id;

  const phaseStopped = entry['phase_stopped'];
  if (typeof phaseStopped === 'number') attributes['nio.phase_stopped'] = phaseStopped;

  const actionType = entry['action_type'];
  if (typeof actionType === 'string') attributes['nio.action_type'] = actionType;

  const eventType = entry['event_type'];
  if (typeof eventType === 'string') attributes['nio.event_type'] = eventType;

  const riskTags = entry['risk_tags'];
  if (Array.isArray(riskTags) && riskTags.length > 0) attributes['nio.risk_tags'] = riskTags.join(',');

  const explanation = entry['explanation'];
  if (typeof explanation === 'string') attributes['nio.explanation'] = explanation;

  const phases = entry['phases'];
  if (phases && typeof phases === 'object') {
    for (const [k, v] of Object.entries(phases as Record<string, { score: number; finding_count: number; duration_ms: number }>)) {
      if (v && typeof v === 'object') {
        attributes[`nio.phases.${k}.score`] = Math.round(v.score * 1000) / 1000;
        attributes[`nio.phases.${k}.finding_count`] = v.finding_count;
        attributes[`nio.phases.${k}.duration_ms`] = v.duration_ms;
      }
    }
  }

  logger.emit({
    severityNumber: RISK_TO_SEVERITY[severityLevel] ?? SeverityNumber.INFO,
    severityText: severityLevel,
    body: JSON.stringify(entry),
    attributes,
  });
}
