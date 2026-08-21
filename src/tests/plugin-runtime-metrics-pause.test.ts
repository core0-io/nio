// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * The export timer follows the monitor gate.
 *
 * `plugin-runtime.ts` deferred provider creation until first monitored
 * use, and recorded what that did NOT fix as a "KNOWN RESIDUAL
 * LIMITATION": once any session in the process had been armed and
 * recorded a counter, the reader kept exporting the accumulated totals
 * every second until the process exited. Measured after `/nio monitor
 * off` on a live host: `nio.turn.count` constant at 5, a fresh sample
 * every second across 163 series, until the process was killed.
 *
 * THE CONSTRAINT THAT SHAPES THIS
 *
 * The gate is per SESSION. The MeterProvider and its timer are per
 * PROCESS, and the in-process hosts (Pi, opencode, OpenClaw) serve many
 * sessions from one process. So the timer cannot follow any single
 * `off`: it follows whether the process still has ANY monitored session.
 * Disarming one of two sessions must leave the timer running, or one
 * user's `off` silently blinds another user's `on`.
 *
 * The gate is consulted per event, so the timer is re-synced per event
 * too — `off` takes effect on the next event, exactly as the gate does.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempDir } from './helpers/tmp-dirs.js';
import { InProcessPluginRuntime } from '../adapters/plugin-runtime.js';
import { closeOtlpSink } from './helpers/otlp-sink.js';
import { OpenClawAdapter } from '../adapters/openclaw.js';

const STORE = 'monitored-sessions.json';

/** Arm the given sessions, replacing whatever the store held. */
function armOnly(home: string, ...sessionIds: string[]): void {
  const sessions: Record<string, unknown> = {};
  for (const id of sessionIds) {
    sessions[id] = { armed_at: Date.now(), cwd: process.cwd() };
  }
  writeFileSync(join(home, STORE), JSON.stringify({ sessions }), 'utf-8');
}

/**
 * A sink that accepts and discards OTLP posts.
 *
 * Pointing at a dead port instead would work, but `pause()` ends in a
 * flush and that flush would then sit through the exporter's connect
 * timeout — measured at 10-16 s PER TEST. A listener that answers
 * immediately keeps these tests honest about what they assert (the timer
 * state) instead of timing the TCP stack.
 */
async function startSink(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(200); res.end('{}'); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as { port: number }).port };
}

function freshHome(port: number): string {
  const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-metrics-pause-')));
  process.env['NIO_HOME'] = home;
  writeFileSync(
    join(home, 'config.yaml'),
    `collector:\n  endpoint: "http://127.0.0.1:${port}"\n`,
    'utf-8',
  );
  return home;
}

function makeRuntime(): InProcessPluginRuntime {
  return new InProcessPluginRuntime({ platform: 'openclaw', adapter: new OpenClawAdapter() });
}

/**
 * Drive one event through the runtime, which is what re-syncs the gate.
 *
 * `recordTurnMetric` is the shortest path that consults the gate AND
 * reaches the meter provider — it calls `isMonitored` before deciding
 * anything, so it re-syncs the timer on the disarmed path too, which is
 * the path most of these tests turn on.
 */
async function event(rt: InProcessPluginRuntime, sessionId: string): Promise<void> {
  await rt.recordTurnMetric(sessionId);
}

describe('plugin runtime: the metrics export timer follows the gate', () => {
  let home: string;
  let sink: { server: Server; port: number };

  beforeEach(async () => {
    sink = await startSink();
    home = freshHome(sink.port);
  });

  // Providers must go down BEFORE the sink does, or the reader spends
  // the rest of the worker's life retrying into a dead port — a ref'd
  // libuv handle per attempt, so `node --test` never exits. That is what
  // `closeOtlpSink` sequences; see plugin-runtime-provider-lifetime.test.ts.
  afterEach(async () => { await closeOtlpSink(sink.server); });

  it('runs while a monitored session is active', async () => {
    armOnly(home, 'sess-a');
    const rt = makeRuntime();

    await event(rt, 'sess-a');

    assert.equal(rt._metricsExportRunningForTests(), true,
      'an armed session must have a running export timer');
  });

  it('stops once the last monitored session is disarmed', async () => {
    armOnly(home, 'sess-a');
    const rt = makeRuntime();
    await event(rt, 'sess-a');
    assert.equal(rt._metricsExportRunningForTests(), true, 'sanity: it was running');

    armOnly(home); // `/nio monitor off`
    await event(rt, 'sess-a');

    assert.equal(rt._metricsExportRunningForTests(), false,
      'nothing is monitored any more, so nothing may keep exporting');
  });

  it('keeps running while ANOTHER session is still monitored', async () => {
    // The constraint that rules out "off disables the timer": one
    // session's off must not blind a second session's on.
    armOnly(home, 'sess-a', 'sess-b');
    const rt = makeRuntime();
    await event(rt, 'sess-a');
    await event(rt, 'sess-b');

    armOnly(home, 'sess-b'); // only sess-a is disarmed
    await event(rt, 'sess-a');

    assert.equal(rt._metricsExportRunningForTests(), true,
      'sess-b is still armed, so the timer must keep running');
  });

  it('resumes when a session is armed again', async () => {
    armOnly(home, 'sess-a');
    const rt = makeRuntime();
    await event(rt, 'sess-a');
    armOnly(home);
    await event(rt, 'sess-a');
    assert.equal(rt._metricsExportRunningForTests(), false, 'sanity: paused');

    armOnly(home, 'sess-a');
    await event(rt, 'sess-a');

    assert.equal(rt._metricsExportRunningForTests(), true,
      're-arming brings the timer back on the same provider');
  });

  it('reports nothing running when no provider was ever built', async () => {
    const rt = makeRuntime();

    await event(rt, 'never-armed');

    assert.equal(rt._providersBuiltForTests(), false, 'sanity: still lazy');
    assert.equal(rt._metricsExportRunningForTests(), false,
      'a never-armed host has no timer to report on');
  });

  it('stops the timer when a monitored session ends', async () => {
    armOnly(home, 'sess-a');
    const rt = makeRuntime();
    await event(rt, 'sess-a');
    assert.equal(rt._metricsExportRunningForTests(), true, 'sanity: running');

    armOnly(home);
    await rt.onSessionEnd('sess-a');

    assert.equal(rt._metricsExportRunningForTests(), false,
      'a session that ended cannot keep the timer alive');
  });
});
