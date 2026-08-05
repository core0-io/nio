// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackTempDir } from './helpers/tmp-dirs.js';

// Resolve path to the built monitor-cli.js. Test file lives in
// dist/tests/ at runtime. Scripts are bundled by bun (not tsc) into
// plugins/claude-code/skills/nio/scripts/, not dist/scripts/ —
// tsconfig.lib.json excludes src/scripts from the tsc pass.
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(
  HERE, '..', '..',
  'plugins', 'claude-code', 'skills', 'nio', 'scripts', 'monitor-cli.js',
);

interface RunResult { [key: string]: unknown }

// Bounded so a regression that makes the CLI block cannot hang CI.
const CLI_TIMEOUT_MS = 30000;

function run(args: string[], env: Record<string, string>, cwd: string): RunResult {
  const out = execFileSync('node', [CLI, ...args], {
    env: { ...process.env, ...env },
    cwd,
    encoding: 'utf-8',
    timeout: CLI_TIMEOUT_MS,
  });
  return JSON.parse(out) as RunResult;
}

function freshHome(): string {
  // realpath: on macOS, tmpdir() lives under /var, which is itself a
  // symlink to /private/var. The CLI runs in a spawned child and reads
  // its cwd via process.cwd(), which returns the OS-canonicalized path
  // (/private/var/...) per POSIX getcwd() semantics — so an unresolved
  // /var/... fixture path would never match what the child observes.
  return trackTempDir(realpathSync(mkdtempSync(join(tmpdir(), 'nio-monitor-cli-'))));
}

function storeAt(home: string): Record<string, unknown> {
  const p = join(home, 'monitored-sessions.json');
  if (!existsSync(p)) return { sessions: {} };
  return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
}

describe('monitor-cli on', () => {
  it('arms the session directly when CLAUDE_CODE_SESSION_ID is present', () => {
    const home = freshHome();
    const r = run(['on'], { NIO_HOME: home, CLAUDE_CODE_SESSION_ID: 'sess-abc' }, home);
    assert.equal(r['action'], 'on');
    assert.equal(r['mode'], 'direct');
    assert.equal(r['session_id'], 'sess-abc');

    const store = storeAt(home) as { sessions: Record<string, unknown> };
    assert.equal('sess-abc' in store.sessions, true);
  });

  it('falls back to a pending arm when no session id is available', () => {
    const home = freshHome();
    const r = run(['on'], { NIO_HOME: home, CLAUDE_CODE_SESSION_ID: '' }, home);
    assert.equal(r['mode'], 'pending');
    assert.equal(r['session_id'], null);

    const store = storeAt(home) as { pending_arm?: { cwd: string } };
    assert.equal(store.pending_arm?.cwd, home);
  });
});

describe('monitor-cli off', () => {
  it('removes an armed session', () => {
    const home = freshHome();
    run(['on'], { NIO_HOME: home, CLAUDE_CODE_SESSION_ID: 'sess-abc' }, home);
    const r = run(['off'], { NIO_HOME: home, CLAUDE_CODE_SESSION_ID: 'sess-abc' }, home);
    assert.equal(r['removed'], true);

    const store = storeAt(home) as { sessions: Record<string, unknown> };
    assert.equal('sess-abc' in store.sessions, false);
  });

  it('reports removed=false when nothing was armed', () => {
    const home = freshHome();
    const r = run(['off'], { NIO_HOME: home, CLAUDE_CODE_SESSION_ID: 'sess-none' }, home);
    assert.equal(r['removed'], false);
  });

  it('clears a pending arm too', () => {
    const home = freshHome();
    run(['on'], { NIO_HOME: home, CLAUDE_CODE_SESSION_ID: '' }, home);
    run(['off'], { NIO_HOME: home, CLAUDE_CODE_SESSION_ID: '' }, home);
    const store = storeAt(home) as { pending_arm?: unknown };
    assert.equal(store.pending_arm, undefined);
  });
});

describe('monitor-cli status', () => {
  it('reports not monitored on a fresh home', () => {
    const home = freshHome();
    const r = run(['status'], { NIO_HOME: home, CLAUDE_CODE_SESSION_ID: 'sess-x' }, home);
    assert.equal(r['monitored'], false);
    assert.equal(r['monitor_all_sessions'], false);
    assert.equal(r['armed_sessions'], 0);
  });

  it('reports monitored after arming', () => {
    const home = freshHome();
    run(['on'], { NIO_HOME: home, CLAUDE_CODE_SESSION_ID: 'sess-x' }, home);
    const r = run(['status'], { NIO_HOME: home, CLAUDE_CODE_SESSION_ID: 'sess-x' }, home);
    assert.equal(r['monitored'], true);
    assert.equal(r['armed_sessions'], 1);
  });
});

