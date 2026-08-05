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

/**
 * Exposes the three protected provider getters so a test can assert on
 * the resolution itself (identity, caching) rather than only on the
 * "was anything built" side effect.
 */
class ProbeRuntime extends InProcessPluginRuntime {
  tracer(): unknown { return this.getTracerProvider(); }
  meter(): unknown { return this.getMeterProvider(); }
  logger(): unknown { return this.getLoggerProvider(); }
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

  // ── `undefined` (build from config) vs `null` (explicitly disabled) ──
  //
  // All three provider options document this distinction, and all three
  // getters implement it with `!== undefined`. Nothing pinned it:
  // relaxing any of them to `!= null` — the single most likely
  // "simplification" — silently turns an explicit `null` back into
  // "build from config", which is exactly the OTLP client the injecting
  // caller (a test, or a host that disabled one signal) asked NOT to
  // exist. Each test below drives only the one code path that resolves
  // its own provider, so it can only go red for its own getter.

  it('an explicit null tracerProvider is never rebuilt from config (I3)', () => {
    armSession(home, 'sess-armed', process.cwd());
    writeFileSync(
      join(home, 'config.yaml'),
      'collector:\n  endpoint: "http://127.0.0.1:59999"\n',
      'utf-8',
    );
    const rt = new InProcessPluginRuntime({
      platform: 'openclaw', adapter: new OpenClawAdapter(), tracerProvider: null,
    });

    // Monitored, and onUserPrompt resolves the tracer provider (only).
    rt.onUserPrompt('sess-armed', 'hello');

    assert.equal(
      rt._providersBuiltForTests(), false,
      'null means "tracing off", not "fall back to the configured endpoint"',
    );
  });

  it('an explicit null meterProvider is never rebuilt from config (I3)', async () => {
    armSession(home, 'sess-armed', process.cwd());
    writeFileSync(
      join(home, 'config.yaml'),
      'collector:\n  endpoint: "http://127.0.0.1:59999"\n',
      'utf-8',
    );
    const rt = new InProcessPluginRuntime({
      platform: 'openclaw', adapter: new OpenClawAdapter(), meterProvider: null,
    });

    await rt.recordTurnMetric('sess-armed');

    assert.equal(rt._providersBuiltForTests(), false);
  });

  it('an explicit null loggerProvider is never rebuilt from config (I3)', () => {
    armSession(home, 'sess-armed', process.cwd());
    writeFileSync(
      join(home, 'config.yaml'),
      'collector:\n  endpoint: "http://127.0.0.1:59999"\n',
      'utf-8',
    );
    const rt = new InProcessPluginRuntime({
      platform: 'openclaw', adapter: new OpenClawAdapter(), loggerProvider: null,
    });

    // The lifecycle audit row is where auditOptsFor resolves the logger.
    rt.onSessionStart('sess-armed');

    assert.equal(rt._providersBuiltForTests(), false);
  });

  it('resolves each provider once and reuses the instance (M6)', async () => {
    // Without this, a getter that rebuilt on every call would look
    // perfectly healthy: every existing assertion is about whether a
    // provider exists, never about how many were made. The real cost is
    // one OTLP exporter (and, for metrics, one 1s interval timer) per
    // event for the life of the host process.
    armSession(home, 'sess-armed', process.cwd());
    writeFileSync(
      join(home, 'config.yaml'),
      'collector:\n  endpoint: "http://127.0.0.1:59999"\n',
      'utf-8',
    );
    const rt = new ProbeRuntime({ platform: 'openclaw', adapter: new OpenClawAdapter() });

    const tracer = rt.tracer();
    const meter = rt.meter();
    const logger = rt.logger();
    try {
      // Sanity: a configured endpoint must actually yield providers, or
      // the identity assertions below would compare null to null and
      // pass against any implementation.
      assert.ok(tracer, 'sanity: a configured endpoint builds a tracer provider');
      assert.ok(meter, 'sanity: a configured endpoint builds a meter provider');
      assert.ok(logger, 'sanity: a configured endpoint builds a logger provider');

      assert.equal(rt.tracer(), tracer, 'the tracer provider must be cached, not rebuilt');
      assert.equal(rt.meter(), meter, 'the meter provider must be cached, not rebuilt');
      assert.equal(rt.logger(), logger, 'the logger provider must be cached, not rebuilt');
    } finally {
      for (const p of [tracer, meter, logger]) {
        await (p as { shutdown(): Promise<unknown> }).shutdown();
      }
    }
  });

  it('writes the local audit log to a custom collector.logs.path (I4)', () => {
    // The path has to differ from the default — `${NIO_HOME}/audit.jsonl`
    // — or the assertion passes even when `auditOptsFor` drops
    // `logsConfig` entirely and the writer falls back to that default.
    const auditPath = join(home, 'nested', 'custom-audit.jsonl');
    writeFileSync(
      join(home, 'config.yaml'),
      `collector:\n  logs:\n    path: "${auditPath}"\n`,
      'utf-8',
    );
    const rt = makeRuntime();

    rt.onSessionStart('sess-x');

    assert.ok(
      existsSync(auditPath),
      'the operator\'s configured audit path must be honoured by the in-process runtime',
    );
    assert.equal(
      existsSync(join(home, 'audit.jsonl')), false,
      'and the default path must not be written instead',
    );
  });

  it('process-wide dispose never builds a logger provider (I5)', async () => {
    // opencode calls `dispose()` on every plugin teardown, armed or not.
    // Resolving (rather than merely flushing an existing) logger there
    // would stand up an OTLP client at shutdown for a process whose user
    // never armed a single session — the one thing the gate exists to
    // prevent, on the one path with no session id to check.
    const rt = makeRuntime();

    await rt.disposeAllSessions();

    assert.equal(
      rt._providersBuiltForTests(), false,
      'dispose must flush whatever already exists, never construct one',
    );
  });

  it('onLlmUsage accumulates nothing for an unmonitored session (M8)', () => {
    // The sibling capture methods (onUserPrompt / onAssistantReply) have
    // their gate covered by the "unmonitored session never builds a
    // provider" test above, because they resolve a provider. onLlmUsage
    // does not resolve anything, so its gate was invisible: deleting it
    // left the whole suite green while every unarmed session in a
    // long-lived host started accumulating CollectorState.
    const rt = makeRuntime();

    rt.onLlmUsage('sess-unarmed', { input: 10, output: 5 });

    assert.equal(
      rt.hasSessionState('sess-unarmed'), false,
      'an unarmed session must not accumulate turn state',
    );
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
