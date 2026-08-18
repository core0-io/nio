// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Each in-process binding reports its session's directory — or is
 * documented as unable to.
 *
 * `plugin-runtime-session-cwd.test.ts` pins the gate itself: given a
 * session directory, the right session is captured. That is only half the
 * fix. The runtime learns a directory solely from what its binding hands
 * over, so a binding that never calls `setSessionCwd` leaves its whole
 * platform unable to key its sessions at all — either silently unarmable
 * or, if it declared the process-wide fallback it has no business
 * declaring, exactly as broken as before. These cases drive the REAL
 * bindings (`registerPiExtension`, `createNioPlugin`,
 * `registerOpenClawPlugin`) so the wiring is what is exercised, not a
 * hand-fed runtime.
 *
 * Both halves have to agree, and both are asserted here:
 *
 *  - the ARM side. `/nio monitor on` inside one of these hosts stamps the
 *    directory the arm is keyed to. Threading the session's directory
 *    into the gate while `monitor on` keeps stamping the host process's
 *    would break arming outright — the arm would name a directory no
 *    session is in and expire unclaimed after 60s, silently.
 *  - the EVENT side. The session's own events must present the same
 *    directory, or the arm is never claimed.
 *
 * And both sides must agree on the FORM of the directory, not just its
 * value: the store canonicalises what it writes and the gate
 * canonicalises what it compares, so a host-supplied path that skips
 * either one is unclaimable. That is its own case now that the value
 * comes from the host rather than from `process.cwd()`.
 *
 * Every case that HAS a session directory makes it a fresh tmpdir, so it
 * is not the host process's directory — the inequality the defect needs,
 * asserted rather than assumed in `beforeEach`. The two exceptions say so
 * in their own comments and are deliberate: the OpenClaw case, whose
 * whole point is a session with no directory, and the symlink case, whose
 * fixture supplies a second non-canonical name for one.
 *
 * OpenClaw has nothing to REPORT — its hook context carries
 * `sessionKey` / `sessionId` / `runId` and no directory of any kind — but
 * it does have something to DECLARE, and that declaration is wiring like
 * any other: because no OpenClaw session can present a directory, its
 * binding is the only one that passes `processCwdFallback: true`, and
 * without it every OpenClaw session becomes permanently unarmable. So it
 * gets a case here too, driving the real `registerOpenClawPlugin`
 * through the pending-arm route. `plugin-runtime-session-cwd.test.ts`
 * pins the runtime option itself; nothing there can see whether the
 * binding sets it.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempDir } from './helpers/tmp-dirs.js';
import { makeInMemoryTracer, type InMemoryTracer } from './helpers/tracer.js';

const STORE = 'monitored-sessions.json';

interface StoreShape {
  sessions: Record<string, { armed_at: number; cwd: string }>;
  pending_arm?: { at: number; cwd: string };
}

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

function freshDir(prefix: string): string {
  return realpathSync(trackTempDir(mkdtempSync(join(tmpdir(), prefix))));
}

/**
 * A directory reachable by two names: the canonical one, and a symlink
 * pointing at it.
 *
 * The host, not `process.cwd()`, is what supplies a directory now — Pi's
 * `ctx.cwd` and opencode's `input.directory` are strings the host chose,
 * so they arrive in whatever form IT holds. POSIX always reports
 * `process.cwd()` resolved, which is exactly why every other fixture in
 * this file (`freshDir` realpaths) cannot express an unresolved one, and
 * why a symlink is built explicitly rather than relying on macOS's
 * `/var` → `/private/var`: that trick is a no-op on Linux and would make
 * the case below vacuous on CI.
 */
function linkedDir(prefix: string): { real: string; link: string } {
  const real = freshDir(`${prefix}real-`);
  const link = join(freshDir(`${prefix}link-`), 'as-linked');
  symlinkSync(real, link);
  return { real, link };
}

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