// ── status must be the gate's answer, not a second implementation ─────
//
// `status` is the only reading a user gets of where the privacy
// boundary currently sits. It used to answer with its own
// `sessionId in store.sessions` lookup, which knew nothing about
// SESSION_TTL_MS or pending arms — so it could contradict the hooks in
// both directions. It now runs the same `resolveMonitorGate` the hooks
// do, read-only.

/** Mirrors monitor-gate.ts's SESSION_TTL_MS (7 days). */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function writeStore(home: string, store: unknown): void {
  writeFileSync(join(home, 'monitored-sessions.json'), JSON.stringify(store, null, 2), 'utf-8');
}

function rawStore(home: string): string {
  return readFileSync(join(home, 'monitored-sessions.json'), 'utf-8');
}

describe('monitor-cli status agrees with the hook-side gate', () => {
  it('does not report a session past SESSION_TTL_MS as monitored', () => {
    const home = freshHome();
    writeStore(home, {
      sessions: {
        'sess-stale': { armed_at: Date.now() - SESSION_TTL_MS - 60_000, cwd: home },
      },
    });
    const r = run(['status'], { NIO_HOME: home, CLAUDE_CODE_SESSION_ID: 'sess-stale' }, home);
    assert.equal(r['monitored'], false,
      'an expired record the hooks would reject must not read as monitored');
    assert.equal(r['armed_sessions'], 0,
      'expired records must not be counted as armed');
  });

  it('still reports a session inside the TTL as monitored', () => {
    const home = freshHome();
    writeStore(home, {
      sessions: {
        'sess-fresh': { armed_at: Date.now() - SESSION_TTL_MS + 60_000, cwd: home },
      },
    });
    const r = run(['status'], { NIO_HOME: home, CLAUDE_CODE_SESSION_ID: 'sess-fresh' }, home);
    assert.equal(r['monitored'], true);
    assert.equal(r['armed_sessions'], 1);
  });

  it('surfaces a pending arm instead of looking like `on` never happened', () => {
    // The Codex path: no session-id env var, so `on` leaves a pending
    // arm. Before this, the immediately-following `status` answered
    // monitored:false / armed_sessions:0 with nothing else to go on —
    // indistinguishable from `on` having silently failed.
    const home = freshHome();
    const on = run(['on'], { NIO_HOME: home, CLAUDE_CODE_SESSION_ID: '' }, home);
    assert.equal(on['mode'], 'pending');

    const r = run(['status'], { NIO_HOME: home, CLAUDE_CODE_SESSION_ID: '' }, home);
    assert.equal(r['pending_arm'], true, 'the pending arm must be visible in status');
    assert.equal(r['monitored'], false, 'a pending arm is not yet capture');
  });

  it('reports pending_arm false once the arm has expired', () => {
    const home = freshHome();
    // PENDING_ARM_TTL_MS is 60s; stamp it well past that.
    writeStore(home, { sessions: {}, pending_arm: { at: Date.now() - 300_000, cwd: home } });
    const r = run(['status'], { NIO_HOME: home, CLAUDE_CODE_SESSION_ID: 'sess-x' }, home);
    assert.equal(r['pending_arm'], false);
    assert.equal(r['monitored'], false);
  });

  it('never writes to the store — a question must not arm anything', () => {
    const home = freshHome();
    // A pending arm whose cwd matches this process's cwd is precisely
    // what the gate's claim branch would grab if status ran it in
    // read-write mode.
    writeStore(home, { sessions: {}, pending_arm: { at: Date.now(), cwd: home } });
    const before = rawStore(home);

    const r = run(['status'], { NIO_HOME: home, CLAUDE_CODE_SESSION_ID: 'sess-claimer' }, home);
    assert.equal(r['monitored'], false, 'status must not claim the arm for itself');
    assert.equal(r['armed_sessions'], 0);
    assert.equal(rawStore(home), before, 'status must leave the store byte-identical');
  });

  it('does not persist the expiry sweep either', () => {
    const home = freshHome();
    writeStore(home, {
      sessions: { 'sess-stale': { armed_at: Date.now() - SESSION_TTL_MS - 60_000, cwd: home } },
    });
    const before = rawStore(home);
    run(['status'], { NIO_HOME: home, CLAUDE_CODE_SESSION_ID: 'sess-stale' }, home);
    assert.equal(rawStore(home), before, 'status must leave the store byte-identical');
  });

  it('reports monitored under monitor_all_sessions without a session id', () => {
    const home = freshHome();
    writeFileSync(
      join(home, 'config.yaml'),
      'collector:\n  monitor_all_sessions: true\n',
      'utf-8',
    );
    const r = run(['status'], { NIO_HOME: home, CLAUDE_CODE_SESSION_ID: '' }, home);
    assert.equal(r['monitor_all_sessions'], true);
    assert.equal(r['monitored'], true);
  });
});

describe('monitor-cli usage', () => {
  it('exits non-zero on an unknown subcommand', () => {
    const home = freshHome();
    assert.throws(() => run(['bogus'], { NIO_HOME: home }, home));
  });
});
