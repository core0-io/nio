// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Long-turn visibility — a tool span must be on the wire while the turn
 * is still open.
 *
 * This is the acceptance test for the decision to abandon deferred tool
 * spans. The behaviour it pins is not "spans are eventually exported"
 * (deferral satisfied that too) but "spans are exported BEFORE the turn
 * that contains them ends", which is the property a long turn and a
 * mid-run crash both need and which deferral could not provide.
 *
 * The shape is taken from the live session that prompted the change: a
 * turn that ran seven minutes with 38 finished tool spans parked in its
 * `traces-state-store-<session>.json` shard (`deferred: 38`,
 * `pending: 0`), while the newest span the backend held still belonged
 * to the PREVIOUS turn. Nothing would have re-sent those 38 either —
 * `hasOrphanedDeferredTree` only adopts a shard whose turn is already
 * closed, so a live turn's queue is not salvage material.
 *
 * ── Why this test is not vacuous ─────────────────────────────────────
 *
 * The assertions all run at a point where NO turn boundary has been
 * dispatched. Under the deferred implementation `deferPostToolUse` puts
 * the finished span in `deferred_spans` and emits nothing, so the sink
 * would hold zero spans here and every assertion below goes red. That
 * mutation was run: reverting `collector-core.ts`'s PostToolUse branch
 * to `deferPostToolUse` turns cases 1 and 2 red (0 tool spans seen
 * mid-turn) and case 3 red (the shard still carries 40 parked spans).
 *
 * ── Why a real OTLP sink rather than `makeInMemoryTracer` ────────────
 *
 * "On the wire" is the claim, so the wire has to be real: an in-memory
 * exporter would record a span the moment it ends, which cannot
 * distinguish "handed to the exporter" from "actually exported". The
 * sink here answers 200 promptly (unlike `trace-export-capacity.test.ts`,
 * which needs stalled exports to reproduce a concurrency cap).
 *
 * Teardown follows the same rule as every other sink-bearing test on
 * this branch: every accepted socket is tracked and destroyed, and the
 * provider is shut down BEFORE the server closes, so no export timer
 * outlives the port it exports to. A `node --test` worker whose exporter
 * is retrying into a dead port never exits.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dispatchCollectorEvent } from '../scripts/lib/collector-core.js';
import { createTracerProvider } from '../scripts/lib/traces-collector.js';
import { statePath } from '../scripts/lib/traces-state-store.js';
import type { CollectorConfig } from '../scripts/lib/config-loader.js';
import type { CollectorLogsConfig } from '../adapters/config-schema.js';
import { trackTempDir } from './helpers/tmp-dirs.js';

/**
 * A long turn, sized past the exporter's `concurrencyLimit: 30` so this
 * also stands as a second witness for the capacity fix: 40 eager exports
 * must all land, not the first 30.
 */
const TOOL_CALLS = 40;

interface Sink {
  url: string;
  /** Every span the endpoint has finished reading, oldest first. */
  spans: Array<{ name: string; attributes: Record<string, unknown> }>;
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

/** OTLP attributes arrive as `[{key, value:{stringValue|boolValue|…}}]`. */
function flattenAttrs(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of (raw as Array<{ key?: string; value?: Record<string, unknown> }>) ?? []) {
    if (!a.key || !a.value) continue;
    const v = a.value;
    out[a.key] = v['stringValue'] ?? v['boolValue'] ?? v['intValue'] ?? v['doubleValue'];
  }
  return out;
}

