// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveMonitorGate,
  PENDING_ARM_TTL_MS,
  SESSION_TTL_MS,
} from '../scripts/lib/monitor-gate.js';
import type { MonitorStore } from '../scripts/lib/monitor-store.js';

const NOW = 1754300000000;

function emptyStore(): MonitorStore {
  return { sessions: {} };
}

describe('resolveMonitorGate — monitor_all_sessions', () => {
  it('monitors everything when the global flag is on', () => {
    const r = resolveMonitorGate({
      store: emptyStore(),
      sessionId: 'sess-unknown',
      cwd: '/work',
      monitorAllSessions: true,
      nowMs: NOW,
    });
    assert.equal(r.monitored, true);
    assert.equal(r.changed, false);
  });

  it('does not mutate the store when the global flag is on', () => {
    const store: MonitorStore = { sessions: {}, pending_arm: { at: NOW, cwd: '/work' } };
    const r = resolveMonitorGate({
      store,
      sessionId: 'sess-1',
      cwd: '/work',
      monitorAllSessions: true,
      nowMs: NOW,
    });
    assert.deepEqual(r.store.pending_arm, { at: NOW, cwd: '/work' });
  });
});

describe('resolveMonitorGate — default silence', () => {
  it('does not monitor an unknown session', () => {
    const r = resolveMonitorGate({
      store: emptyStore(),
      sessionId: 'sess-1',
      cwd: '/work',
      monitorAllSessions: false,
      nowMs: NOW,
    });
    assert.equal(r.monitored, false);
    assert.equal(r.changed, false);
  });

  it('monitors a session that was explicitly armed', () => {
    const store: MonitorStore = {
      sessions: { 'sess-1': { armed_at: NOW - 1000, cwd: '/work' } },
    };
    const r = resolveMonitorGate({
      store,
      sessionId: 'sess-1',
      cwd: '/work',
      monitorAllSessions: false,
      nowMs: NOW,
    });
    assert.equal(r.monitored, true);
  });

  it('does not monitor a different session in the same store', () => {
    const store: MonitorStore = {
      sessions: { 'sess-1': { armed_at: NOW - 1000, cwd: '/work' } },
    };
    const r = resolveMonitorGate({
      store,
      sessionId: 'sess-2',
      cwd: '/work',
      monitorAllSessions: false,
      nowMs: NOW,
    });
    assert.equal(r.monitored, false);
  });
});

describe('resolveMonitorGate — pending arm claiming', () => {
  it('claims a fresh pending arm with matching cwd', () => {
    const store: MonitorStore = {
      sessions: {},
      pending_arm: { at: NOW - 1000, cwd: '/work' },
    };
    const r = resolveMonitorGate({
      store,
      sessionId: 'sess-new',
      cwd: '/work',
      monitorAllSessions: false,
      nowMs: NOW,
    });
    assert.equal(r.monitored, true);
    assert.equal(r.changed, true);
    assert.equal(r.store.sessions['sess-new']?.cwd, '/work');
    assert.equal('pending_arm' in r.store, false);
  });

  it('does not claim a pending arm from a different cwd', () => {
    const store: MonitorStore = {
      sessions: {},
      pending_arm: { at: NOW - 1000, cwd: '/other' },
    };
    const r = resolveMonitorGate({
      store,
      sessionId: 'sess-new',
      cwd: '/work',
      monitorAllSessions: false,
      nowMs: NOW,
    });
    assert.equal(r.monitored, false);
    assert.deepEqual(r.store.pending_arm, { at: NOW - 1000, cwd: '/other' });
  });

  it('drops an expired pending arm without claiming it', () => {
    const store: MonitorStore = {
      sessions: {},
      pending_arm: { at: NOW - PENDING_ARM_TTL_MS - 1, cwd: '/work' },
    };
    const r = resolveMonitorGate({
      store,
      sessionId: 'sess-new',
      cwd: '/work',
      monitorAllSessions: false,
      nowMs: NOW,
    });
    assert.equal(r.monitored, false);
    assert.equal(r.changed, true);
    assert.equal('pending_arm' in r.store, false);
  });

  it('does not claim when cwd is null', () => {
    const store: MonitorStore = {
      sessions: {},
      pending_arm: { at: NOW - 1000, cwd: '/work' },
    };
    const r = resolveMonitorGate({
      store,
      sessionId: 'sess-new',
      cwd: null,
      monitorAllSessions: false,
      nowMs: NOW,
    });
    assert.equal(r.monitored, false);
  });

  it('still claims a pending arm exactly at PENDING_ARM_TTL_MS (age === TTL is not expired)', () => {
    // The expiry check is a strict `>`, so an age exactly equal to the
    // TTL must NOT be treated as expired. Only PENDING_ARM_TTL_MS + 1
    // (covered above) is. Without this case, flipping `>` to `>=` in
    // resolveMonitorGate would pass every existing test.
    const store: MonitorStore = {
      sessions: {},
      pending_arm: { at: NOW - PENDING_ARM_TTL_MS, cwd: '/work' },
    };
    const r = resolveMonitorGate({
      store,
      sessionId: 'sess-new',
      cwd: '/work',
      monitorAllSessions: false,
      nowMs: NOW,
    });
    assert.equal(r.monitored, true);
    assert.equal(r.changed, true);
    assert.equal(r.store.sessions['sess-new']?.cwd, '/work');
    assert.equal('pending_arm' in r.store, false);
  });
});

