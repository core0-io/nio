// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenClaw provider creation must be deferred until a session is
 * actually monitored.
 *
 * registerOpenClawPlugin used to build the tracer, meter and logger
 * providers unconditionally at registration time. The meter one matters
 * most: createMeterProvider installs a PeriodicExportingMetricReader
 * with exportIntervalMillis: 1000, whose timer lives as long as the
 * daemon — so every OpenClaw install that merely loaded the plugin stood
 * up the whole OTLP exporter stack, including users who never ran
 * `/nio monitor on`.
 *
 * WHY THIS TEST IS SHAPED THE WAY IT IS. The obvious assertion — "a
 * never-armed daemon sends zero requests" — is vacuous: OTel's
 * PeriodicExportingMetricReader returns early when
 * `resourceMetrics.scopeMetrics.length === 0`, so an eagerly-created but
 * never-used MeterProvider also sends nothing. Eager and lazy creation
 * are network-indistinguishable for that case, and a test asserting it
 * would stay green with the fix reverted.
 *
 * What IS observable is *when* the collector config is read. Lazy
 * creation reads it at first monitored use; eager creation froze it at
 * registration. So: register against a config with no OTLP endpoint,
 * point the config at a sink afterwards, then arm and drive one tool
 * call. Under the fix the export lands on the sink; under the old eager
 * code the provider was built from the endpoint-less config, was null,
 * and nothing could ever be exported for the life of the daemon.
 */

import { describe, it, before as beforeHook, after as afterHook } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { saveMonitorStore } from '../scripts/lib/monitor-store.js';
import type { CollectorLogsConfig } from '../adapters/config-schema.js';
import { trackTempDir } from './helpers/tmp-dirs.js';
import { closeOtlpSink } from './helpers/otlp-sink.js';

function makeFakeApi() {
  const handlers = new Map<string, (e: unknown, c?: unknown) => Promise<unknown> | unknown>();
  return {
    api: { on(name: string, h: (e: unknown, c?: unknown) => Promise<unknown> | unknown) { handlers.set(name, h); } },
    handlers,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('openclaw providers are created lazily, not at registration', () => {
  let sink: Server;
  let records: { url: string }[] = [];
  let port = 0;

  // Traces only, for the same reason monitor-openclaw.test.ts gives:
  // the metrics reader has a 1s background timer that would make hit
  // counts depend on unrelated timing.
  const traceHits = () => records.filter((r) => r.url === '/v1/traces').length;

  beforeHook(async () => {
    sink = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        records.push({ url: req.url ?? '' });
        res.writeHead(200);
        res.end('{}');
      });
    });
    await new Promise<void>((r) => sink.listen(0, '127.0.0.1', r));
    port = (sink.address() as { port: number }).port;
  });

  afterHook(async () => { await closeOtlpSink(sink); });

  it('reads the collector endpoint at first monitored use, not at registration', async () => {
    const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-monitor-oc-lazy-')));
    const logsConfig = { path: join(home, 'audit.jsonl') } as CollectorLogsConfig;

    // 1. A config with NO collector endpoint at registration time.
    writeFileSync(join(home, 'config.yaml'), 'guard:\n  protection_level: balanced\n', 'utf-8');

    // process.env['NIO_HOME'] mutation: registerOpenClawPlugin reads it
    // with no injectable seam, so this is safe only under node:test's
    // default serial-within-a-file execution — see helpers/with-nio-
    // home.ts's docblock for the full reasoning. try/finally restores it
    // even if the body below throws.
    const prev = process.env['NIO_HOME'];
    process.env['NIO_HOME'] = home;
    try {
      const { registerOpenClawPlugin } = await import('../adapters/openclaw-plugin.js');
      const { api, handlers } = makeFakeApi();
      registerOpenClawPlugin(api);

      // 2. Only now does an endpoint appear. Eager registration-time
      // provider creation could never see this.
      writeFileSync(
        join(home, 'config.yaml'),
        `collector:\n  endpoint: "http://127.0.0.1:${port}"\n`,
        'utf-8',
      );

      // 3. Arm and drive one blocked tool call. `rm -rf /` is a Phase-2
      // DANGEROUS_COMMAND hit under every protection level, so
      // before_tool_call takes the block path — which both opens and
      // closes the span inside a single handler invocation.
      const sessionId = 'oc-lazy-armed';
      saveMonitorStore(logsConfig, {
        sessions: { [sessionId]: { armed_at: Date.now(), cwd: process.cwd() } },
      });
      records = [];

      const before = handlers.get('before_tool_call');
      assert.ok(before, 'before_tool_call handler must be registered');
      await before(
        {
          toolName: 'exec',
          params: { command: 'rm -rf /' },
          toolCallId: `call-${sessionId}`,
          runId: sessionId,
        },
        { sessionKey: sessionId },
      );
      await wait(400);

      assert.ok(
        traceHits() > 0,
        'the provider must be built from the config as it stands at first monitored ' +
        `use, not the one frozen at registration; got ${traceHits()} trace requests`,
      );
    } finally {
      if (prev === undefined) delete process.env['NIO_HOME'];
      else process.env['NIO_HOME'] = prev;
    }
  });

  it('an unarmed session still exports nothing once the providers exist', async () => {
    // Companion to the case above: proves deferring creation did not
    // weaken the gate. The providers get built by the armed call, then a
    // second, unarmed session in the same registration must still add
    // zero trace requests.
    const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-monitor-oc-lazy2-')));
    const logsConfig = { path: join(home, 'audit.jsonl') } as CollectorLogsConfig;
    writeFileSync(
      join(home, 'config.yaml'),
      `collector:\n  endpoint: "http://127.0.0.1:${port}"\n`,
      'utf-8',
    );

    // Same process.env['NIO_HOME'] caveat as the test above.
    const prev = process.env['NIO_HOME'];
    process.env['NIO_HOME'] = home;
    try {
      const { registerOpenClawPlugin } = await import('../adapters/openclaw-plugin.js');
      const { api, handlers } = makeFakeApi();
      registerOpenClawPlugin(api);

      const before = handlers.get('before_tool_call');
      assert.ok(before, 'before_tool_call handler must be registered');

      saveMonitorStore(logsConfig, {
        sessions: { 'oc-lazy2-armed': { armed_at: Date.now(), cwd: process.cwd() } },
      });
      records = [];

      await before(
        { toolName: 'exec', params: { command: 'rm -rf /' }, toolCallId: 'call-oc-lazy2-armed', runId: 'oc-lazy2-armed' },
        { sessionKey: 'oc-lazy2-armed' },
      );
      await wait(400);
      const armedHits = traceHits();
      assert.ok(armedHits > 0, 'sanity: the armed session must reach the sink');

      await before(
        { toolName: 'exec', params: { command: 'rm -rf /' }, toolCallId: 'call-oc-lazy2-unarmed', runId: 'oc-lazy2-unarmed' },
        { sessionKey: 'oc-lazy2-unarmed' },
      );
      await wait(400);
      assert.equal(traceHits(), armedHits, 'unarmed session must add zero trace requests');
    } finally {
      if (prev === undefined) delete process.env['NIO_HOME'];
      else process.env['NIO_HOME'] = prev;
    }
  });
});
