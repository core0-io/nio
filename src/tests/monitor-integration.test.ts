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
  const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-monitor-int-')));
  return { home, logsConfig: { path: join(home, 'audit.jsonl') } as CollectorLogsConfig };
}

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

describe('isSessionMonitored', () => {
  it('returns false for an unarmed session', () => {
    const { home, logsConfig } = freshHome();
    const result = withNioHome(home, null, () =>
      isSessionMonitored('sess-1', '/work', logsConfig));
    assert.equal(result, false);
  });

  it('returns true for an armed session', () => {
    const { home, logsConfig } = freshHome();
    saveMonitorStore(logsConfig, {
      sessions: { 'sess-1': { armed_at: Date.now(), cwd: '/work' } },
    });
    const result = withNioHome(home, null, () =>
      isSessionMonitored('sess-1', '/work', logsConfig));
    assert.equal(result, true);
  });

  it('returns true for any session when monitor_all_sessions is on', () => {
    const { home, logsConfig } = freshHome();
    const result = withNioHome(home, 'collector:\n  monitor_all_sessions: true\n', () =>
      isSessionMonitored('sess-anything', '/work', logsConfig));
    assert.equal(result, true);
  });

  it('claims a pending arm and persists the binding', () => {
    const { home, logsConfig } = freshHome();
    saveMonitorStore(logsConfig, {
      sessions: {},
      pending_arm: { at: Date.now(), cwd: '/work' },
    });
    const result = withNioHome(home, null, () =>
      isSessionMonitored('sess-new', '/work', logsConfig));
    assert.equal(result, true);

    const raw = JSON.parse(
      readFileSync(join(home, 'monitored-sessions.json'), 'utf-8'),
    ) as { sessions: Record<string, unknown>; pending_arm?: unknown };
    assert.equal('sess-new' in raw.sessions, true);
    assert.equal(raw.pending_arm, undefined);
  });

  it('claims a pending arm when hook cwd and stored cwd differ by a symlink', () => {
    // monitor-cli stamps pending_arm.cwd from process.cwd(), which POSIX
    // reports resolved. A host may hand the hook the unresolved form.
    // Without canonicalisation the arm would be permanently unclaimable.
    const { home, logsConfig } = freshHome();
    const realDir = join(home, 'real');
    const linkDir = join(home, 'link');
    mkdirSync(realDir);
    symlinkSync(realDir, linkDir);

    saveMonitorStore(logsConfig, {
      sessions: {},
      // monitor-cli stamps this from process.cwd(), which POSIX reports
      // resolved. Mirror that here — writing the raw mkdtemp path would
      // simulate a state the CLI never produces.
      pending_arm: { at: Date.now(), cwd: realpathSync(realDir) },
    });

    const result = withNioHome(home, null, () =>
      isSessionMonitored('sess-symlink', linkDir, logsConfig));
    assert.equal(result, true);
  });

  it('never throws when the store file is corrupt', () => {
    const { home, logsConfig } = freshHome();
    writeFileSync(join(home, 'monitored-sessions.json'), 'garbage', 'utf-8');
    const result = withNioHome(home, null, () =>
      isSessionMonitored('sess-1', '/work', logsConfig));
    assert.equal(result, false);
  });

  it('does not create the store file when nothing changed', () => {
    const { home, logsConfig } = freshHome();
    withNioHome(home, null, () => isSessionMonitored('sess-1', '/work', logsConfig));
    assert.equal(existsSync(join(home, 'monitored-sessions.json')), false);
  });

  it('treats the "unknown" sentinel id as never monitored', () => {
    // Against an empty store this is vacuous — an unarmed session
    // already returns false with no sentinel guard involved at all, so
    // this assertion would stay green even with the UNTRUSTED_SESSION_IDS
    // check deleted outright (confirmed by hand: neutering the guard in
    // monitor-check.ts left this test passing while 8 others in this
    // file went red). Seeding an armed record under the literal
    // 'unknown' key is what actually exercises the guard: without it,
    // this would report monitored.
    const { home, logsConfig } = freshHome();
    saveMonitorStore(logsConfig, {
      sessions: { unknown: { armed_at: Date.now(), cwd: '/work' } },
    });
    const result = withNioHome(home, null, () =>
      isSessionMonitored('unknown', '/work', logsConfig));
    assert.equal(result, false);
  });

  it('treats an empty session id as never monitored', () => {
    // Same vacuity as above, same fix: seed an armed record under the
    // empty-string key so the assertion actually depends on the guard.
    const { home, logsConfig } = freshHome();
    saveMonitorStore(logsConfig, {
      sessions: { '': { armed_at: Date.now(), cwd: '/work' } },
    });
    const result = withNioHome(home, null, () =>
      isSessionMonitored('', '/work', logsConfig));
    assert.equal(result, false);
  });

  it('does not match "unknown" against a pre-existing "unknown" session record', () => {
    // Simulates store pollution from before this guard existed (or from
    // a corrupt/hand-edited store): even if a literal "unknown" key
    // somehow ended up armed, treating an id-less event as monitored
    // would turn one shared key into blanket capture across every
    // session/directory that fails to report an id.
    const { home, logsConfig } = freshHome();
    saveMonitorStore(logsConfig, {
      sessions: { unknown: { armed_at: Date.now(), cwd: '/somewhere-else' } },
    });
    const result = withNioHome(home, null, () =>
      isSessionMonitored('unknown', '/work', logsConfig));
    assert.equal(result, false);
  });

  it('does not let "unknown" claim a pending arm, and leaves it intact', () => {
    const { home, logsConfig } = freshHome();
    saveMonitorStore(logsConfig, {
      sessions: {},
      pending_arm: { at: Date.now(), cwd: '/work' },
    });
    const result = withNioHome(home, null, () =>
      isSessionMonitored('unknown', '/work', logsConfig));
    assert.equal(result, false);

    // The guard returns before touching the store at all, so the file
    // must be untouched — still exactly the pending_arm we wrote.
    const raw = JSON.parse(
      readFileSync(join(home, 'monitored-sessions.json'), 'utf-8'),
    ) as { sessions: Record<string, unknown>; pending_arm?: { at: number; cwd: string } };
    assert.equal('unknown' in raw.sessions, false);
    assert.ok(raw.pending_arm);
    assert.equal(raw.pending_arm?.cwd, '/work');
  });
});