describe('resolveMonitorGate — expiry GC', () => {
  it('drops a session past the TTL and stops monitoring it', () => {
    const store: MonitorStore = {
      sessions: { 'sess-old': { armed_at: NOW - SESSION_TTL_MS - 1, cwd: '/work' } },
    };
    const r = resolveMonitorGate({
      store,
      sessionId: 'sess-old',
      cwd: '/work',
      monitorAllSessions: false,
      nowMs: NOW,
    });
    assert.equal(r.monitored, false);
    assert.equal(r.changed, true);
    assert.equal('sess-old' in r.store.sessions, false);
  });

  it('drops unrelated expired sessions while serving a live one', () => {
    const store: MonitorStore = {
      sessions: {
        'sess-live': { armed_at: NOW - 1000, cwd: '/work' },
        'sess-old': { armed_at: NOW - SESSION_TTL_MS - 1, cwd: '/elsewhere' },
      },
    };
    const r = resolveMonitorGate({
      store,
      sessionId: 'sess-live',
      cwd: '/work',
      monitorAllSessions: false,
      nowMs: NOW,
    });
    assert.equal(r.monitored, true);
    assert.equal(r.changed, true);
    assert.equal('sess-old' in r.store.sessions, false);
    assert.equal('sess-live' in r.store.sessions, true);
  });

  it('keeps a session exactly at SESSION_TTL_MS armed (age === TTL is not expired)', () => {
    // Same strict-`>` boundary as the pending-arm case above, pinned for
    // the session GC path: a session whose age exactly equals the TTL
    // must survive. Only SESSION_TTL_MS + 1 (covered above) is dropped.
    const store: MonitorStore = {
      sessions: { 'sess-boundary': { armed_at: NOW - SESSION_TTL_MS, cwd: '/work' } },
    };
    const r = resolveMonitorGate({
      store,
      sessionId: 'sess-boundary',
      cwd: '/work',
      monitorAllSessions: false,
      nowMs: NOW,
    });
    assert.equal(r.monitored, true);
    assert.equal(r.changed, false);
    assert.equal('sess-boundary' in r.store.sessions, true);
  });
});

describe('resolveMonitorGate — purity', () => {
  it('does not mutate the input store', () => {
    const store: MonitorStore = {
      sessions: {},
      pending_arm: { at: NOW - 1000, cwd: '/work' },
    };
    resolveMonitorGate({
      store,
      sessionId: 'sess-new',
      cwd: '/work',
      monitorAllSessions: false,
      nowMs: NOW,
    });
    assert.deepEqual(store.pending_arm, { at: NOW - 1000, cwd: '/work' });
    assert.deepEqual(store.sessions, {});
  });
});
