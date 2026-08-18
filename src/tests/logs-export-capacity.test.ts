// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Logs export capacity — a turn whose content sink emits more than 30
 * records in one burst must still put every record on the wire.
 *
 * The logs signal carried the identical defect the traces signal did
 * (fixed one commit earlier), through the identical mechanism:
 *
 *   - `SimpleLogRecordProcessor` starts one export per `logger.emit()`.
 *   - `endTurn`'s content sink emits a whole turn's records — thinking,
 *     text, tool_input — in ONE synchronous burst, one `emit()` per
 *     record (`logs-collector.ts`'s `emitContentRecords` loop).
 *   - `otlp-exporter-base`'s promise queue caps in-flight exports at 30
 *     (`shared-configuration.js`: `concurrencyLimit: 30`), and that cap
 *     is not reachable from nio's config surface.
 *   - `otlp-export-delegate.js` rejects the overflow with
 *     'Concurrent export limit reached' and returns — no retry, no
 *     requeue, nothing appended anywhere.
 *
 * So a turn producing more than 30 content records silently lost the
 * overflow. The live distribution measured on 2026-08-06 (137
 * `tool_input` + 116 `tool_output` records) is therefore a count of
 * SURVIVORS, not of what was produced.
 *
 * Why this test does NOT use an in-memory exporter
 * -----------------------------------------------
 * Because there is nothing to see. `InMemoryLogRecordExporter` has no
 * concurrency limit at all, so an in-memory version of this test passes
 * both before and after the fix — a test whose input cannot express the
 * defect. The provider under test is therefore the real one
 * (`createLoggerProvider`) with the real
 * `@opentelemetry/exporter-logs-otlp-http`, pointed at a local HTTP
 * server that ACCEPTS the connection, reads the whole request body, and
 * then never responds — which keeps every export counted against the
 * exporter's in-flight queue for the duration.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLoggerProvider } from '../scripts/lib/logs-collector.js';
import { createContentSink } from '../scripts/lib/content/sink.js';
import { DEFAULT_CONTENT_LIMITS } from '../scripts/lib/content/truncate.js';
import type { ChatCall, ContentBlock } from '../scripts/lib/conversation/types.js';
import type { CollectorConfig } from '../scripts/lib/config-loader.js';
import { _setDiagnosticsAuditPathForTests } from '../adapters/diagnostics.js';
import { trackTempDir } from './helpers/tmp-dirs.js';

/** Above the exporter's 30-in-flight cap, and in the range a real turn reaches. */
const BLOCKS = 40;
const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPAN_ID = 'b7ad6b7169203331';

/** Keep exporter diagnostics out of the developer's audit log. */
const auditDir = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-logs-capacity-')));
_setDiagnosticsAuditPathForTests(join(auditDir, 'audit.jsonl'));

after(() => {
  _setDiagnosticsAuditPathForTests(null);
  try { rmSync(auditDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

interface StalledCollector {
  url: string;
  /** Record bodies across every request the server finished reading. */
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
          resourceLogs?: Array<{
            scopeLogs?: Array<{ logRecords?: Array<{ body?: { stringValue?: string } }> }>;
          }>;
        };
        for (const rl of payload.resourceLogs ?? []) {
          for (const sl of rl.scopeLogs ?? []) {
            for (const rec of sl.logRecords ?? []) {
              const text = rec.body?.stringValue;
              if (typeof text === 'string') received.push(text);
            }
          }
        }
      } catch {
        // A body we cannot parse is not a record we can count — the
        // assertions below report it as a missing record.
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

/** Poll until `done()` or the budget runs out. Never throws. */
async function waitUntil(done: () => boolean, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!done() && Date.now() < deadline) {
    await new Promise<void>(resolve => { setTimeout(resolve, 20).unref(); });
  }
}

function stalledConfig(endpoint: string): CollectorConfig {
  return {
    endpoint,
    api_key: '',
    headers: {},
    // Short enough that a stalled export gives up quickly, long enough
    // that the whole burst is emitted while exports are still in flight.
    timeout: 1500,
    protocol: 'http',
    enabled: true,
    metrics_enabled: false,
    traces_enabled: false,
    logs_enabled: true,
  };
}

/**
 * One chat call carrying `BLOCKS` thinking blocks — one content record
 * each.
 *
 * `thinking`, not `text`: the size-based placement rule (see
 * `content/span-content.ts`) carries a small assistant reply on the chat
 * span and suppresses its log record, so a burst of short `text` blocks
 * would now emit nothing at all and this test would pass vacuously.
 * `thinking` is one of the two kinds logs own unconditionally, which is
 * exactly what this test needs: a burst the logs signal really has to
 * carry.
 */
function burstCall(): ChatCall {
  const blocks: ContentBlock[] = [];
  for (let i = 0; i < BLOCKS; i++) {
    blocks.push({ type: 'thinking', index: i, content: `content-block-${i}` });
  }
  return {
    callId: 'call-capacity',
    startMs: 1_000,
    endMs: 2_000,
    timing: 'exact',
    isSidechain: false,
    blocks,
  };
}

describe('logs export capacity: a turn keeps every content record', () => {
  it(`puts all ${BLOCKS} content records of one burst on the wire`, async () => {
    const collector = await startStalledCollector();
    const provider = createLoggerProvider(stalledConfig(collector.url), 'claude-code');
    assert.ok(provider, 'createLoggerProvider returned a provider');

    // Everything from here on is inside the try: the stalled server holds
    // open sockets, so a throw that skipped `collector.close()` would hang
    // the whole test process instead of reporting a failure.
    try {
      const sink = createContentSink(provider, DEFAULT_CONTENT_LIMITS);
      assert.ok(sink, 'a provider yields a content sink');

      // The production burst: `endTurn` calls the sink once per chat
      // span and the sink emits one log record per block, synchronously.
      sink!(burstCall(), SPAN_ID, TRACE_ID);

      // Batched export needs the flush to send anything; the unbatched
      // one has already fired 40 separate requests by now. `.catch()`
      // because this endpoint never answers, and a batched flush rejects
      // once `exportTimeoutMillis` elapses.
      await provider!.forceFlush().catch(() => { /* endpoint never answers */ });
      await waitUntil(() => collector.received.length >= BLOCKS, 3_000);

      const missing = [];
      for (let i = 0; i < BLOCKS; i++) {
        if (!collector.received.includes(`content-block-${i}`)) missing.push(i);
      }
      assert.deepEqual(
        missing, [],
        `every content record must reach the exporter; the endpoint saw `
        + `${collector.received.length} of ${BLOCKS} records across ${collector.requests} `
        + `request(s), missing block indices [${missing.join(', ')}]. Records past the `
        + "exporter's 30-in-flight cap are dropped with no retry and no diagnostic the "
        + 'consumer can see.',
      );
    } finally {
      await provider!.shutdown().catch(() => { /* the endpoint never answers */ });
      await collector.close();
    }
  });

  // The flush guard (`flushLogRecords`) that accompanies this swap is
  // NOT pinned from here, deliberately. A real `createLoggerProvider`
  // against an unreachable endpoint RESOLVES its `forceFlush()` — the
  // logs SDK routes a failed export to `globalErrorHandler` rather than
  // rejecting, unlike the traces SDK (see `flushLogRecords`' doc for the
  // exact source lines and the measurements). A test written here would
  // therefore pass with or without the guard, i.e. verify nothing. The
  // guard is pinned instead by `plugin-runtime.test.ts › a rejecting
  // LOGS flush does not surface at the turn boundary`, which supplies a
  // provider that actually rejects.
});
