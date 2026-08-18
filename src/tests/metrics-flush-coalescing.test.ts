// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Metrics flush coalescing — concurrent record calls must not fill the
 * OTLP exporter's 30-slot in-flight queue.
 *
 * Why this test does NOT use an in-memory exporter
 * ----------------------------------------------
 * The defect is not in what we record; it is in how many exports we hand
 * the OTLP exporter at once. `InMemoryMetricExporter` has no concurrency
 * limit, so an in-memory version of this test passes both before and
 * after the fix — it cannot express the failing condition. Same trap
 * `trace-export-capacity.test.ts` documents.
 *
 * So the provider under test is the real one (`createMeterProvider`),
 * with the real `@opentelemetry/exporter-metrics-otlp-http` exporter,
 * pointed at a local HTTP server that ACCEPTS the request, reads the
 * whole body, and answers 200 after a short delay. A healthy endpoint —
 * every request succeeds — which is the point: the failure below is
 * entirely self-inflicted.
 *
 * The failing condition is the in-process runtime's call pattern.
 * `InProcessPluginRuntime` issues two FIRE-AND-FORGET metric flushes per
 * tool event (`recordToolUse('PreToolUse')` and `recordGuardDecision`,
 * both `.catch()`ed, neither awaited) plus one awaited on the post side,
 * against ONE MeterProvider cached for the whole host process. When tool
 * events overlap — concurrent tool calls, or simply a host that fires the
 * next pre-event before the previous flush resolves — those unawaited
 * flushes stack up on a single exporter.
 *
 * Measured before the fix, 20 overlapping tool events against a sink that
 * answers 200 for everything:
 *
 *   peak in-flight exports  30   (exactly `concurrencyLimit`)
 *   'Concurrent export limit reached' diagnostics    4
 *
 * i.e. nio filled its own exporter's queue and lost points against a
 * healthy endpoint — no request for those ever reached the network.
 *
 * The fix is leading+trailing coalescing, which is safe here for one
 * specific reason: metric temporality is CUMULATIVE. Every export carries
 * the running total, so a later export supersedes an earlier one
 * completely and a coalesced-away export is never lost data. The trailing
 * flush is what makes it correct rather than merely cheaper: a point
 * recorded while an export was already in flight is guaranteed a flush
 * that STARTS after it was recorded.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createMeterProvider,
  recordToolUse,
  recordGuardDecision,
} from '../scripts/lib/metrics-collector.js';
import type { CollectorConfig } from '../scripts/lib/config-loader.js';
import { _setDiagnosticsAuditPathForTests } from '../adapters/diagnostics.js';
import { trackTempDir } from './helpers/tmp-dirs.js';

/** How many overlapping tool events to simulate. */
const TOOL_EVENTS = 20;

/**
 * Sink latency. Zero also reproduces the failure, but a small delay makes
 * the in-flight window observable rather than a scheduling accident.
 */
const SINK_DELAY_MS = 50;

/**
 * `otlp-exporter-base`'s default `concurrencyLimit` is 30. Staying well
 * under it is the property; the exact ceiling below is deliberately loose
 * so the test pins "does not stack up" rather than an implementation's
 * exact flush count.
 */
const MAX_ACCEPTABLE_IN_FLIGHT = 5;

const auditDir = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-metrics-coalesce-')));
const auditPath = join(auditDir, 'audit.jsonl');
_setDiagnosticsAuditPathForTests(auditPath);

