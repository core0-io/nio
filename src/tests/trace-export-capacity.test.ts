// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Trace export capacity — a turn with more than 30 spans must still put
 * every span, root included, on the wire.
 *
 * Why this test does NOT use `makeInMemoryTracer`
 * ----------------------------------------------
 * The defect is not in our span construction; it is in how the spans are
 * handed to the OTLP exporter. `InMemorySpanExporter` has no concurrency
 * limit at all, so an in-memory version of this test passes both before
 * and after the fix — it cannot express the failing condition. That is
 * exactly the trap this test exists to avoid.
 *
 * So the provider under test is the real one (`createTracerProvider`),
 * with the real `@opentelemetry/exporter-trace-otlp-http` exporter,
 * pointed at a local HTTP server that ACCEPTS the connection, reads the
 * whole request body, and then never responds. That keeps every export
 * "in flight" for the duration of the test, which is what reproduces the
 * live failure:
 *
 *   - `SimpleSpanProcessor` starts one export per `span.end()`.
 *   - `endTurn` ends the whole tree in one synchronous burst, root LAST.
 *   - `otlp-exporter-base`'s promise queue caps in-flight exports at 30
 *     (`shared-configuration.js`: `concurrencyLimit: 30`).
 *   - `otlp-export-delegate.js` rejects the overflow with
 *     'Concurrent export limit reached' and returns — no retry, no queue.
 *
 * Result before the fix: exactly 30 spans reach the server and the turn
 * root, ended last, is never sent. That is the shape observed live:
 * traces of exactly 30 spans with 0 roots, every one of them naming a
 * parent the backend never received.
 *
 * The burst is built from CHAT calls rather than tool calls because
 * `recordPostToolUse` emits and flushes each tool span as it closes;
 * `endTurn` is the one place that ends a whole tree at once, which is
 * the condition the cap is reached in.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createTracerProvider,
  ensureTurn,
  endTurn,
} from '../scripts/lib/traces-collector.js';
import { SPAN_CONTENT_LIMIT } from '../scripts/lib/content/span-content.js';
import type { ChatCall } from '../scripts/lib/conversation/types.js';
import type { CollectorConfig } from '../scripts/lib/config-loader.js';
import { _setDiagnosticsAuditPathForTests } from '../adapters/diagnostics.js';
import { trackTempDir } from './helpers/tmp-dirs.js';

const CHAT_CALLS = 40;
const EXPECTED_SPANS = CHAT_CALLS + 1; // 40 chat spans + the turn root
const TURN_ROOT_NAME = 'invoke_agent UserPromptSubmit';

/** Keep exporter diagnostics out of the developer's audit log. */
const auditDir = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-export-capacity-')));
_setDiagnosticsAuditPathForTests(join(auditDir, 'audit.jsonl'));

