// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

// ---------------------------------------------------------------------------
// Metrics Schema
// All metric names, descriptions, units, and label documentation in one place.
// ---------------------------------------------------------------------------

export const METRICS_SCHEMA = {
  toolUseCount: {
    name: 'nio.tool_use.count',
    description: 'Number of tool invocations captured by Nio (includes Task events)',
    unit: '{invocations}',
    labels: {
      'gen_ai.tool.name': 'Name of the tool being invoked (Bash, Write, Edit, WebFetch, Agent, etc.). Matches the tool-span attribute in the traces signal.',
      'nio.event': 'Hook event name (PreToolUse, PostToolUse, TaskCreated, TaskCompleted)',
    },
  },
  turnCount: {
    name: 'nio.turn.count',
    description: 'Number of conversation turns completed (Stop or SubagentStop events)',
    unit: '{turns}',
    labels: {},
  },
  decisionCount: {
    name: 'nio.decision.count',
    description: 'Number of guard decisions by outcome',
    unit: '{decisions}',
    labels: {
      'nio.guard.decision': 'Guard decision (allow, deny, ask). Matches the tool-span guard attribute via nioGuardAttributes().',
      'nio.guard.risk_level': 'Risk level (low, medium, high, critical). Matches the tool-span guard attribute.',
      'gen_ai.tool.name': 'Name of the tool being evaluated. Matches the tool-span attribute.',
    },
  },
  riskScore: {
    name: 'nio.risk.score',
    description: 'Risk score distribution for guard evaluations (0–1)',
    unit: '{score}',
    labels: {
      'gen_ai.tool.name': 'Name of the tool being evaluated',
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
import { collectorRequestHeaders, type CollectorConfig } from './config-loader.js';
import { buildNioResource } from './traces-collector.js';
import { instrumentExporter } from './exporter-diagnostics.js';

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export function createMeterProvider(
  config: CollectorConfig,
  platform: string,
  agentName?: string,
): MeterProvider | null {
  if (!config.endpoint) return null;
  if (!config.metrics_enabled) return null;

  const headers = collectorRequestHeaders(config);

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
  instrumentExporter(exporter, 'metrics', config.endpoint);

  return new MeterProvider({
    resource: buildNioResource(platform, agentName),
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

/**
 * Per-call knob for the trailing `provider.forceFlush()`.
 *
 * ── Why any caller would say `flush: false` ───────────────────────────
 *
 * `counter.add()` is synchronous and lands the point in the reader's
 * aggregator immediately; the `forceFlush()` that follows is only about
 * getting it onto the WIRE early. On the fork-per-event hooks that early
 * flush is pure cost, because every one of them ends with its own
 * budgeted `meterProvider.forceFlush()` before `process.exit()` — the
 * point ships either way.
 *
 * The cost is not theoretical. Against an OTLP endpoint that accepts the
 * connection and never answers, one of these flushes takes
 * `collector.timeout + ~1s` (measured: 5.07s refused / 5.21s stalled per
 * `dispatchCollectorEvent`, `collector.timeout: 5000`). Since the whole
 * dispatch runs inside ONE shared flush budget (lib/flush-budget.ts), a
 * metrics flush sitting mid-branch spends the entire budget and the
 * caller abandons the dispatch before the work AFTER it can run. Measured
 * end-to-end on `SessionEnd` with metrics stalled and traces healthy: the
 * session span never reached `/v1/traces` and the session's state shard
 * was never discarded, because `recordTurn` sits between `endTurn` and
 * `emitSessionSpan` / `discardState`.
 *
 * So: telemetry that is merely *early* must never outrank telemetry that
 * is *correct*. Callers that already own a closing flush pass
 * `flush: false`; callers that do not (the in-process runtime, which has
 * no process exit to flush at) keep the default.
 */
export interface RecordOptions {
  /** Await `provider.forceFlush()` after recording. Default `true`. */
  flush?: boolean;
}

export async function recordToolUse(
  provider: MeterProvider,
  toolName: string,
  event: string,
  options: RecordOptions = {},
): Promise<void> {
  const meter = provider.getMeter('nio-collector', '1.0.0');
  const counter = meter.createCounter(METRICS_SCHEMA.toolUseCount.name, {
    description: METRICS_SCHEMA.toolUseCount.description,
    unit: METRICS_SCHEMA.toolUseCount.unit,
  });
  counter.add(1, {
    'gen_ai.tool.name': toolName,
    'nio.event': event,
  });
  if (options.flush === false) return;
  await provider.forceFlush();
}


export async function recordGuardDecision(
  provider: MeterProvider,
  decision: string,
  riskLevel: string,
  riskScore: number,
  toolName: string,
): Promise<void> {
  const meter = provider.getMeter('nio-collector', '1.0.0');

  const counter = meter.createCounter(METRICS_SCHEMA.decisionCount.name, {
    description: METRICS_SCHEMA.decisionCount.description,
    unit: METRICS_SCHEMA.decisionCount.unit,
  });
  counter.add(1, {
    'nio.guard.decision': decision,
    'nio.guard.risk_level': riskLevel,
    'gen_ai.tool.name': toolName,
  });

  const histogram = meter.createHistogram(METRICS_SCHEMA.riskScore.name, {
    description: METRICS_SCHEMA.riskScore.description,
    unit: METRICS_SCHEMA.riskScore.unit,
  });
  histogram.record(riskScore, {
    'gen_ai.tool.name': toolName,
  });

  await provider.forceFlush();
}


export async function recordTurn(
  provider: MeterProvider,
  options: RecordOptions = {},
): Promise<void> {
  const meter = provider.getMeter('nio-collector', '1.0.0');
  const counter = meter.createCounter(METRICS_SCHEMA.turnCount.name, {
    description: METRICS_SCHEMA.turnCount.description,
    unit: METRICS_SCHEMA.turnCount.unit,
  });
  counter.add(1);
  if (options.flush === false) return;
  await provider.forceFlush();
}
