// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * The monitor gate on a host that serves MANY sessions from ONE process.
 *
 * `InProcessPluginRuntime` asked `isSessionMonitored` about a session
 * using `process.cwd()`. On Claude Code, Codex and Hermes that happens to
 * be right — each hook event is its own process, launched in the session's
 * directory, so the process cwd IS the session cwd. On OpenClaw, Pi and
 * opencode it is a category error: the host process's cwd is fixed when
 * the host starts and is shared by every session it will ever serve,
 * while the directory is a per-session property. A process-wide constant
 * cannot answer a per-session question, so the gate's cwd comparison
 * degenerates to "every session matches" or "no session matches",
 * depending only on where the host happened to be launched.
 *
 * ── Why a green suite could not see it ───────────────────────────────
 *
 * Every existing test in this area arms with `process.cwd()` and then
 * asserts against a runtime whose gate also reads `process.cwd()` — the
 * two wrongs cancel, and the assertion passes for a reason that has
 * nothing to do with the session. The condition the defect needs cannot
 * even be stated in that setup.
 *
 * So every case in this file establishes, and asserts, that the session's
 * directory is NOT the host process's directory. That inequality is the
 * whole point: comment it out and the file goes back to being unable to
 * see the bug. No `chdir` is involved — the session directory is a fresh
 * tmpdir and the host process stays wherever the test runner put it.
 *
 * ── What is deliberately NOT relaxed ─────────────────────────────────
 *
 * The cwd match exists to stop one session claiming another session's
 * pending arm — two projects on one machine must not share an arm. Making
 * the gate cwd-aware makes that check REAL on these platforms for the
 * first time (it was previously inert: every session presented the same
 * directory). `refuses to hand a pending arm to a session in a different
 * directory` and `two sessions, one arm` pin that, and the unarmed case
 * pins that capture is still off by default.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-node';
import { trackTempDir } from './helpers/tmp-dirs.js';
import { makeInMemoryTracer, type InMemoryTracer } from './helpers/tracer.js';
import { InProcessPluginRuntime } from '../adapters/plugin-runtime.js';
import { OpenClawAdapter } from '../adapters/openclaw.js';

const STORE = 'monitored-sessions.json';

interface StoreShape {
  sessions: Record<string, { armed_at: number; cwd: string }>;
  pending_arm?: { at: number; cwd: string };
}

/**
 * Write the store `/nio monitor on` writes when it cannot resolve a
 * session id — which is every platform in this family, permanently:
 * `resolveSessionId` reads Claude Code's environment variable and
 * nothing else. So the pending arm is not an edge case here, it is the
 * ONLY way one of these sessions ever becomes armed, which is why these
 * tests exercise it rather than pre-seeding `sessions`.
 */
function pendingArm(home: string, cwd: string): void {
  writeFileSync(
    join(home, STORE),
    JSON.stringify({ sessions: {}, pending_arm: { at: Date.now(), cwd } }),
    'utf-8',
  );
}

function readStore(home: string): StoreShape {
  return JSON.parse(readFileSync(join(home, STORE), 'utf-8')) as StoreShape;
}

/** A fresh directory, canonicalised — `/var` and `/tmp` are symlinks on macOS. */
function freshDir(prefix: string): string {
  return realpathSync(trackTempDir(mkdtempSync(join(tmpdir(), prefix))));
}

/** Guard verdict stub — none of these tests runs real Phase 0–6. */
function stubNioAllow(): never {
  return (() => ({
    orchestrator: {
      async evaluate() {
        return {
          decision: 'allow', risk_level: 'low', scores: { final: 0 },
          findings: [], explanation: 'test verdict', phase_stopped: 1, diagnostics: [],
        };
      },
    },
  })) as never;
}

/**
 * Drive one tool call and close the turn. Returns every span exported.
 *
 * Spans, not `_providersBuiltForTests()`, because "was telemetry
 * COLLECTED" is the user-visible question — a provider that exists and is
 * never written to would satisfy the weaker check.
 */
async function runOneTurn(
  rt: InProcessPluginRuntime,
  sessionId: string,
  tracer: InMemoryTracer,
): Promise<readonly ReadableSpan[]> {
  rt.onUserPrompt(sessionId, 'do the thing');
  await rt.onPreTool(sessionId, 'call-1', 'bash', { command: 'ls' }, {}, {
    toolCallId: 'call-1',
  });
  await rt.onPostTool(sessionId, 'call-1', 'bash', { result: 'a.txt', error: null });
  await rt.onTurnEnd(sessionId);
  return tracer.finished();
}

