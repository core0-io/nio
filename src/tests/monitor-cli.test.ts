// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

function run(args: string[], env: Record<string, string>, cwd: string): RunResult {
  const out = execFileSync('node', [CLI, ...args], {
    env: { ...process.env, ...env },
    cwd,
    encoding: 'utf-8',
  });
  return JSON.parse(out) as RunResult;
}

function freshHome(): string {
  // realpath: on macOS, tmpdir() lives under /var, which is itself a
  // symlink to /private/var. The CLI runs in a spawned child and reads
  // its cwd via process.cwd(), which returns the OS-canonicalized path
  // (/private/var/...) per POSIX getcwd() semantics — so an unresolved
  // /var/... fixture path would never match what the child observes.
  return realpathSync(mkdtempSync(join(tmpdir(), 'nio-monitor-cli-')));
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

describe('monitor-cli usage', () => {
  it('exits non-zero on an unknown subcommand', () => {
    const home = freshHome();
    assert.throws(() => run(['bogus'], { NIO_HOME: home }, home));
  });
});
