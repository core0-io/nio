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
 * root, ended last, is never sent. That is the shape observed live in
 * SigNoz: traces of exactly 30 spans with 0 roots.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createTracerProvider,
  ensureTurn,
  recordPreToolUse,
  deferPostToolUse,
  endTurn,
} from '../scripts/lib/traces-collector.js';
import type { CollectorConfig } from '../scripts/lib/config-loader.js';
import { _setDiagnosticsAuditPathForTests } from '../adapters/diagnostics.js';
import { trackTempDir } from './helpers/tmp-dirs.js';

const TOOL_CALLS = 40;
const EXPECTED_SPANS = TOOL_CALLS + 1; // 40 tool spans + the turn root
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
 */
async function startStalledCollector(): Promise<StalledCollector> {
  const received: string[] = [];
  const sockets = new Set<Socket>();
  let requests = 0;

  const server: Server = createServer((req, res) => {
    requests += 1;
    void readBody(req).then(raw => {
      const body = req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw;
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
    get requests() { return requests; },
    close: () => new Promise<void>(resolve => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}

describe('trace export capacity: a large turn keeps every span', () => {
  it(`puts all ${EXPECTED_SPANS} spans of a ${TOOL_CALLS}-tool turn on the wire, root included`, async () => {
    const collector = await startStalledCollector();
    const config: CollectorConfig = {
      endpoint: collector.url,
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

    // `register: false` — this provider must not become the process
    // global and clobber other test files' tracers.
    const provider = createTracerProvider(config, 'claude-code', undefined, { register: false });
    assert.ok(provider, 'createTracerProvider returned a provider');

    // Everything from here on is inside the try: the stalled server holds
    // open sockets, so a throw that skipped `collector.close()` would hang
    // the whole test process instead of reporting a failure.
    try {
      let state = ensureTurn(null, 'sess-capacity');
      for (let i = 0; i < TOOL_CALLS; i++) {
        state = recordPreToolUse(state, `tool-${i}`, 'Bash', `cmd ${i}`);
        const post = deferPostToolUse(state, `tool-${i}`, '/tmp');
        assert.notEqual(post.durationMs, null, `tool-${i} produced a deferred span`);
        state = post.state;
      }
      assert.equal(
        (state.deferred_spans ?? []).length, TOOL_CALLS,
        'all tool spans are parked for the end-of-turn burst',
      );

      // Ends the whole tree in one synchronous burst, turn root last, then
      // force-flushes. This is the exact production path.
      await endTurn(provider!, state, '/tmp');

      assert.ok(
        collector.received.includes(TURN_ROOT_NAME),
        `the turn root ("${TURN_ROOT_NAME}") must reach the exporter; the endpoint only ever saw `
        + `${collector.received.length} spans across ${collector.requests} request(s). `
        + 'A turn root that is never sent is the trace SigNoz renders with 0 roots.',
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
    const provider = createTracerProvider(config, 'claude-code', undefined, { register: false });
    assert.ok(provider);

    let state = ensureTurn(null, 'sess-unreachable');
    state = recordPreToolUse(state, 'tool-0', 'Bash', 'echo hi');
    state = deferPostToolUse(state, 'tool-0', '/tmp').state;

    await assert.doesNotReject(
      () => endTurn(provider!, state, '/tmp'),
      'an unreachable OTLP endpoint must not throw out of the turn boundary',
    );
    await provider!.shutdown().catch(() => { /* nothing is listening */ });
  });
});