after(() => {
  _setDiagnosticsAuditPathForTests(null);
  try { rmSync(auditDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

interface StalledCollector {
  url: string;
  /** Span names across every request body the server finished reading. */
  received: string[];
  /** Total decoded bytes the endpoint read — proof the fat variant is fat. */
  bytes: number;
  requests: number;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * An OTLP endpoint that accepts the request, reads it in full, and then
 * holds the connection open forever. Every export stays counted against
 * the exporter's in-flight limit until it times out.
 *
 * Every accepted socket is tracked and `destroy()`ed by `close()`. A
 * socket left parked in the exporter's keep-alive pool is a ref'd libuv
 * handle: `server.close()` alone would wait on it and the `node --test`
 * worker would never exit, with all of its tests already passed.
 */
async function startStalledCollector(): Promise<StalledCollector> {
  const received: string[] = [];
  const sockets = new Set<Socket>();
  let requests = 0;
  let bytes = 0;

  const server: Server = createServer((req, res) => {
    requests += 1;
    void readBody(req).then(raw => {
      const body = req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw;
      bytes += body.byteLength;
      try {
        const payload = JSON.parse(body.toString('utf-8')) as {
          resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: Array<{ name?: string }> }> }>;
        };
        for (const rs of payload.resourceSpans ?? []) {
          for (const ss of rs.scopeSpans ?? []) {
            for (const span of ss.spans ?? []) {
              if (span.name) received.push(span.name);
            }
          }
        }
      } catch {
        // A body we cannot parse is not a span we can count — the
        // assertions below will report it as a missing span.
      }
      // Deliberately no `res.end()`: the export never settles.
      void res;
    });
  });

  server.on('connection', s => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    received,
    get bytes() { return bytes; },
    get requests() { return requests; },
    close: () => new Promise<void>(resolve => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}

function stalledConfig(endpoint: string): CollectorConfig {
  return {
    endpoint,
    api_key: '',
    headers: {},
    // Short enough that a stalled export gives up quickly, long enough
    // that all 41 span.end() calls happen while exports are in flight.
    timeout: 1500,
    protocol: 'http',
    enabled: true,
    metrics_enabled: false,
    traces_enabled: true,
    logs_enabled: false,
  };
}

/** `count` chat calls, each carrying `reply` as its assistant text. */
function chatCalls(count: number, reply: string): ChatCall[] {
  const calls: ChatCall[] = [];
  for (let i = 0; i < count; i++) {
    calls.push({
      callId: `req-${i}`,
      model: 'claude-capacity',
      startMs: 1_000 + i,
      endMs: 1_001 + i,
      timing: 'exact',
      isSidechain: false,
      blocks: [{ type: 'text', index: 0, content: reply }],
    });
  }
  return calls;
}

describe('trace export capacity: a large turn keeps every span', () => {
  it(`puts all ${EXPECTED_SPANS} spans of a ${CHAT_CALLS}-call turn on the wire, root included`, async () => {
    const collector = await startStalledCollector();
    const provider = createTracerProvider(stalledConfig(collector.url), 'claude-code');
    assert.ok(provider, 'createTracerProvider returned a provider');

    // Everything from here on is inside the try: the stalled server holds
    // open sockets, so a throw that skipped `collector.close()` would hang
    // the whole test process instead of reporting a failure.
    try {
      const state = ensureTurn(null, 'sess-capacity');

      // Ends the whole tree in one synchronous burst, turn root last, then
      // force-flushes. This is the exact production path.
      await endTurn(provider!, state, '/tmp', null, chatCalls(CHAT_CALLS, 'ok'));

      assert.ok(
        collector.received.includes(TURN_ROOT_NAME),
        `the turn root ("${TURN_ROOT_NAME}") must reach the exporter; the endpoint only ever saw `
        + `${collector.received.length} spans across ${collector.requests} request(s). `
        + 'A turn root that is never sent is the trace a backend renders with 0 roots.',
      );
      assert.equal(
        collector.received.length, EXPECTED_SPANS,
        `every span of the turn must be sent; got ${collector.received.length} of ${EXPECTED_SPANS} `
        + `across ${collector.requests} request(s) — anything short of this is a silent drop.`,
      );
    } finally {
      await provider!.shutdown().catch(() => { /* the endpoint never answers */ });
      await collector.close();
    }
  });

  // Same burst, but with every span carrying content.
  //
  // Small bodies ride ON the span (`nio.chat.reply`, ≤2 KB each) rather
  // than on the logs signal, which makes each exported span materially
  // bigger. The burst above uses near-empty spans and would therefore
  // stay green even if the extra payload pushed the exporter back over
  // an edge. This variant fills the content attribute to the budget so
  // the fattened tree is what actually has to reach the wire.
  it(`puts all ${EXPECTED_SPANS} spans on the wire when every span carries a full ${SPAN_CONTENT_LIMIT}-byte payload`, async () => {
    const collector = await startStalledCollector();
    const provider = createTracerProvider(stalledConfig(collector.url), 'claude-code');
    assert.ok(provider, 'createTracerProvider returned a provider');

    try {
      const state = ensureTurn(null, 'sess-capacity-fat');
      const bulk = 'z'.repeat(SPAN_CONTENT_LIMIT);

      await endTurn(provider!, state, '/tmp', null, chatCalls(CHAT_CALLS, bulk));

      assert.ok(
        collector.received.includes(TURN_ROOT_NAME),
        'the turn root must reach the exporter even with content-bearing spans',
      );
      assert.equal(
        collector.received.length, EXPECTED_SPANS,
        `every span of the turn must be sent; got ${collector.received.length} of ${EXPECTED_SPANS} `
        + `across ${collector.requests} request(s). Moving content onto the span must not `
        + 'reintroduce the silent drop.',
      );
      // Non-vacuity: without the content attributes this tree serialises
      // to a small fraction of this. 40 content-bearing spans at the 2 KB
      // ceiling cannot fit in less than ~80 KB of OTLP JSON.
      assert.ok(
        collector.bytes > 80_000,
        `the exported payload must actually carry the content — only ${collector.bytes} `
        + 'decoded bytes reached the endpoint, so the spans went out bare and this test '
        + 'would prove nothing about fat spans.',
      );
    } finally {
      await provider!.shutdown().catch(() => { /* the endpoint never answers */ });
      await collector.close();
    }
  });

  // Companion to the fix above, pinning its cost. `BatchSpanProcessor`'s
  // `forceFlush()` rejects when a batch's export fails, where
  // `SimpleSpanProcessor`'s resolved whatever the result was. Every emit
  // helper awaits that flush inline, so without `flushSpans` the swap
  // would have turned "the collector is unreachable" into an exception
  // thrown out of the host's turn boundary — telemetry taking the agent
  // down with it. Mutation-checked by removing `flushSpans`'s try/catch.
  it('endTurn resolves rather than throwing when the collector is unreachable', async () => {
    const config: CollectorConfig = {
      endpoint: 'http://127.0.0.1:1',   // refused immediately, no real network
      api_key: '',
      headers: {},
      timeout: 1000,
      protocol: 'http',
      enabled: true,
      metrics_enabled: false,
      traces_enabled: true,
      logs_enabled: false,
    };
    const provider = createTracerProvider(config, 'claude-code');
    assert.ok(provider);

    const state = ensureTurn(null, 'sess-unreachable');

    await assert.doesNotReject(
      () => endTurn(provider!, state, '/tmp', null, chatCalls(1, 'hi')),
      'an unreachable OTLP endpoint must not throw out of the turn boundary',
    );
    await provider!.shutdown().catch(() => { /* nothing is listening */ });
  });
});