function makeRuntime(tracer: InMemoryTracer, defaultCwd?: string): InProcessPluginRuntime {
  return new InProcessPluginRuntime({
    platform: 'pi',
    adapter: new OpenClawAdapter(),
    nioFactory: stubNioAllow(),
    tracerProvider: tracer.provider,
    // Explicitly null, not omitted: `undefined` has the runtime build a
    // real MeterProvider whose 1s export timer outlives the test process.
    meterProvider: null,
    loggerProvider: null,
    ...(defaultCwd ? { defaultCwd } : {}),
  });
}

describe('in-process runtime: the monitor gate is keyed to the SESSION cwd', () => {
  let home: string;
  let sessionDir: string;
  let previousHome: string | undefined;
  let tracer: InMemoryTracer;

  beforeEach(() => {
    home = freshDir('nio-session-cwd-home-');
    sessionDir = freshDir('nio-session-cwd-work-');
    previousHome = process.env['NIO_HOME'];
    process.env['NIO_HOME'] = home;
    tracer = makeInMemoryTracer();

    // The condition the whole file rests on. Asserted, not assumed: if
    // the host process ever ran from the session's directory these cases
    // would pass for the wrong reason, exactly as the pre-existing suite
    // did.
    assert.notEqual(
      realpathSync(process.cwd()), sessionDir,
      'the session directory must differ from the host process directory, or this file ' +
        'cannot express the defect it exists to catch',
    );
  });

  afterEach(async () => {
    await tracer.shutdown();
    if (previousHome === undefined) delete process.env['NIO_HOME'];
    else process.env['NIO_HOME'] = previousHome;
  });

  it('captures a session whose directory matches the arm but not the host process', async () => {
    pendingArm(home, sessionDir);
    const rt = makeRuntime(tracer);

    rt.setSessionCwd('sess-elsewhere', sessionDir);
    rt.onSessionStart('sess-elsewhere');
    const spans = await runOneTurn(rt, 'sess-elsewhere', tracer);

    assert.ok(
      spans.length > 0,
      'the user armed this directory and this session is working in it, so its telemetry ' +
        'must be collected — reading the HOST process cwd instead answers "no" for every ' +
        'session of every host not launched in the arming directory',
    );
    assert.deepEqual(
      Object.keys(readStore(home).sessions), ['sess-elsewhere'],
      'claiming the arm must also persist it, so the session stays armed across turns',
    );
  });

  it('refuses to hand a pending arm to a session in a different directory', async () => {
    const otherDir = freshDir('nio-session-cwd-other-');
    pendingArm(home, sessionDir);
    const rt = makeRuntime(tracer);

    rt.setSessionCwd('sess-other-project', otherDir);
    rt.onSessionStart('sess-other-project');
    const spans = await runOneTurn(rt, 'sess-other-project', tracer);

    // The privacy boundary the cwd match exists for. Arming project A
    // must never start capturing project B, and on these platforms both
    // projects can be served by one process.
    assert.equal(spans.length, 0, 'a session in another directory must not claim the arm');
    assert.deepEqual(
      readStore(home).sessions, {},
      'and must not be written into the store as armed',
    );
    assert.equal(
      readStore(home).pending_arm?.cwd, sessionDir,
      'the arm stays available for the session it was actually made for',
    );
  });

  it('gives one arm to the session that matches it, not to its neighbour', async () => {
    // Both halves in ONE runtime instance, which is the configuration the
    // defect lives in: two sessions, two directories, one process, one
    // `process.cwd()`. Whichever way that constant fell, it answered the
    // same for both — so this case cannot pass unless the gate reads
    // something per-session.
    const otherDir = freshDir('nio-session-cwd-neighbour-');
    pendingArm(home, sessionDir);
    const rt = makeRuntime(tracer);

    rt.setSessionCwd('sess-neighbour', otherDir);
    rt.onSessionStart('sess-neighbour');
    const neighbourSpans = await runOneTurn(rt, 'sess-neighbour', tracer);
    assert.equal(
      neighbourSpans.length, 0,
      'the neighbouring session must not consume an arm made in another directory',
    );

    rt.setSessionCwd('sess-armed-dir', sessionDir);
    rt.onSessionStart('sess-armed-dir');
    const spans = await runOneTurn(rt, 'sess-armed-dir', tracer);
    assert.ok(
      spans.length > 0,
      'and the arm must still be there for the session it was made for',
    );
  });

  it('emits nothing for a session in the arming directory that was never armed', async () => {
    // Capture stays off by default. No store at all — the state the
    // overwhelming majority of installs are in.
    const rt = makeRuntime(tracer);

    rt.setSessionCwd('sess-unarmed', sessionDir);
    rt.onSessionStart('sess-unarmed');
    const spans = await runOneTurn(rt, 'sess-unarmed', tracer);

    assert.equal(
      spans.length, 0,
      'making the gate cwd-aware must not arm anything by itself',
    );
  });

  it('puts the session directory on the spans, not the host process directory', async () => {
    pendingArm(home, sessionDir);
    const rt = makeRuntime(tracer);

    rt.setSessionCwd('sess-attrs', sessionDir);
    rt.onSessionStart('sess-attrs');
    const spans = await runOneTurn(rt, 'sess-attrs', tracer);

    const cwds = new Set(spans.map((s) => s.attributes['nio.cwd']));
    assert.ok(spans.length > 0, 'sanity: the session is armed, so there are spans to inspect');
    assert.deepEqual(
      [...cwds], [sessionDir],
      '`nio.cwd` claims to say where this session\'s work happened; the host process\'s ' +
        'launch directory is not that',
    );
  });

  it('falls back to the host process directory when the binding reports none', async () => {
    // OpenClaw, and not by omission: its hook context carries session
    // ids and no directory at all, because a session there is a
    // conversation rather than a checkout. Its `/nio monitor on` runs in
    // this same process and stamps `process.cwd()`, so both sides of the
    // comparison are that value and arming keeps working. Answering
    // "unknown" instead would make OpenClaw unarmable — permanently and
    // silently, since the pending arm is its only route.
    pendingArm(home, realpathSync(process.cwd()));
    const rt = makeRuntime(tracer);

    rt.onSessionStart('sess-no-cwd');
    const spans = await runOneTurn(rt, 'sess-no-cwd', tracer);

    assert.ok(
      spans.length > 0,
      'a binding that reports no directory must still be able to arm a session',
    );
  });

  it('prefers a per-session directory over the runtime-wide default', async () => {
    // opencode passes its plugin `directory` as defaultCwd. A session
    // that reports its own must still win — the default is a fallback,
    // not an override.
    const pluginDir = freshDir('nio-session-cwd-plugin-');
    pendingArm(home, sessionDir);
    const rt = makeRuntime(tracer, pluginDir);

    rt.setSessionCwd('sess-overrides-default', sessionDir);
    rt.onSessionStart('sess-overrides-default');
    const spans = await runOneTurn(rt, 'sess-overrides-default', tracer);

    assert.ok(spans.length > 0, 'the session\'s own directory must win over the default');
  });

  it('forgets a session\'s directory once the session has ended', async () => {
    // These hosts run for weeks. One map entry per session that ever
    // existed is a leak, and a recycled session id inheriting a dead
    // session's directory is worse than a leak. Asserted through the
    // resolver rather than the map so what is pinned is the answer the
    // gate gets.
    class ProbeRuntime extends InProcessPluginRuntime {
      cwdOf(sessionId: string): string { return this.cwdFor(sessionId); }
    }
    const rt = new ProbeRuntime({
      platform: 'pi',
      adapter: new OpenClawAdapter(),
      nioFactory: stubNioAllow(),
      tracerProvider: tracer.provider,
      meterProvider: null,
      loggerProvider: null,
    });

    rt.setSessionCwd('sess-ends', sessionDir);
    assert.equal(rt.cwdOf('sess-ends'), sessionDir, 'sanity: the directory was recorded');

    await rt.onSessionEnd('sess-ends');

    assert.equal(
      rt.cwdOf('sess-ends'), process.cwd(),
      'after the session ends its directory is gone and the resolver falls back',
    );
  });

  it('records the directory a shell command was run in, without a session_start', async () => {
    // Pi delivers `user_bash` with a real cwd. A session whose start
    // event we never saw (host restarted mid-session, binding wired
    // later) is keyed from the first event that carries a directory
    // rather than staying pinned to the process constant.
    pendingArm(home, sessionDir);
    const rt = makeRuntime(tracer);

    rt.onUserBash('sess-bash-only', 'ls', sessionDir);
    const spans = await runOneTurn(rt, 'sess-bash-only', tracer);

    assert.ok(spans.length > 0, 'the directory from user_bash must key the gate');
  });
});