async function startSink(): Promise<Sink> {
  const spans: Sink['spans'] = [];
  const sockets = new Set<Socket>();

  const server: Server = createServer((req, res) => {
    void readBody(req).then(raw => {
      const body = req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw;
      try {
        const payload = JSON.parse(body.toString('utf-8')) as {
          resourceSpans?: Array<{
            scopeSpans?: Array<{ spans?: Array<{ name?: string; attributes?: unknown }> }>;
          }>;
        };
        for (const rs of payload.resourceSpans ?? []) {
          for (const ss of rs.scopeSpans ?? []) {
            for (const s of ss.spans ?? []) {
              if (s.name) spans.push({ name: s.name, attributes: flattenAttrs(s.attributes) });
            }
          }
        }
      } catch {
        // Unparseable body → a span this test will report as missing.
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
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
    spans,
    close: () => new Promise<void>(resolve => {
      // Destroy first: the exporter parks a keep-alive connection, and
      // `close()` alone would wait on it going idle.
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}

function collectorConfig(endpoint: string): CollectorConfig {
  return {
    endpoint,
    api_key: '',
    headers: {},
    timeout: 1500,
    protocol: 'http',
    enabled: true,
    metrics_enabled: false,
    traces_enabled: true,
    logs_enabled: false,
  };
}

/** Fresh audit path — also the directory the state shard is written to. */
function freshLogsConfig(): CollectorLogsConfig {
  const dir = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-eager-tool-spans-')));
  return { enabled: true, local: true, path: join(dir, 'audit.jsonl'), max_size_mb: 100 };
}


describe('eager tool spans: a long turn is visible before it ends', () => {
  it(
    `exports all ${TOOL_CALLS} tool spans while the turn is still open, `
    + 'carrying gen_ai.tool.call.id',
    async () => {
      const sink = await startSink();
      const logsConfig = freshLogsConfig();
      const sessionId = 'sess-long-turn';
      const config = collectorConfig(sink.url);
      // `register: false` — this provider must not become the process
      // global and clobber other test files' tracers.
      const provider = createTracerProvider(config, 'claude-code', undefined, { register: false });
      assert.ok(provider, 'createTracerProvider returned a provider');

      try {
        const dispatch = (event: string, input: Record<string, unknown>) =>
          dispatchCollectorEvent({
            event,
            input: input as never,
            platform: 'claude-code',
            config: config as never,
            meterProvider: null,
            tracerProvider: provider,
            loggerProvider: null,
            logsConfig,
          });

        await dispatch('UserPromptSubmit', { session_id: sessionId, prompt: 'do forty things' });

        for (let i = 0; i < TOOL_CALLS; i++) {
          const toolUseId = `toolu_long_${i}`;
          await dispatch('PreToolUse', {
            session_id: sessionId,
            tool_name: 'Bash',
            tool_input: { command: `echo ${i}` },
            tool_use_id: toolUseId,
          });
          await dispatch('PostToolUse', {
            session_id: sessionId,
            tool_name: 'Bash',
            tool_input: { command: `echo ${i}` },
            tool_use_id: toolUseId,
            tool_response: { output: `${i}` },
          });
        }

        // NOTHING has closed the turn. This is the whole point: on the
        // live session that motivated the change, this is the moment a
        // user watching the backend saw an empty screen for 7 minutes.
        const toolSpans = sink.spans.filter(s => s.name.startsWith('execute_tool '));
        assert.equal(
          toolSpans.length, TOOL_CALLS,
          `all ${TOOL_CALLS} tool spans must have reached the collector before the turn closes; `
          + `only ${toolSpans.length} did. Zero means the spans are being parked again — the `
          + 'behaviour this test exists to prevent. A number between 1 and 29 means the exporter '
          + "concurrency cap is back (see trace-export-capacity.test.ts).",
        );
        assert.equal(
          sink.spans.filter(s => s.name.startsWith('invoke_agent')).length, 0,
          'no turn root can have been exported yet — if one has, this run closed the turn and the '
          + 'assertion above proves nothing about mid-turn visibility',
        );

        // The issuing call survives as DATA. This is what the flat tree
        // was traded for, so it is not optional.
        const withCallId = toolSpans.filter(s => typeof s.attributes['gen_ai.tool.call.id'] === 'string');
        assert.equal(
          withCallId.length, TOOL_CALLS,
          'every eagerly-exported tool span must still carry gen_ai.tool.call.id — dropping the '
          + 'parent edge is only acceptable because a backend can still join on this attribute',
        );
        assert.deepEqual(
          [...new Set(withCallId.map(s => s.attributes['gen_ai.tool.call.id']))].sort(),
          Array.from({ length: TOOL_CALLS }, (_, i) => `toolu_long_${i}`).sort(),
          'and the ids must be the real per-call ids from the host payload, not a repeated or '
          + 'synthesised value',
        );
      } finally {
        await provider!.shutdown().catch(() => { /* sink may already be gone */ });
        await sink.close();
      }
    },
  );

  it('leaves no tool span parked in the session state shard mid-turn', async () => {
    const sink = await startSink();
    const logsConfig = freshLogsConfig();
    const sessionId = 'sess-shard-empty';
    const config = collectorConfig(sink.url);
    const provider = createTracerProvider(config, 'claude-code', undefined, { register: false });
    assert.ok(provider);

    try {
      const dispatch = (event: string, input: Record<string, unknown>) =>
        dispatchCollectorEvent({
          event,
          input: input as never,
          platform: 'claude-code',
          config: config as never,
          meterProvider: null,
          tracerProvider: provider,
          loggerProvider: null,
          logsConfig,
        });

      await dispatch('UserPromptSubmit', { session_id: sessionId, prompt: 'hi' });
      for (let i = 0; i < TOOL_CALLS; i++) {
        await dispatch('PreToolUse', {
          session_id: sessionId, tool_name: 'Bash',
          tool_input: { command: `echo ${i}` }, tool_use_id: `toolu_shard_${i}`,
        });
        await dispatch('PostToolUse', {
          session_id: sessionId, tool_name: 'Bash',
          tool_input: { command: `echo ${i}` }, tool_use_id: `toolu_shard_${i}`,
          tool_response: { output: `${i}` },
        });
      }

      // The failing observation from the live session, stated directly:
      // `deferred: 38, pending: 0` in the shard of a turn that had not
      // closed. Both queues must now be empty.
      const path = statePath(logsConfig, sessionId);
      assert.ok(existsSync(path), 'the session state shard must exist — the turn is still open');
      const shard = JSON.parse(readFileSync(path, 'utf-8')) as {
        deferred_spans?: unknown[];
        pending_spans?: Record<string, unknown>;
      };
      assert.equal(
        (shard.deferred_spans ?? []).length, 0,
        `the shard is holding ${(shard.deferred_spans ?? []).length} finished tool spans that the `
        + 'backend has never seen. This is the exact state the live session was found in, and a '
        + 'crash here loses every one of them: the recovery path only adopts shards whose turn '
        + 'has already closed.',
      );
      assert.equal(
        Object.keys(shard.pending_spans ?? {}).length, 0,
        'and no tool is still open — every PostToolUse closed its span',
      );
    } finally {
      await provider!.shutdown().catch(() => { /* sink may already be gone */ });
      await sink.close();
    }
  });

  it('does not re-emit an eagerly-exported tool span when the turn finally closes', async () => {
    const sink = await startSink();
    const logsConfig = freshLogsConfig();
    const sessionId = 'sess-no-dup';
    const config = collectorConfig(sink.url);
    const provider = createTracerProvider(config, 'claude-code', undefined, { register: false });
    assert.ok(provider);

    try {
      const dispatch = (event: string, input: Record<string, unknown>) =>
        dispatchCollectorEvent({
          event,
          input: input as never,
          platform: 'claude-code',
          config: config as never,
          meterProvider: null,
          tracerProvider: provider,
          loggerProvider: null,
          logsConfig,
        });

      await dispatch('UserPromptSubmit', { session_id: sessionId, prompt: 'hi' });
      await dispatch('PreToolUse', {
        session_id: sessionId, tool_name: 'Bash',
        tool_input: { command: 'echo once' }, tool_use_id: 'toolu_once',
      });
      await dispatch('PostToolUse', {
        session_id: sessionId, tool_name: 'Bash',
        tool_input: { command: 'echo once' }, tool_use_id: 'toolu_once',
        tool_response: { output: 'once' },
      });

      const midTurn = sink.spans.filter(s => s.name.startsWith('execute_tool '));
      assert.equal(midTurn.length, 1, 'the tool span went out at PostToolUse');

      await dispatch('Stop', { session_id: sessionId });

      const tools = sink.spans.filter(s => s.name.startsWith('execute_tool '));
      assert.equal(
        tools.length, 1,
        'turn close must not send the tool span a second time — `recordPostToolUse` drains the '
        + 'entry it appends, so `deferred_spans` is empty by the time `endTurn` builds the tree. '
        + `Got ${tools.length} copies.`,
      );
      assert.equal(
        sink.spans.filter(s => s.name.startsWith('invoke_agent')).length, 1,
        'and the turn root is still exported exactly once at the boundary',
      );
    } finally {
      await provider!.shutdown().catch(() => { /* sink may already be gone */ });
      await sink.close();
    }
  });
});