// ── Untrusted sentinel ids ────────────────────────────────────────────
//
// `openclaw-plugin.ts` falls back to the literal `'openclaw'` in nine
// places when an OpenClaw ctx carries no sessionKey/sessionId/runId. It
// is the same class of value as `'unknown'`: a label for an audit
// record, not an identity. Left trusted, a single arm would key every
// id-less event in a long-running daemon — from any session, any
// directory — to one shared record for the full 7-day TTL.

describe('isSessionMonitored — untrusted sentinel session ids', () => {
  // Hardcoded, NOT derived from UNTRUSTED_SESSION_IDS: iterating the set
  // under test would make a mutation that drops an entry delete its own
  // test cases instead of failing them.
  for (const sentinel of ['', 'unknown', 'openclaw']) {
    const label = sentinel === '' ? '(empty string)' : `"${sentinel}"`;

    it(`never reports ${label} as monitored, even with a matching armed record`, () => {
      const { home, logsConfig } = freshHome();
      saveMonitorStore(logsConfig, {
        sessions: { [sentinel]: { armed_at: Date.now(), cwd: '/work' } },
      });
      const result = withNioHome(home, null, () =>
        isSessionMonitored(sentinel, '/work', logsConfig));
      assert.equal(result, false);
    });

    it(`never lets ${label} claim a pending arm`, () => {
      const { home, logsConfig } = freshHome();
      saveMonitorStore(logsConfig, {
        sessions: {},
        pending_arm: { at: Date.now(), cwd: '/work' },
      });
      const result = withNioHome(home, null, () =>
        isSessionMonitored(sentinel, '/work', logsConfig));
      assert.equal(result, false);

      // The guard returns before touching the store, so the arm is still
      // there for the real session to claim.
      const raw = JSON.parse(
        readFileSync(join(home, 'monitored-sessions.json'), 'utf-8'),
      ) as { sessions: Record<string, unknown>; pending_arm?: { cwd: string } };
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
    const result = withNioHome(home, null, () =>
      isSessionMonitored('openclaw-42', '/work', logsConfig));
    assert.equal(result, true);
  });
});