after(() => {
  _setDiagnosticsAuditPathForTests(null);
  try { rmSync(auditDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

interface SinkState {
  server: Server;
  port: number;
  requests: number;
  peakInFlight: number;
  bodies: Buffer[];
  /**
   * Tear the sink down for real: destroy every socket the exporter's
   * keep-alive agent is still holding, THEN await `server.close()`.
   *
   * A bare `server.close()` neither drops those sockets nor waits, so a
   * meter provider that outlives it keeps its 1 s
   * `PeriodicExportingMetricReader` connecting into a dead port — a ref'd
   * libuv handle per attempt, and the `node --test` worker never exits.
   * That is the exact leak `plugin-runtime-provider-lifetime.test.ts`
   * exists to prevent; this file must not reintroduce it.
   */
  close(): Promise<void>;
}

async function startSink(delayMs: number): Promise<SinkState> {
  const state: Partial<SinkState> & { requests: number; peakInFlight: number; bodies: Buffer[] } = {
    requests: 0,
    peakInFlight: 0,
    bodies: [],
  };
  let inFlight = 0;
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    inFlight += 1;
    state.requests += 1;
    if (inFlight > state.peakInFlight) state.peakInFlight = inFlight;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      state.bodies.push(Buffer.concat(chunks));
      setTimeout(() => {
        inFlight -= 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      }, delayMs);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.server = server;
  state.port = (server.address() as AddressInfo).port;
  state.close = async (): Promise<void> => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return state as SinkState;
}

function configFor(port: number): CollectorConfig {
  return {
    endpoint: `http://127.0.0.1:${port}`,
    api_key: '',
    headers: {},
    timeout: 5000,
    protocol: 'http',
    metrics_enabled: true,
    traces_enabled: false,
    logs_enabled: false,
    enabled: true,
  } as unknown as CollectorConfig;
}

/** Read the diagnostics the run wrote, as raw lines. */
function diagnosticLines(): string[] {
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, 'utf8').split('\n').filter((l) => l.trim().length > 0);
}

/** Total of every `nio.tool_use.count` data point in the last body seen. */
function lastToolUseTotal(bodies: Buffer[]): number {
  for (let i = bodies.length - 1; i >= 0; i -= 1) {
    let text: string;
    try {
      text = gunzipSync(bodies[i]!).toString('utf8');
    } catch {
      text = bodies[i]!.toString('utf8');
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { continue; }
    let total = 0;
    let found = false;
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (!node || typeof node !== 'object') return;
      const obj = node as Record<string, unknown>;
      if (obj.name === 'nio.tool_use.count') {
        // OTLP/JSON writes an integer counter as `asDouble` here; `asInt`
        // is the other legal encoding, so read whichever is present.
        const sum = obj.sum as {
          aggregationTemporality?: number;
          dataPoints?: Array<{ asInt?: string | number; asDouble?: number }>;
        } | undefined;
        // 2 = AGGREGATION_TEMPORALITY_CUMULATIVE. Coalescing is only sound
        // under cumulative totals, so pin it: a switch to delta must break
        // this test rather than silently turn dropped exports into gaps.
        assert.equal(
          sum?.aggregationTemporality,
          2,
          'metrics must be exported with CUMULATIVE temporality for flush coalescing to be lossless',
        );
        for (const dp of sum?.dataPoints ?? []) {
          found = true;
          total += Number(dp.asInt ?? dp.asDouble ?? 0);
        }
      }
      Object.values(obj).forEach(walk);
    };
    walk(parsed);
    if (found) return total;
  }
  return -1;
}

describe('metrics flush coalescing', () => {
  it('does not stack concurrent exports against the exporter concurrency limit', async () => {
    const sink = await startSink(SINK_DELAY_MS);
    const provider = createMeterProvider(configFor(sink.port), 'openclaw', 'coalesce-test');
    try {
      assert.ok(provider, 'meter provider must be built for a configured endpoint');

      // The in-process runtime's per-tool-event pattern, with events
      // overlapping: two unawaited flushes plus one awaited, none of which
      // waits for the previous event.
      const pending: Array<Promise<unknown>> = [];
      for (let i = 0; i < TOOL_EVENTS; i += 1) {
        pending.push(recordToolUse(provider!, 'Bash', 'PreToolUse').catch(() => {}));
        pending.push(recordGuardDecision(provider!, 'allow', 'low', 0.1, 'Bash').catch(() => {}));
        pending.push(recordToolUse(provider!, 'Bash', 'PostToolUse').catch(() => {}));
      }
      await Promise.all(pending);

      const lines = diagnosticLines();
      const concurrencyRejections = lines.filter((l) => l.includes('Concurrent export limit reached'));

      assert.equal(
        concurrencyRejections.length,
        0,
        `exporter refused ${concurrencyRejections.length} export(s) for a full in-flight queue against a healthy sink`,
      );
      assert.ok(
        sink.peakInFlight <= MAX_ACCEPTABLE_IN_FLIGHT,
        `peak in-flight metrics exports was ${sink.peakInFlight}, expected <= ${MAX_ACCEPTABLE_IN_FLIGHT}`,
      );
    } finally {
      await provider?.shutdown().catch(() => {});
      await sink.close();
    }
  });

  it('still puts every recorded point on the wire', async () => {
    const sink = await startSink(SINK_DELAY_MS);
    const provider = createMeterProvider(configFor(sink.port), 'openclaw', 'coalesce-total');
    try {
      assert.ok(provider);

      const pending: Array<Promise<unknown>> = [];
      for (let i = 0; i < TOOL_EVENTS; i += 1) {
        pending.push(recordToolUse(provider!, 'Bash', 'PreToolUse').catch(() => {}));
        pending.push(recordToolUse(provider!, 'Bash', 'PostToolUse').catch(() => {}));
      }
      await Promise.all(pending);

      const total = lastToolUseTotal(sink.bodies);

      // Cumulative temporality: the last export carries the running total,
      // so coalescing must not cost a single increment.
      assert.equal(
        total,
        TOOL_EVENTS * 2,
        `last exported nio.tool_use.count total was ${total}, expected ${TOOL_EVENTS * 2}`,
      );
      assert.ok(sink.requests > 0, 'at least one export must reach the sink');
    } finally {
      await provider?.shutdown().catch(() => {});
      await sink.close();
    }
  });

  it('gives a point recorded during an in-flight export its own flush', async () => {
    // The correctness half of coalescing, and the one a "just join the
    // export already in flight" implementation gets wrong. That export has
    // ALREADY collected from the reader, so a point recorded after it
    // started is not in its body — joining it would report success for a
    // point still sitting in the aggregator, invisible until the 1 Hz
    // reader tick. Leading+trailing must start a SECOND export instead.
    const sink = await startSink(200);
    const provider = createMeterProvider(configFor(sink.port), 'openclaw', 'coalesce-trailing');
    try {
      assert.ok(provider);

      // First point, flush started and deliberately not awaited.
      const first = recordToolUse(provider!, 'Bash', 'PreToolUse').catch(() => {});
      // Let that export collect and reach the sink before recording again.
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(sink.requests >= 1, 'the first export should already be in flight');

      // Second point, recorded while the first export is still unanswered.
      await recordToolUse(provider!, 'Bash', 'PostToolUse').catch(() => {});
      await first;

      const total = lastToolUseTotal(sink.bodies);
      const elapsed = sink.bodies.length;

      // Well inside the reader's 1000 ms interval, so nothing here can be
      // credited to the periodic tick — only to the trailing flush.
      assert.equal(
        total,
        2,
        `the second point never reached the wire (last exported total ${total} over ${elapsed} export(s));`
        + ' a flush that started before it was recorded cannot speak for it',
      );
    } finally {
      await provider?.shutdown().catch(() => {});
      await sink.close();
    }
  });

  it('keeps flushing after a coalesced burst has settled', async () => {
    // The queued slot has to be RELEASED once its flush starts. A version
    // that leaves the slot occupied hands every later caller an
    // already-resolved promise and silently stops flushing for the rest of
    // the host process's life — which on the in-process hosts is hours.
    const sink = await startSink(SINK_DELAY_MS);
    const provider = createMeterProvider(configFor(sink.port), 'openclaw', 'coalesce-after-burst');
    try {
      assert.ok(provider);

      const burst: Array<Promise<unknown>> = [];
      for (let i = 0; i < TOOL_EVENTS; i += 1) {
        burst.push(recordToolUse(provider!, 'Bash', 'PreToolUse').catch(() => {}));
      }
      await Promise.all(burst);

      const afterBurst = sink.requests;

      // Now repeat the in-flight case from the previous test, but with the
      // queued slot already used once. This is what distinguishes releasing
      // the slot from merely filling it: a stale non-null `queued` makes
      // every later caller receive an already-resolved promise.
      const leading = recordToolUse(provider!, 'Bash', 'PostToolUse').catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 50));
      await recordToolUse(provider!, 'Bash', 'PostToolUse').catch(() => {});
      await leading;

      const total = lastToolUseTotal(sink.bodies);
      const requests = sink.requests;

      assert.ok(
        requests > afterBurst,
        `no export was issued for the points recorded after the burst (${requests} total, ${afterBurst} before them)`,
      );
      assert.equal(
        total,
        TOOL_EVENTS + 2,
        `last exported total was ${total}, expected ${TOOL_EVENTS + 2};`
        + ' the queued flush slot was not released after its flush started',
      );
    } finally {
      await provider?.shutdown().catch(() => {});
      await sink.close();
    }
  });

  it('sends far fewer exports than it received record calls', async () => {
    const sink = await startSink(SINK_DELAY_MS);
    const provider = createMeterProvider(configFor(sink.port), 'openclaw', 'coalesce-count');
    try {
      assert.ok(provider);

      const pending: Array<Promise<unknown>> = [];
      for (let i = 0; i < TOOL_EVENTS; i += 1) {
        pending.push(recordToolUse(provider!, 'Bash', 'PreToolUse').catch(() => {}));
        pending.push(recordGuardDecision(provider!, 'allow', 'low', 0.1, 'Bash').catch(() => {}));
        pending.push(recordToolUse(provider!, 'Bash', 'PostToolUse').catch(() => {}));
      }
      await Promise.all(pending);

      const requests = sink.requests;

      // 60 record calls; without coalescing that is 60 export attempts (30
      // on the wire, the rest refused). Coalescing collapses the overlapping
      // ones. The bound is loose on purpose — the property is "collapses",
      // not an exact count.
      assert.ok(
        requests <= 10,
        `${requests} exports reached the sink for ${TOOL_EVENTS * 3} record calls; expected them to collapse`,
      );
    } finally {
      await provider?.shutdown().catch(() => {});
      await sink.close();
    }
  });
});
