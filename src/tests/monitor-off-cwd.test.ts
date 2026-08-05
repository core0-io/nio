// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * `/nio-monitor off` on every platform that is NOT Claude Code.
 *
 * `SESSION_ENV_VARS` in lib/monitor-commands.ts lists exactly one
 * variable, `CLAUDE_CODE_SESSION_ID`. So on Codex, Hermes and OpenClaw
 * `resolveSessionId()` returns `null` — permanently, by design, not as
 * an edge case — and those are precisely the platforms whose `on` has to
 * take the pending-arm route: `on` writes `pending_arm`, and the next
 * hook event claims it into `sessions[<the id the hook saw>]`. That id
 * is never visible from the CLI process.
 *
 * `off` used to key entirely off `resolveSessionId()`, so on those three
 * platforms it deleted nothing at all, reported `removed: false`, and
 * left the session exporting for the full 7-day TTL — worst on Codex,
 * which has no SessionEnd hook to clean up behind it and whose session
 * ids survive `codex resume`.
 *
 * ── The fixture trap this file exists to avoid ────────────────────────
 *
 * The three `off` cases in monitor-cli.test.ts all set
 * `CLAUDE_CODE_SESSION_ID` explicitly, so every one of them takes the
 * one branch that already worked and none of them can ever see the bug.
 * Worse, simply *omitting* the variable is not enough either: `run()`
 * spreads `process.env` into the child, and `pnpm test` is routinely
 * invoked from inside a Claude Code session that exports it for real —
 * an omitted variable would be inherited, and the test would quietly
 * slide back onto the working branch.
 *
 * So `runNoSession` below deletes the variable from the child's env, and
 * the first assertion of the round trip pins that the deletion took —
 * `on` answering `mode: direct` means the variable leaked back in and
 * everything after it would be testing the wrong branch.
 *
 * The discriminating assertion is the last one: `isSessionMonitored` —
 * the same function the hooks gate on — must answer `false` after `off`.
 * `removed: true` alone would not do; the pre-fix code could have been
 * made to report that without deleting anything.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSessionMonitored } from '../scripts/lib/monitor-check.js';
import type { CollectorLogsConfig } from '../adapters/config-schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(
  HERE, '..', '..',
  'plugins', 'claude-code', 'skills', 'nio', 'scripts', 'monitor-cli.js',
);

const CLI_TIMEOUT_MS = 30000;

/**
 * Run the CLI with `CLAUDE_CODE_SESSION_ID` **deleted** from the child's
 * environment — the Codex / Hermes / OpenClaw shape. Not set-to-empty:
 * an absent variable is what those platforms actually present, and this
 * way an inherited real one cannot leak in either.
 */
function runNoSession(args: string[], home: string, cwd: string): Record<string, unknown> {
  const env: Record<string, string> = { ...process.env as Record<string, string>, NIO_HOME: home };
  delete env['CLAUDE_CODE_SESSION_ID'];
  const out = execFileSync('node', [CLI, ...args], {
    env, cwd, encoding: 'utf-8', timeout: CLI_TIMEOUT_MS,
  });
  return JSON.parse(out) as Record<string, unknown>;
}

/** The Claude Code shape, for the contrast case. */
function runWithSession(
  args: string[], home: string, cwd: string, sessionId: string,
): Record<string, unknown> {
  const out = execFileSync('node', [CLI, ...args], {
    env: { ...process.env, NIO_HOME: home, CLAUDE_CODE_SESSION_ID: sessionId },
    cwd, encoding: 'utf-8', timeout: CLI_TIMEOUT_MS,
  });
  return JSON.parse(out) as Record<string, unknown>;
}

/**
 * realpath: on macOS tmpdir() sits under /var, itself a symlink to
 * /private/var. The child reports process.cwd() canonicalised, so an
 * unresolved fixture path would never match what it stamps.
 */
