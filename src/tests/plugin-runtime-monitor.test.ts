// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * The monitor gate, at the runtime layer.
 *
 * `InProcessPluginRuntime` is shared by OpenClaw, Pi and opencode — all
 * long-running hosts that load Nio as a module. Its constructor used to
 * build the tracer, meter and logger providers unconditionally, at
 * plugin registration: before any session exists, so before anyone could
 * know whether a session was armed. These tests pin the two halves of
 * the fix — providers are built lazily, and only a monitored session
 * reaches a provider constructor at all — plus the invariant that cuts
 * the other way: the on-disk audit log is never gated.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempDir } from './helpers/tmp-dirs.js';
import { InProcessPluginRuntime } from '../adapters/plugin-runtime.js';
import { OpenClawAdapter } from '../adapters/openclaw.js';
import { makeInMemoryLogger } from './helpers/logger.js';

const STORE = 'monitored-sessions.json';

/**
 * Arm a session the same way `/nio monitor on` does, by writing the
 * store the gate reads. Writing the store directly (rather than shelling
 * out to monitor-cli) keeps this a unit test, but the shape must match
 * what `monitor-store.ts` actually reads or the gate silently never
 * matches — `saveMonitorStore`'s own shape, kept in sync by
 * monitor-store.test.ts.
 */
function armSession(home: string, sessionId: string, cwd: string): void {
  writeFileSync(
    join(home, STORE),
    JSON.stringify({ sessions: { [sessionId]: { armed_at: Date.now(), cwd } } }),
    'utf-8',
  );
}

function readStore(home: string): { sessions: Record<string, unknown> } {
  return JSON.parse(readFileSync(join(home, STORE), 'utf-8')) as {
    sessions: Record<string, unknown>;
  };
}

/**
 * A fresh NIO_HOME per test. Mutating `process.env.NIO_HOME` is safe
 * only under node:test's default serial-within-a-file execution — the
 * runtime reads it through `loadConfig()` / the monitor store with no
 * injectable seam. Never left empty: `NIO_HOME=''` would fall through
 * to the developer's real `~/.nio`.
 */
function freshHome(): string {
  const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-runtime-monitor-')));
  process.env['NIO_HOME'] = home;
  return home;
}

function makeRuntime(): InProcessPluginRuntime {
  return new InProcessPluginRuntime({ platform: 'openclaw', adapter: new OpenClawAdapter() });
}

describe('plugin runtime: providers are lazy and gated', () => {
  let home: string;
  beforeEach(() => { home = freshHome(); });

  it('constructs no provider at registration time', async () => {
    writeFileSync(
      join(home, 'config.yaml'),
      'collector:\n  endpoint: "http://127.0.0.1:59999"\n',
      'utf-8',
    );

    const rt = makeRuntime();

    // The gate's whole point: merely registering the plugin must not
    // stand up an OTLP client for a user who never armed anything.
    assert.equal(
      rt._providersBuiltForTests(), false,
      'no provider may exist before a monitored session is seen',
    );
  });

  it('an unmonitored session never builds a provider', async () => {
    const rt = makeRuntime();

    rt.onSessionStart('sess-unarmed');
    rt.onUserPrompt('sess-unarmed', 'hello');
    await rt.onTurnEnd('sess-unarmed');

    assert.equal(
      rt._providersBuiltForTests(), false,
      'an unarmed session must not reach a provider constructor',
    );
  });

  it('an armed session does build providers', async () => {
    armSession(home, 'sess-armed', process.cwd());
    const rt = makeRuntime();

    rt.onSessionStart('sess-armed');
    rt.onUserPrompt('sess-armed', 'hello');

    assert.equal(
      rt._providersBuiltForTests(), true,
      'an armed session must build providers on first monitored use',
    );
  });

  it('keeps writing the local audit log for an unmonitored session', async () => {
    const auditPath = join(home, 'audit.jsonl');
    writeFileSync(
      join(home, 'config.yaml'),
      `collector:\n  logs:\n    path: "${auditPath}"\n`,
      'utf-8',
    );
    const rt = makeRuntime();

    rt.onSessionStart('sess-unarmed');

    // Invariant: the monitor gate governs OTLP export only. The on-disk
    // audit log is the user's own record and is never gated.
    assert.ok(
      existsSync(auditPath),
      'local audit log must be written regardless of monitor state',
    );
  });

  it('drops the arm record at session end so the session stops being armed', async () => {
    // Pins the `forgetSession` call in `onSessionEnd`. These are
    // long-running hosts: a session that ends here gets no other chance
    // to be reaped until the process restarts or the 7-day TTL backstop
    // fires, so an arm record left behind keeps a dead session id armed
    // for a week — and re-arms it for free if the host recycles the id.
    armSession(home, 'sess-ends', process.cwd());
    const rt = makeRuntime();

    rt.onSessionStart('sess-ends');
    assert.deepEqual(
      Object.keys(readStore(home).sessions), ['sess-ends'],
      'sanity: the session is armed before it ends',
    );

    await rt.onSessionEnd('sess-ends');

    assert.deepEqual(
      Object.keys(readStore(home).sessions), [],
      'session end must drop the arm record, not leave it for the TTL backstop',
    );
  });

  it('never puts an unmonitored session\'s audit rows on the OTLP logs signal', async () => {
    // The other half of the audit invariant. "Local log always, OTLP leg
    // only when monitored" is not provable by the not-built assertions
    // above once a provider already exists — which it does the moment
    // any session in this long-lived process is armed. So: arm one
    // session, prove its rows DO reach the logs signal, then drive an
    // unarmed one through the same code path and prove it adds nothing.
    const logger = makeInMemoryLogger();
    try {
      armSession(home, 'sess-armed', process.cwd());
      const rt = new InProcessPluginRuntime({
        platform: 'openclaw',
        adapter: new OpenClawAdapter(),
        loggerProvider: logger.provider,
      });

      rt.onSessionStart('sess-armed');
      const armedRecords = logger.emitted().length;
      assert.ok(armedRecords > 0, 'sanity: an armed session does export its audit rows');

      rt.onSessionStart('sess-unarmed');

      assert.equal(
        logger.emitted().length, armedRecords,
        'an unarmed session must add no OTLP audit record, even once a provider exists',
      );
    } finally {
      await logger.shutdown();
    }
  });

  it('still evaluates and blocks a dangerous call on an unmonitored session', async () => {
    // Guard and monitor are orthogonal. With capture off the guard must
    // block exactly as before — a monitor state that could disable
    // enforcement would be a far worse bug than a missing span.
    const rt = makeRuntime();

    const r = await rt.onPreTool(
      'sess-unarmed', 'call-1', 'exec', { command: 'rm -rf /' },
      { toolName: 'exec', params: { command: 'rm -rf /' } },
    );

    assert.equal(r.block, true, 'an unarmed session must still be guarded');
    assert.equal(r.decision, 'deny');
    assert.equal(
      rt._providersBuiltForTests(), false,
      'and guarding it must still not build a provider',
    );
  });
});
