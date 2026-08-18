// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression guard: a test that points the REAL runtime at a loopback
 * OTLP sink must be able to take its providers back down again.
 *
 * The bug this pins was an intermittent, multi-minute hang of the whole
 * `pnpm test` run. It was not a deadlock and not a failing assertion —
 * every test in the stuck worker had already PASSED. The runtime builds
 * its own tracer / meter / logger providers on first monitored use, and
 * `PeriodicExportingMetricReader` then exports once a second for as long
 * as the process lives. A test that closed its sink without shutting
 * those providers down left the exporter retrying into a dead port
 * forever; each retry opens a fresh TCP connect, a REF'D libuv handle,
 * so the worker's event loop never drained and `node --test` waited on
 * it until someone killed it. Caught in the act with the worker looping
 * on `otlp_export_failed` against two already-closed ports.
 *
 * Two things are pinned here, because they fail differently:
 *
 *  1. The MECHANISM (deterministic): the runtime registers the providers
 *     it builds itself, and `shutdownRuntimeBuiltProviders` empties that
 *     registry. Delete the tracking and the count never rises; stop
 *     clearing it and the count never falls.
 *  2. The PROPERTY (end-to-end): a child process that runs the real
 *     scenario and tears it down the documented way EXITS ON ITS OWN.
 *     No `process.exit()` anywhere in the child — exiting is the
 *     assertion.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';

import {
  shutdownRuntimeBuiltProviders,
  runtimeBuiltProviderCount,
} from '../adapters/plugin-runtime.js';
import { trackTempDir } from './helpers/tmp-dirs.js';
import { closeOtlpSink } from './helpers/otlp-sink.js';

/** Directory of the COMPILED test file — i.e. `dist/tests`. */
const here = dirname(fileURLToPath(import.meta.url));

/** A sink that accepts and discards OTLP posts. */
async function startSink(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200);
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as { port: number }).port };
}

/** Arm a session and drive one monitored turn through the real plugin. */
async function driveMonitoredTurn(home: string, sessionId: string): Promise<void> {
  const { saveMonitorStore } = await import('../scripts/lib/monitor-store.js');
  saveMonitorStore(
    { path: join(home, 'audit.jsonl') } as never,
    { sessions: { [sessionId]: { armed_at: Date.now(), cwd: process.cwd() } } },
  );

  const { registerOpenClawPlugin } = await import('../adapters/openclaw-plugin.js');
  const handlers = new Map<string, (e: unknown, c?: unknown) => Promise<unknown> | unknown>();
  registerOpenClawPlugin({
    on(name: string, h: (e: unknown, c?: unknown) => Promise<unknown> | unknown) {
      handlers.set(name, h);
    },
  });

  const ctx = { sessionKey: sessionId };
  await handlers.get('before_agent_reply')!({ cleanedBody: 'do the thing' }, ctx);
  await handlers.get('llm_output')!(
    {
      runId: 'run-lifetime-1', callId: 'call-lifetime-1', provider: 'anthropic',
      model: 'lifetime-model', outcome: 'ok', durationMs: 7,
      assistantTexts: ['a reply'], usage: { input: 5, output: 3 },
    },
    ctx,
  );
  await handlers.get('agent_end')!({}, ctx);
}