function freshHome(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function logsConfigFor(home: string): CollectorLogsConfig {
  return { path: join(home, 'audit.jsonl') } as CollectorLogsConfig;
}

function storeAt(home: string): { sessions: Record<string, unknown>; pending_arm?: unknown } {
  const p = join(home, 'monitored-sessions.json');
  if (!existsSync(p)) return { sessions: {} };
  return JSON.parse(readFileSync(p, 'utf-8')) as { sessions: Record<string, unknown> };
}

/**
 * The hook side of the loop, run for real rather than faked: this is the
 * function guard-hook / collector-hook / hook-cli / openclaw-plugin all
 * call, and it is what claims a pending arm into a session record.
 */
function hookGate(sessionId: string, cwd: string, home: string): boolean {
  const prev = process.env['NIO_HOME'];
  process.env['NIO_HOME'] = home;
  try {
    return isSessionMonitored(sessionId, cwd, logsConfigFor(home));
  } finally {
    if (prev === undefined) delete process.env['NIO_HOME'];
    else process.env['NIO_HOME'] = prev;
  }
}

describe('monitor off with no resolvable session id', () => {
  it('really disarms a session armed through the pending-arm path', () => {
    const home = freshHome('nio-off-cwd-');

    // 1 ── `on`. No session id, so this can only leave a pending arm.
    const on = runNoSession(['on'], home, home);
    assert.equal(on['mode'], 'pending',
      'sanity: without CLAUDE_CODE_SESSION_ID `on` must take the pending path — ' +
      'if this is `direct`, the env var leaked in and the test proves nothing');
    assert.equal(on['session_id'], null);

    // 2 ── The next hook event claims it, under an id only the hook sees.
    assert.equal(hookGate('codex-session-abc', home, home), true,
      'the hook must claim the pending arm and start capturing');
    assert.ok('codex-session-abc' in storeAt(home).sessions,
      'sanity: the claim must have persisted an armed record');

    // 3 ── `off`, still with no session id. This is the whole bug.
    const off = runNoSession(['off'], home, home);
    assert.equal(off['removed'], true,
      'off must report the removal it actually performed');
    assert.equal(off['removed_sessions'], 1);
    assert.equal(off['matched_by'], 'cwd');
    assert.equal('codex-session-abc' in storeAt(home).sessions, false,
      'the armed record must be gone from the store');

    // 4 ── The assertion that matters: the hooks must now stay silent.
    assert.equal(hookGate('codex-session-abc', home, home), false,
      'after `off` the gate the hooks enforce must answer false — otherwise the ' +
      'session keeps exporting for the full 7-day TTL');

    // 5 ── and `status` must agree rather than contradict itself.
    const status = runNoSession(['status'], home, home);
    assert.equal(status['armed_sessions'], 0);
    assert.equal(status['monitored'], false);
    assert.equal(status['session_undetermined'], false,
      'nothing is armed anywhere, so "not monitored" is not in doubt');
  });

  it('sweeps every session armed from this directory, not just one', () => {
    const home = freshHome('nio-off-cwd-multi-');

    runNoSession(['on'], home, home);
    assert.equal(hookGate('sess-1', home, home), true);
    runNoSession(['on'], home, home);
    assert.equal(hookGate('sess-2', home, home), true);
    assert.equal(Object.keys(storeAt(home).sessions).length, 2, 'sanity: two armed');

    const off = runNoSession(['off'], home, home);
    assert.equal(off['removed_sessions'], 2,
      'a user who types `off` in a directory means "stop capturing here" — ' +
      'leaving a concurrent session armed keeps shipping data they were told was off');
    assert.equal(hookGate('sess-1', home, home), false);
    assert.equal(hookGate('sess-2', home, home), false);
  });

  it('leaves sessions armed from another directory alone', () => {
    const home = freshHome('nio-off-cwd-other-');
    const other = freshHome('nio-off-cwd-elsewhere-');

    // Armed from `other`, then `off` is typed in `home`.
    runNoSession(['on'], home, other);
    assert.equal(hookGate('sess-elsewhere', other, home), true);

    const off = runNoSession(['off'], home, home);
    assert.equal(off['removed'], false, 'nothing was armed from this directory');
    assert.equal(off['removed_sessions'], 0);
    assert.equal(hookGate('sess-elsewhere', other, home), true,
      'a session armed from a different directory must survive');
  });

  it('does not sweep the directory when the platform does expose a session id', () => {
    // Claude Code: the id is authoritative. Two of its sessions can share
    // a project directory, and `off` in one must not disarm the other.
    const home = freshHome('nio-off-session-');

    runWithSession(['on'], home, home, 'cc-a');
    runWithSession(['on'], home, home, 'cc-b');
    assert.equal(Object.keys(storeAt(home).sessions).length, 2, 'sanity: two armed');

    const off = runWithSession(['off'], home, home, 'cc-a');
    assert.equal(off['matched_by'], 'session');
    assert.equal(off['removed_sessions'], 1);
    assert.equal(hookGate('cc-a', home, home), false);
    assert.equal(hookGate('cc-b', home, home), true,
      'a sibling session in the same directory must not be collateral');
  });
});

describe('monitor status with no resolvable session id', () => {
  it('says the session state is undetermined rather than reporting it off', () => {
    const home = freshHome('nio-status-undet-');

    runNoSession(['on'], home, home);
    assert.equal(hookGate('hermes-session-1', home, home), true);

    const status = runNoSession(['status'], home, home);
    assert.equal(status['session_id'], null);
    assert.equal(status['armed_sessions'], 1);
    assert.equal(status['session_undetermined'], true,
      'a capturing session must never be summarised as simply not monitored');
  });

  it('stays determinate when nothing is armed at all', () => {
    const home = freshHome('nio-status-empty-');
    const status = runNoSession(['status'], home, home);
    assert.equal(status['session_undetermined'], false);
    assert.equal(status['monitored'], false);
  });

  it('stays determinate under monitor_all_sessions', () => {
    const home = freshHome('nio-status-all-');
    writeFileSync(join(home, 'config.yaml'), 'collector:\n  monitor_all_sessions: true\n', 'utf-8');
    runNoSession(['on'], home, home);
    assert.equal(hookGate('sess-any', home, home), true);

    const status = runNoSession(['status'], home, home);
    assert.equal(status['monitored'], true);
    assert.equal(status['session_undetermined'], false,
      'the global flag captures every session regardless of id — nothing is in doubt');
  });
});