describe('in-process bindings report their session directory', () => {
  let home: string;
  let sessionDir: string;
  let previousHome: string | undefined;
  let previousCcSession: string | undefined;
  let tracer: InMemoryTracer;

  beforeEach(() => {
    home = freshDir('nio-binding-cwd-home-');
    sessionDir = freshDir('nio-binding-cwd-work-');
    previousHome = process.env['NIO_HOME'];
    process.env['NIO_HOME'] = home;
    // `resolveSessionId` reads Claude Code's session variable and takes
    // the DIRECT arming path when it is set — which it is whenever this
    // suite runs inside a Claude Code session, and which would arm an id
    // no Pi/opencode session will ever present. Cleared so these cases
    // exercise the pending-arm route that is these platforms' only one.
    previousCcSession = process.env['CLAUDE_CODE_SESSION_ID'];
    delete process.env['CLAUDE_CODE_SESSION_ID'];
    tracer = makeInMemoryTracer();
    assert.notEqual(
      realpathSync(process.cwd()), sessionDir,
      'the session directory must differ from the host process directory',
    );
  });

  afterEach(async () => {
    await tracer.shutdown();
    if (previousHome === undefined) delete process.env['NIO_HOME'];
    else process.env['NIO_HOME'] = previousHome;
    if (previousCcSession === undefined) delete process.env['CLAUDE_CODE_SESSION_ID'];
    else process.env['CLAUDE_CODE_SESSION_ID'] = previousCcSession;
  });

  // ── Pi ───────────────────────────────────────────────────────────────

  /** Register the Pi extension against a fake Pi API; return its handlers. */
  async function registerPi(cwd?: string): Promise<{
    handlers: Map<string, (e: unknown, c: unknown) => Promise<unknown> | unknown>;
    commands: Map<string, (args: string, ctx: unknown) => Promise<void> | void>;
    ctx: unknown;
  }> {
    const { registerPiExtension } = await import('../adapters/pi-plugin.js');
    const handlers = new Map<string, (e: unknown, c: unknown) => Promise<unknown> | unknown>();
    const commands = new Map<string, (args: string, ctx: unknown) => Promise<void> | void>();
    registerPiExtension(
      {
        on(name: string, fn: (e: unknown, c: unknown) => Promise<unknown> | unknown) {
          handlers.set(name, fn);
        },
        registerCommand(name: string, opts: {
          handler: (args: string, ctx: unknown) => Promise<void> | void;
        }) {
          commands.set(name, opts.handler);
        },
      } as never,
      {
        nioFactory: stubNioAllow(),
        tracerProvider: tracer.provider,
        meterProvider: null,
        loggerProvider: null,
      },
    );
    const ctx = {
      hasUI: false,
      // Pi's per-session working directory — the field this fix reads.
      cwd: cwd ?? sessionDir,
      ui: { async confirm() { return true; }, notify() { /* no-op */ } },
      sessionManager: {
        getSessionId: () => 'pi-cwd-session',
        getSessionFile: () => null,
      },
    };
    return { handlers, commands, ctx };
  }

  it('pi: a session in a directory the host was not launched in is captured', async () => {
    pendingArm(home, sessionDir);
    const { handlers, ctx } = await registerPi();

    await handlers.get('session_start')!({}, ctx);
    await handlers.get('input')!({ text: 'list the files' }, ctx);
    await handlers.get('tool_call')!(
      { toolName: 'bash', toolCallId: 'call-1', input: { command: 'ls' } }, ctx,
    );
    await handlers.get('tool_result')!(
      { toolName: 'bash', toolCallId: 'call-1', content: 'a.txt', isError: false }, ctx,
    );
    await handlers.get('agent_end')!({}, ctx);

    const spans = tracer.finished();
    assert.ok(
      spans.length > 0,
      'Pi hands a real per-session cwd on every ctx; the gate must use it rather than the ' +
        'directory the pi process was started in',
    );
    assert.deepEqual(
      Object.keys(readStore(home).sessions), ['pi-cwd-session'],
      'and the arm must be claimed by that session id',
    );
  });

  it('pi: a session it never saw start is still keyed to its directory', async () => {
    // Pi's cwd is read off the ctx every handler already receives, not
    // off `session_start` alone. That matters for a session the
    // extension was loaded into mid-flight, and it removes an ordering
    // assumption the binding has no way to enforce: the host decides
    // which event arrives first, not us.
    pendingArm(home, sessionDir);
    const { handlers, ctx } = await registerPi();

    await handlers.get('tool_call')!(
      { toolName: 'bash', toolCallId: 'call-3', input: { command: 'ls' } }, ctx,
    );
    await handlers.get('tool_result')!(
      { toolName: 'bash', toolCallId: 'call-3', content: 'a.txt', isError: false }, ctx,
    );
    await handlers.get('agent_end')!({}, ctx);

    assert.ok(
      (tracer.finished()).length > 0,
      'the first event carrying a ctx must be enough to key the session',
    );
  });

  it('pi: /nio monitor on keys the arm to the session directory', async () => {
    const { commands, ctx } = await registerPi();

    await commands.get('nio')!('monitor on', ctx);

    assert.equal(
      readStore(home).pending_arm?.cwd, sessionDir,
      'the arm must name the directory the user typed the command in. Stamping the host ' +
        'process directory instead names a directory no session may be in, and the request ' +
        'expires unclaimed after 60s with capture never starting',
    );
  });

  it('pi: monitor on canonicalises the directory the HOST supplied', async () => {
    // `runMonitorCommand` canonicalises the value that enters the store,
    // and it has to canonicalise the CALLER'S value, not `process.cwd()`
    // before falling back to it. The gate canonicalises the event's cwd
    // before comparing (monitor-check.ts), so an arm stored unresolved
    // can never be claimed — `/nio monitor on` would report success and
    // capture would simply never start, with nothing logged.
    //
    // This could not bite while every caller passed `process.cwd()`,
    // which POSIX reports resolved. It can now: Pi hands over whatever
    // string it holds for the session.
    const { real, link } = linkedDir('nio-binding-cwd-symlink-');
    assert.notEqual(link, real, 'sanity: the fixture supplies a non-canonical path');

    const { handlers, commands, ctx } = await registerPi(link);
    await commands.get('nio')!('monitor on', ctx);

    assert.equal(
      readStore(home).pending_arm?.cwd, real,
      'the arm must be stored canonicalised, or the gate can never match it',
    );

    // And the round trip: the same session, presenting the same
    // non-canonical path, claims it.
    await handlers.get('session_start')!({}, ctx);
    await handlers.get('input')!({ text: 'hello' }, ctx);
    await handlers.get('tool_call')!(
      { toolName: 'bash', toolCallId: 'call-sym', input: { command: 'ls' } }, ctx,
    );
    await handlers.get('tool_result')!(
      { toolName: 'bash', toolCallId: 'call-sym', content: 'a.txt', isError: false }, ctx,
    );
    await handlers.get('agent_end')!({}, ctx);

    assert.ok(
      (tracer.finished()).length > 0,
      'both sides canonicalise, so the arm made through the symlink is claimed through it',
    );
  });

  it('pi: monitor on, then the session that asked for it gets captured', async () => {
    // The two halves against each other, in one process: nothing in this
    // case knows what directory either side chose, so it fails if they
    // disagree — which is the failure mode a one-sided fix produces.
    const { handlers, commands, ctx } = await registerPi();

    await commands.get('nio')!('monitor on', ctx);
    await handlers.get('session_start')!({}, ctx);
    await handlers.get('input')!({ text: 'hello' }, ctx);
    await handlers.get('tool_call')!(
      { toolName: 'bash', toolCallId: 'call-2', input: { command: 'ls' } }, ctx,
    );
    await handlers.get('tool_result')!(
      { toolName: 'bash', toolCallId: 'call-2', content: 'a.txt', isError: false }, ctx,
    );
    await handlers.get('agent_end')!({}, ctx);

    assert.ok(
      (tracer.finished()).length > 0,
      'arming from a session and then using that session must capture it',
    );
  });

  // ── OpenClaw ─────────────────────────────────────────────────────────

  it('openclaw: a session that can report no directory at all is still armable', async () => {
    // The binding declares `processCwdFallback: true` because no
    // OpenClaw session can ever present a directory. Drop that
    // declaration and `cwdFor` answers `null`, which matches no pending
    // arm — and the pending arm is the ONLY route to arming here, so
    // OpenClaw would go permanently silent with `/nio monitor on` still
    // reporting success.
    //
    // Armed in the host process's directory on purpose: that is the
    // value OpenClaw's own `/nio monitor on` stamps, since it runs in
    // this same process, so both sides of the gate's comparison are it.
    pendingArm(home, realpathSync(process.cwd()));
    const { registerOpenClawPlugin } = await import('../adapters/openclaw-plugin.js');
    const handlers = new Map<string, (e: unknown, c: unknown) => Promise<unknown> | unknown>();
    registerOpenClawPlugin(
      {
        on(name: string, fn: (e: unknown, c: unknown) => Promise<unknown> | unknown) {
          handlers.set(name, fn);
        },
        registerTool() { /* not exercised here */ },
      } as never,
      {
        nioFactory: stubNioAllow(),
        tracerProvider: tracer.provider,
        meterProvider: null,
      },
    );

    // OpenClaw's ctx: session identity and no directory field anywhere.
    const ctx = { sessionKey: 'oc-cwd-session' };
    await handlers.get('session_start')!({}, ctx);
    await handlers.get('before_agent_reply')!({ cleanedBody: 'hello' }, ctx);
    await handlers.get('before_tool_call')!(
      { toolName: 'exec', toolCallId: 'call-oc', params: { command: 'ls' } }, ctx,
    );
    await handlers.get('after_tool_call')!(
      { toolName: 'exec', toolCallId: 'call-oc', result: 'a.txt' }, ctx,
    );
    await handlers.get('agent_end')!({}, ctx);

    assert.ok(
      (tracer.finished()).length > 0,
      'OpenClaw must stay armable through the pending arm despite reporting no directory',
    );
  });

  // ── opencode ─────────────────────────────────────────────────────────

  it('opencode: the plugin directory, not the server launch directory, keys the gate', async () => {
    // opencode builds one plugin instance per project directory and
    // hands it in as `input.directory`. The opencode SERVER may have
    // been started anywhere — `process.cwd()` is its launch directory
    // and is shared by every project it serves.
    pendingArm(home, sessionDir);
    const { createNioPlugin } = await import('../adapters/opencode-plugin.js');
    const hooks = await createNioPlugin({
      nioFactory: stubNioAllow(),
      tracerProvider: tracer.provider,
      meterProvider: null,
      loggerProvider: null,
    })({ directory: sessionDir, worktree: sessionDir });

    await hooks.event!({
      event: { type: 'session.created', properties: { info: { id: 'oc-cwd-session' } } },
    });
    await hooks['tool.execute.before']!(
      { tool: 'bash', sessionID: 'oc-cwd-session', callID: 'call-1' },
      { args: { command: 'ls' } },
    );
    await hooks['tool.execute.after']!(
      { tool: 'bash', sessionID: 'oc-cwd-session', callID: 'call-1', args: {} },
      { title: 'bash', output: 'a.txt', metadata: {} },
    );
    await hooks.event!({
      event: { type: 'session.idle', properties: { sessionID: 'oc-cwd-session' } },
    });

    const spans = tracer.finished();
    assert.ok(
      spans.length > 0,
      'the arm was made in the project directory opencode handed the plugin, so a session ' +
        'of that project must be captured',
    );
  });

  it('opencode: a session it never saw created is still keyed to the project', async () => {
    // Two ways a session reaches `tool.execute.before` without a
    // `session.created` this binding turned into `onSessionStart`: the
    // session predates the plugin load, and — always — a SUB-AGENT
    // child, whose `session.created` carries a `parentID` and is routed
    // to `onSubagentStart` instead. Both accumulate their own turn state
    // under their own id and consult the gate under it, so without the
    // runtime-wide default they would fall back to the server's launch
    // directory and go silent.
    pendingArm(home, sessionDir);
    const { createNioPlugin } = await import('../adapters/opencode-plugin.js');
    const hooks = await createNioPlugin({
      nioFactory: stubNioAllow(),
      tracerProvider: tracer.provider,
      meterProvider: null,
      loggerProvider: null,
    })({ directory: sessionDir, worktree: sessionDir });

    await hooks['tool.execute.before']!(
      { tool: 'bash', sessionID: 'oc-never-created', callID: 'call-9' },
      { args: { command: 'ls' } },
    );
    await hooks['tool.execute.after']!(
      { tool: 'bash', sessionID: 'oc-never-created', callID: 'call-9', args: {} },
      { title: 'bash', output: 'a.txt', metadata: {} },
    );
    await hooks.event!({
      event: { type: 'session.idle', properties: { sessionID: 'oc-never-created' } },
    });

    assert.ok(
      (tracer.finished()).length > 0,
      'the plugin directory opencode handed over covers every session this instance serves, ' +
        'including the ones whose creation it never observed',
    );
  });

  it('opencode: /nio monitor on keys the arm to the plugin directory', async () => {
    const { createNioPlugin } = await import('../adapters/opencode-plugin.js');
    const hooks = await createNioPlugin({
      nioFactory: stubNioAllow(),
      tracerProvider: tracer.provider,
      meterProvider: null,
      loggerProvider: null,
    })({ directory: sessionDir, worktree: sessionDir });

    await hooks.tool!['nio_command']!.execute({ command: 'monitor on' }, {});

    assert.equal(
      readStore(home).pending_arm?.cwd, sessionDir,
      'same pairing as Pi: the arm must name the project directory the gate will compare ' +
        'against, not the server\'s launch directory',
    );
  });
});
