// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSessionMonitored, UNTRUSTED_SESSION_IDS } from '../scripts/lib/monitor-check.js';
import { saveMonitorStore } from '../scripts/lib/monitor-store.js';
import type { CollectorLogsConfig } from '../adapters/config-schema.js';
import { trackTempDir } from './helpers/tmp-dirs.js';

function freshHome(): { home: string; logsConfig: CollectorLogsConfig } {
  const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-monitor-check-')));
  return { home, logsConfig: { path: join(home, 'audit.jsonl') } as CollectorLogsConfig };
}

// Mutates the process-global process.env.NIO_HOME because isSessionMonitored
// (via loadMonitorStore / loadMonitorAllSessions) reads it directly — there
// is no injectable seam. Safe only under node:test's default
// serial-within-a-file execution. The try/finally still restores on a thrown
// assertion so a failure in `fn` cannot leak NIO_HOME into a later test.
function withNioHome<T>(home: string, yaml: string | null, fn: () => T): T {
  if (yaml !== null) writeFileSync(join(home, 'config.yaml'), yaml, 'utf-8');
  const prev = process.env['NIO_HOME'];
  process.env['NIO_HOME'] = home;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env['NIO_HOME'];
    else process.env['NIO_HOME'] = prev;
  }
}

function readStore(home: string): {
  sessions: Record<string, unknown>;
  pending_arm?: { at: number; cwd: string };
} {
  return JSON.parse(readFileSync(join(home, 'monitored-sessions.json'), 'utf-8')) as {
    sessions: Record<string, unknown>;
    pending_arm?: { at: number; cwd: string };
  };
}

describe('isSessionMonitored', () => {
  it('returns false for an unarmed session', () => {
    const { home, logsConfig } = freshHome();
    assert.equal(
      withNioHome(home, null, () => isSessionMonitored('sess-1', '/work', logsConfig)),
      false,
    );
  });

  it('returns true for an armed session', () => {
    const { home, logsConfig } = freshHome();
    saveMonitorStore(logsConfig, { sessions: { 'sess-1': { armed_at: Date.now(), cwd: '/work' } } });
    assert.equal(
      withNioHome(home, null, () => isSessionMonitored('sess-1', '/work', logsConfig)),
      true,
    );
  });

  it('returns true for any session when monitor_all_sessions is on', () => {
    const { home, logsConfig } = freshHome();
    assert.equal(
      withNioHome(home, 'collector:\n  monitor_all_sessions: true\n', () =>
        isSessionMonitored('sess-anything', '/work', logsConfig)),
      true,
    );
  });

  it('claims a pending arm and persists the binding', () => {
    const { home, logsConfig } = freshHome();
    saveMonitorStore(logsConfig, { sessions: {}, pending_arm: { at: Date.now(), cwd: '/work' } });
    assert.equal(
      withNioHome(home, null, () => isSessionMonitored('sess-new', '/work', logsConfig)),
      true,
    );

    const raw = readStore(home);
    assert.equal('sess-new' in raw.sessions, true);
    assert.equal(raw.pending_arm, undefined);
  });

  it('claims a pending arm when hook cwd and stored cwd differ by a symlink', () => {
    // monitor-cli stamps pending_arm.cwd from process.cwd(), which POSIX
    // reports resolved. A host may hand the hook the unresolved form.
    // Without canonicalisation the arm is permanently unclaimable — and
    // `off`, which matches the same way, cannot delete it either. On
    // macOS that is every directory under /tmp and /var.
    const { home, logsConfig } = freshHome();
    const realDir = join(home, 'real');
    const linkDir = join(home, 'link');
    mkdirSync(realDir);
    symlinkSync(realDir, linkDir);

    saveMonitorStore(logsConfig, {
      sessions: {},
      // Mirror what the CLI writes — the resolved form. Writing the raw
      // mkdtemp path would simulate a state the CLI never produces.
      pending_arm: { at: Date.now(), cwd: realpathSync(realDir) },
    });

    assert.equal(
      withNioHome(home, null, () => isSessionMonitored('sess-symlink', linkDir, logsConfig)),
      true,
    );
  });

  it('fails closed on a corrupt store that names this very session as armed', () => {
    // The fixture is TRUNCATED valid JSON, not `'garbage'`, and the
    // record it names is for the session under test. Both details are
    // what make the assertion depend on the corrupt branch at all: with
    // an unrelated (or unparseable-in-every-direction) fixture, an
    // unarmed session returns false anyway and this stays green under
    // any implementation — including one that recovers what it can from
    // a damaged file and reports the session monitored.
    const { home, logsConfig } = freshHome();
    writeFileSync(
      join(home, 'monitored-sessions.json'),
      `{"sessions": {"sess-1": {"armed_at": ${Date.now()}, "cwd": "/work"}`,
      'utf-8',
    );
    assert.equal(
      withNioHome(home, null, () => isSessionMonitored('sess-1', '/work', logsConfig)),
      false,
      'an unreadable store must never enable capture the user did not ask for',
    );
  });

  it('does not create the store file when nothing changed', () => {
    const { home, logsConfig } = freshHome();
    withNioHome(home, null, () => isSessionMonitored('sess-1', '/work', logsConfig));
    assert.equal(existsSync(join(home, 'monitored-sessions.json')), false);
  });
});