describe('runtime-built OTLP providers are reclaimable by their test', () => {
  it('registers what it builds itself, and gives it all back on shutdown', async () => {
    // Start from a clean registry: earlier files in this process may have
    // built providers of their own, and this test's subject is the delta.
    await shutdownRuntimeBuiltProviders();
    assert.equal(
      runtimeBuiltProviderCount(), 0,
      'shutdownRuntimeBuiltProviders must leave the registry empty',
    );

    const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-provider-lifetime-')));
    const { server, port } = await startSink();
    writeFileSync(
      join(home, 'config.yaml'),
      `collector:\n  endpoint: "http://127.0.0.1:${port}"\n`,
      'utf-8',
    );

    const previousHome = process.env['NIO_HOME'];
    process.env['NIO_HOME'] = home;
    try {
      await driveMonitoredTurn(home, 'provider-lifetime-armed');

      // The whole hazard exists only because this number is > 0: the
      // runtime stood up real exporters with real 1-second timers. If a
      // refactor ever makes the runtime stop tracking them, this is the
      // assertion that notices — the leak would otherwise be invisible
      // until a test run hangs weeks later.
      assert.ok(
        runtimeBuiltProviderCount() > 0,
        'driving a monitored turn against a real endpoint must build — and register — runtime-owned providers',
      );

      await shutdownRuntimeBuiltProviders();
      assert.equal(
        runtimeBuiltProviderCount(), 0,
        'every runtime-built provider must be shut down and forgotten',
      );
    } finally {
      if (previousHome === undefined) delete process.env['NIO_HOME'];
      else process.env['NIO_HOME'] = previousHome;
      await closeOtlpSink(server);
    }
  });

  it('leaves a child process able to exit on its own after the sink is gone', async () => {
    // The end-to-end property. The child does exactly what the four
    // openclaw wiring tests do — real plugin, real endpoint, real
    // providers — then tears down via `closeOtlpSink` and simply stops.
    // It deliberately waits ~2.5 s after teardown before letting the
    // loop drain, which is long enough for an un-shut-down metric reader
    // to fire several times and get stuck in its ECONNREFUSED retry
    // cycle. Nothing calls `process.exit()`: the child exiting IS the
    // assertion, and a regression turns this into a timeout.
    const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-provider-exit-')));
    const script = join(home, 'child.mjs');
    const url = (rel: string) => JSON.stringify(pathToFileURL(join(here, rel)).href);

    writeFileSync(script, `
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env.NIO_HOME;
const server = createServer((req, res) => {
  req.resume();
  req.on('end', () => { res.writeHead(200); res.end('{}'); });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
writeFileSync(join(home, 'config.yaml'),
  'collector:\\n  endpoint: "http://127.0.0.1:' + port + '"\\n', 'utf-8');

const { saveMonitorStore } = await import(${url('../scripts/lib/monitor-store.js')});
saveMonitorStore({ path: join(home, 'audit.jsonl') },
  { sessions: { 'child-armed': { armed_at: Date.now(), cwd: process.cwd() } } });

const { registerOpenClawPlugin } = await import(${url('../adapters/openclaw-plugin.js')});
const handlers = new Map();
registerOpenClawPlugin({ on: (n, h) => handlers.set(n, h) });
const ctx = { sessionKey: 'child-armed' };
await handlers.get('before_agent_reply')({ cleanedBody: 'go' }, ctx);
await handlers.get('llm_output')({
  runId: 'r1', callId: 'c1', provider: 'anthropic', model: 'child-model',
  outcome: 'ok', durationMs: 7, assistantTexts: ['reply'], usage: { input: 5, output: 3 },
}, ctx);
await handlers.get('agent_end')({}, ctx);

const { closeOtlpSink } = await import(${url('./helpers/otlp-sink.js')});
await closeOtlpSink(server);

// Hold the loop open long enough that a LEAKED 1 s reader would be
// mid-retry when this resolves. With the providers properly shut down
// there is nothing left scheduled, so the process exits right here.
await new Promise(r => setTimeout(r, 2500));
`, 'utf-8');

    const child = spawn(process.execPath, [script], {
      env: { ...process.env, NIO_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    child.stdout.resume();

    const exited = await new Promise<number | 'timeout'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 30_000);
      child.on('exit', (code) => { clearTimeout(timer); resolve(code ?? -1); });
    });

    if (exited === 'timeout') {
      child.kill('SIGKILL');
      assert.fail(
        'the child never exited: a runtime-built OTLP provider outlived the sink and its '
        + 'export retries kept the event loop alive. This is the hang that stalls `pnpm test`.\n'
        + `child stderr:\n${stderr.slice(0, 2000)}`,
      );
    }
    assert.equal(exited, 0, `child exited non-zero.\nstderr:\n${stderr.slice(0, 2000)}`);
  });
});
