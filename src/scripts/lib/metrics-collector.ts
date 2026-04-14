export {};

// ---------------------------------------------------------------------------
// Metrics Schema
// All metric names, descriptions, units, and label documentation in one place.
// ---------------------------------------------------------------------------

export const METRICS_SCHEMA = {
  toolUseCount: {
    name: 'agentguard.tool_use.count',
    description: 'Number of tool invocations captured by AgentGuard (includes Task events)',
    unit: '{invocations}',
    labels: {
      tool_name: 'Name of the tool being invoked (Bash, Write, Edit, WebFetch, Task, etc.)',
      event: 'Hook event name (PreToolUse, PostToolUse, TaskCreated, TaskCompleted)',
      platform: 'Runtime platform identifier passed via --platform argument',
    },
  },
  turnCount: {
    name: 'agentguard.turn.count',
    description: 'Number of conversation turns completed (Stop or SubagentStop events)',
    unit: '{turns}',
    labels: {
      platform: 'Runtime platform identifier',
    },
  },
  decisionCount: {
    name: 'agentguard.decision.count',
    description: 'Number of guard decisions by outcome',
    unit: '{decisions}',
    labels: {
      decision: 'Guard decision (allow, deny, ask)',
      risk_level: 'Risk level (low, medium, high, critical)',
      tool_name: 'Name of the tool being evaluated',
      platform: 'Runtime platform identifier',
    },
  },
  riskScore: {
    name: 'agentguard.risk.score',
    description: 'Risk score distribution for guard evaluations (0–1)',
    unit: '{score}',
    labels: {
      tool_name: 'Name of the tool being evaluated',
      platform: 'Runtime platform identifier',
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter as OTLPMetricExporterHttp } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPMetricExporter as OTLPMetricExporterGrpc } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { Metadata } from '@grpc/grpc-js';
import type { CollectorConfig } from './config-loader.js';

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export function createMeterProvider(config: CollectorConfig): MeterProvider | null {
  if (!config.endpoint) return null;

  const headers: Record<string, string> = {};
  if (config.api_key) {
    headers['Authorization'] = `Bearer ${config.api_key}`;
  }

  const base = config.endpoint.replace(/\/$/, '');
  const metricsUrl = config.protocol === 'grpc' ? base : `${base}/v1/metrics`;

  let exporter;
  if (config.protocol === 'grpc') {
    const grpcMetadata = new Metadata();
    for (const [k, v] of Object.entries(headers)) {
      grpcMetadata.set(k, v);
    }
    exporter = new OTLPMetricExporterGrpc({
      url: metricsUrl,
      metadata: grpcMetadata,
      timeoutMillis: config.timeout,
    });
  } else {
    exporter = new OTLPMetricExporterHttp({
      url: metricsUrl,
      headers,
      timeoutMillis: config.timeout,
    });
  }

  return new MeterProvider({
    readers: [
      new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: 1000,
      }),
    ],
  });
}

// ---------------------------------------------------------------------------
// Record functions
// ---------------------------------------------------------------------------

export async function recordToolUse(
  provider: MeterProvider,
  toolName: string,
  event: string,
  platform: string,
): Promise<void> {
  const meter = provider.getMeter('agentguard-collector', '1.0.0');
  const counter = meter.createCounter(METRICS_SCHEMA.toolUseCount.name, {
    description: METRICS_SCHEMA.toolUseCount.description,
    unit: METRICS_SCHEMA.toolUseCount.unit,
  });
  counter.add(1, {
    'agentguard.tool_name': toolName,
    'agentguard.event': event,
    'agentguard.platform': platform,
  });
  await provider.forceFlush();
}


export async function recordGuardDecision(
  provider: MeterProvider,
  decision: string,
  riskLevel: string,
  riskScore: number,
  toolName: string,
  platform: string,
): Promise<void> {
  const meter = provider.getMeter('agentguard-collector', '1.0.0');

  const counter = meter.createCounter(METRICS_SCHEMA.decisionCount.name, {
    description: METRICS_SCHEMA.decisionCount.description,
    unit: METRICS_SCHEMA.decisionCount.unit,
  });
  counter.add(1, {
    'agentguard.decision': decision,
    'agentguard.risk_level': riskLevel,
    'agentguard.tool_name': toolName,
    'agentguard.platform': platform,
  });

  const histogram = meter.createHistogram(METRICS_SCHEMA.riskScore.name, {
    description: METRICS_SCHEMA.riskScore.description,
    unit: METRICS_SCHEMA.riskScore.unit,
  });
  histogram.record(riskScore, {
    'agentguard.tool_name': toolName,
    'agentguard.platform': platform,
  });

  await provider.forceFlush();
}


export async function recordTurn(
  provider: MeterProvider,
  platform: string,
): Promise<void> {
  const meter = provider.getMeter('agentguard-collector', '1.0.0');
  const counter = meter.createCounter(METRICS_SCHEMA.turnCount.name, {
    description: METRICS_SCHEMA.turnCount.description,
    unit: METRICS_SCHEMA.turnCount.unit,
  });
  counter.add(1, {
    'agentguard.platform': platform,
  });
  await provider.forceFlush();
}