// ── Untrusted sentinel ids ────────────────────────────────────────────
//
// Each of these is a literal a call site substitutes when the host gave
// it nothing: `''`, the `?? 'unknown'` in the Claude Code / Codex /
// Hermes hooks, and the `|| 'openclaw'` ctx fallbacks in
// `openclaw-plugin.ts`. They are labels for an audit record, not
// identities. Left trusted, a single arm keys every id-less event — from
// any session, any directory — to one shared record for the full 7-day
// TTL.

describe('isSessionMonitored — untrusted sentinel session ids', () => {
  // Hardcoded, NOT derived from UNTRUSTED_SESSION_IDS: iterating the set
  // under test would make a mutation that drops an entry delete its own
  // test cases instead of failing them.
  for (const sentinel of ['', 'unknown', 'openclaw']) {
    const label = sentinel === '' ? '(empty string)' : `"${sentinel}"`;

    it(`never reports ${label} as monitored, even with a matching armed record`, () => {
      // The armed record is what makes this bite. Against an EMPTY store
      // the assertion is vacuous — an unarmed session already returns
      // false with no sentinel guard involved — so it would stay green
      // with the guard deleted outright.
      const { home, logsConfig } = freshHome();
      saveMonitorStore(logsConfig, {
        sessions: { [sentinel]: { armed_at: Date.now(), cwd: '/work' } },
      });
      assert.equal(
        withNioHome(home, null, () => isSessionMonitored(sentinel, '/work', logsConfig)),
        false,
      );
    });

    it(`never lets ${label} claim a pending arm, and leaves the store untouched`, () => {
      const { home, logsConfig } = freshHome();
      saveMonitorStore(logsConfig, { sessions: {}, pending_arm: { at: Date.now(), cwd: '/work' } });

      assert.equal(
        withNioHome(home, null, () => isSessionMonitored(sentinel, '/work', logsConfig)),
        false,
      );

      // The guard must return before `resolveMonitorGate` /
      // `saveMonitorStore`, so the arm is still there for the real
      // session to claim; relocating it past those leaves the claim
      // branch reachable and this goes red. Moving it merely below
      // `loadMonitorStore` does NOT turn this red — that call only
      // reads the store; its own side effect is the corrupt-store
      // diagnostic, which is a different assertion in a different file.
      const raw = readStore(home);
      assert.equal(sentinel in raw.sessions, false);
      assert.equal(raw.pending_arm?.cwd, '/work');
    });
  }

  it('covers the literals the platform adapters actually fall back to', () => {
    // Pins the *contents* of the set, not just that a set exists: a
    // future adapter adding its own `|| 'somename'` fallback has to add
    // it here too, and dropping one of these silently reopens the leak.
    assert.deepEqual([...UNTRUSTED_SESSION_IDS].sort(), ['', 'openclaw', 'unknown']);
  });

  it('still monitors a real session id that merely contains a sentinel', () => {
    // The rejection is exact-match, not substring — an OpenClaw session
    // key like "openclaw-42" is a genuine identity.
    const { home, logsConfig } = freshHome();
    saveMonitorStore(logsConfig, {
      sessions: { 'openclaw-42': { armed_at: Date.now(), cwd: '/work' } },
    });
    assert.equal(
      withNioHome(home, null, () => isSessionMonitored('openclaw-42', '/work', logsConfig)),
      true,
    );
  });
});
