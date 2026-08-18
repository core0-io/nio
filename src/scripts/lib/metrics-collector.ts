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
 * caller abandons the dispatch. What the caller abandons with it is its
 * own closing `Promise.all([...forceFlush])` — so a stalled METRICS
 * endpoint costs the turn its SPANS on a traces endpoint that is working
 * perfectly.
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

/**
 * Coalescing state for one MeterProvider's flushes. Keyed by provider so
 * the fork-per-event hooks (a fresh provider per process) and the
 * in-process runtime (one provider for the host's life) share the code
 * without sharing state.
 */
interface FlushState {
  /** The flush currently on the wire, as a promise that never rejects. */
  active: Promise<void> | null;
  /** The single queued follow-up flush shared by every waiting caller. */
  queued: Promise<void> | null;
}

const flushStates = new WeakMap<MeterProvider, FlushState>();

function flushStateFor(provider: MeterProvider): FlushState {
  let state = flushStates.get(provider);
  if (!state) {
    state = { active: null, queued: null };
    flushStates.set(provider, state);
  }
  return state;
}

function startFlush(provider: MeterProvider, state: FlushState): Promise<void> {
  const flush = provider.forceFlush();
  // Bookkeeping rides a swallowed copy: a rejected flush must reach the
  // CALLER (which is what decides whether to report it) without the state
  // machine's own handle surfacing as an unhandled rejection.
  const settled = flush.then(() => {}, () => {});
  state.active = settled;
  void settled.then(() => {
    if (state.active === settled) state.active = null;
  });
  return flush;
}

/**
 * `provider.forceFlush()`, with concurrent calls collapsed.
 *
 * ── The problem ───────────────────────────────────────────────────────
 *
 * `otlp-exporter-base` caps in-flight exports at 30
 * (`shared-configuration.js`, `concurrencyLimit: 30`) and
 * `otlp-export-delegate.js` REJECTS the overflow outright —
 * `'Concurrent export limit reached'` — without retrying or queueing.
 * Nothing reaches the network on that path, so the endpoint's health is
 * irrelevant to the failure.
 *
 * `InProcessPluginRuntime` issues two fire-and-forget metric flushes per
 * tool event (`recordToolUse('PreToolUse')` and `recordGuardDecision`,
 * neither awaited) plus one awaited on the post side, all against ONE
 * provider cached for the host process's life. Overlapping tool events
 * therefore stack unawaited flushes on a single exporter. Measured over
 * 20 overlapping tool events against a sink that answered 200 to every
 * request: peak 30 in-flight exports and `Concurrent export limit
 * reached` rejections — against a perfectly healthy endpoint, because
 * nothing on that path ever reached the network.
 *
 * The fork-per-event hooks never hit this — each is its own process with
 * its own exporter, and their flushes are awaited in sequence (measured
 * peak in-flight: 1).
 *
 * ── Why collapsing them is safe ───────────────────────────────────────
 *
 * Metric temporality is CUMULATIVE (nothing in this file configures a
 * `temporalitySelector`, so the OTLP exporters' default stands). Every
 * export carries the running total, which means a later export
 * SUPERSEDES an earlier one completely and an export that never happened
 * is never lost data. Under delta temporality this would be wrong, and
 * that is a standing reason not to switch: delta would trade a bounded
 * duplicate for an unbounded gap.
 *
 * ── Why it is still correct, not merely cheaper ───────────────────────
 *
 * Leading + trailing, not debounce. The first call flushes immediately,
 * so the early-ship intent `RecordOptions.flush` documents is untouched.
 * A call that arrives while a flush is in flight does not silently ride
 * that flush — it joins a single QUEUED flush that starts after the
 * active one settles. So every point is covered by a flush that STARTED
 * after `counter.add()` recorded it, which is the property a caller
 * awaiting `recordToolUse` is entitled to.
 *
 * Nothing here weakens the crash case either: the reader's own
 * `PeriodicExportingMetricReader` still ticks every second, and the hooks
 * still run their budgeted closing `forceFlush()` before `process.exit()`.
 */
export function flushMetrics(provider: MeterProvider): Promise<void> {
  const state = flushStateFor(provider);
  if (state.active === null) return startFlush(provider, state);
  if (state.queued !== null) return state.queued;

  const queued = state.active.then(() => {
    // This flush is the active one from here on; the next caller queues
    // behind it rather than joining a slot that has already been used.
    state.queued = null;
    return startFlush(provider, state);
  });
  state.queued = queued;
  return queued;
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
  await flushMetrics(provider);
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

  await flushMetrics(provider);
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
  await flushMetrics(provider);
}
