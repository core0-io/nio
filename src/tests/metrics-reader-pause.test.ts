// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Pausing the metrics export timer.
 *
 * THE DEFECT — the "KNOWN RESIDUAL LIMITATION" in plugin-runtime.ts
 *
 * `createMeterProvider` installs a reader with `exportIntervalMillis:
 * 1000`. Metric temporality is CUMULATIVE, so every tick re-sends the
 * running total whether or not anything new was recorded. Deferring the
 * provider's creation until the first monitored use fixed the
 * never-armed host; it did nothing for a host armed once and then
 * disarmed. Measured on a live machine after `/nio monitor off`:
 * `nio.turn.count` held a constant value of 5 while a new sample landed
 * every second, 163 series in parallel, until the process was killed.
 *
 * The gate stops the RECORDING leg. Nothing stopped the EXPORT leg.
 *
 * WHAT MUST NOT BE THE FIX
 *
 * `reader.shutdown()` also calls `exporter.shutdown()`, which is
 * terminal: re-arming would need a whole new provider, and the counters
 * would restart from zero — a cumulative reset the backend reads as a
 * new series. Stopping the timer alone leaves the accumulated totals
 * intact, so `/nio monitor on` resumes the same curve.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { MeterProvider } from '@opentelemetry/sdk-metrics';

import {
  PausableExportingMetricReader,
} from '../scripts/lib/metrics-collector.js';

/** Records every export the reader pushes, so ticks can be counted. */
class SpyExporter {
  exports = 0;
  shutdownCalls = 0;

  export(_items: unknown, resultCallback: (r: ExportResult) => void): void {
    this.exports++;
    resultCallback({ code: ExportResultCode.SUCCESS });
  }
  async forceFlush(): Promise<void> { /* nothing buffered */ }
  async shutdown(): Promise<void> { this.shutdownCalls++; }
  selectAggregationTemporality(): number { return 1; /* CUMULATIVE */ }
}

let providers: MeterProvider[] = [];

function build(intervalMs: number): { provider: MeterProvider; reader: PausableExportingMetricReader; exporter: SpyExporter } {
  const exporter = new SpyExporter();
  const reader = new PausableExportingMetricReader({
    exporter: exporter as never,
    exportIntervalMillis: intervalMs,
  });
  const provider = new MeterProvider({ readers: [reader] });
  providers.push(provider);
  // A counter with a value, so every tick has something to re-send.
  provider.getMeter('test').createCounter('nio.test.count').add(5);
  return { provider, reader, exporter };
}

/** Let the interval fire a few times. */
function ticks(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

afterEach(async () => {
  for (const p of providers) {
    try { await p.shutdown(); } catch { /* already down */ }
  }
  providers = [];
});

describe('PausableExportingMetricReader', () => {
  it('exports on a timer while running', async () => {
    const { exporter } = build(20);

    await ticks(120);

    assert.ok(exporter.exports >= 2, `expected repeated exports, got ${exporter.exports}`);
  });

  it('stops exporting once paused', async () => {
    const { reader, exporter } = build(20);
    await ticks(80);

    await reader.pause();
    const afterPause = exporter.exports;
    await ticks(120);

    assert.equal(exporter.exports, afterPause,
      'a paused reader must not put anything else on the wire');
  });

  it('flushes once on the way down, so nothing recorded is stranded', async () => {
    const { reader, exporter } = build(10_000); // never ticks on its own
    assert.equal(exporter.exports, 0, 'sanity: the timer has not fired');

    await reader.pause();

    assert.ok(exporter.exports >= 1,
      'pausing must ship what was already recorded rather than strand it');
  });

  it('does not shut the exporter down — pausing is reversible', async () => {
    const { reader, exporter } = build(20);

    await reader.pause();

    assert.equal(exporter.shutdownCalls, 0,
      'the export channel stays open, which is what makes resume possible');
  });

  it('resumes exporting on the same provider', async () => {
    const { reader, exporter } = build(20);
    await reader.pause();
    const afterPause = exporter.exports;

    reader.resume();
    await ticks(120);

    assert.ok(exporter.exports > afterPause, 'the timer is running again');
  });

  it('is idempotent — pausing twice, resuming twice', async () => {
    const { reader, exporter } = build(20);

    await reader.pause();
    await reader.pause();
    const afterPause = exporter.exports;
    await ticks(80);
    assert.equal(exporter.exports, afterPause, 'still paused after a second pause');

    reader.resume();
    reader.resume();
    await ticks(120);
    const running = exporter.exports;
    await ticks(120);
    assert.ok(exporter.exports > running,
      'a double resume leaves exactly one timer running, still ticking');
  });

  it('keeps the accumulated total across a pause/resume cycle', async () => {
    // The property that makes this preferable to shutting the provider
    // down: cumulative counters are not reset, so the backend sees one
    // continuous series rather than a restart at zero.
    const { provider, reader, exporter } = build(20);
    await reader.pause();

    provider.getMeter('test').createCounter('nio.test.count').add(3);
    reader.resume();
    await ticks(120);

    const collected = await reader.collect();
    const metric = collected.resourceMetrics.scopeMetrics
      .flatMap(s => s.metrics)
      .find(m => m.descriptor.name === 'nio.test.count');
    assert.ok(metric, 'the counter survived the cycle');
    assert.equal((metric.dataPoints[0] as { value: number }).value, 8,
      '5 recorded before the pause + 3 after = 8, not a reset to 3');
    assert.ok(exporter.exports > 0);
  });
});
