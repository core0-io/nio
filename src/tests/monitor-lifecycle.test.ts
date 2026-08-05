// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetSession } from '../scripts/lib/monitor-check.js';
import { saveMonitorStore, loadMonitorStore, monitorStorePath } from '../scripts/lib/monitor-store.js';
import type { CollectorLogsConfig } from '../adapters/config-schema.js';
import { trackTempDir } from './helpers/tmp-dirs.js';

function freshHome(): { home: string; logsConfig: CollectorLogsConfig } {
  const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-monitor-life-')));
  return { home, logsConfig: { path: join(home, 'audit.jsonl') } as CollectorLogsConfig };
}

describe('forgetSession', () => {
  it('removes the session record', () => {
    const { logsConfig } = freshHome();
    saveMonitorStore(logsConfig, {
      sessions: {
        'sess-1': { armed_at: Date.now(), cwd: '/work' },
        'sess-2': { armed_at: Date.now(), cwd: '/work' },
      },
    });
    forgetSession('sess-1', logsConfig);
    const store = loadMonitorStore(logsConfig);
    assert.equal('sess-1' in store.sessions, false);
    assert.equal('sess-2' in store.sessions, true);
  });

  it('is a no-op for an unknown session', () => {
    const { logsConfig } = freshHome();
    saveMonitorStore(logsConfig, {
      sessions: { 'sess-1': { armed_at: Date.now(), cwd: '/work' } },
    });
    forgetSession('sess-unknown', logsConfig);
    assert.equal('sess-1' in loadMonitorStore(logsConfig).sessions, true);
  });

  it('never throws when the store file is unwritable', () => {
    // Must actually reach the saveMonitorStore() call inside forgetSession's
    // try/catch — a session that doesn't exist in the store returns early
    // before that call, so the file has to (a) exist, (b) be readable (so
    // loadMonitorStore succeeds and finds the session), and (c) be
    // unwritable (so the subsequent save throws). A missing/unreadable
    // path only exercises loadMonitorStore's own try/catch, which already
    // returns an empty store — forgetSession would then no-op before ever
    // calling saveMonitorStore, leaving its own try/catch untested.
    const { logsConfig } = freshHome();
    saveMonitorStore(logsConfig, {
      sessions: { 'sess-1': { armed_at: Date.now(), cwd: '/work' } },
    });
    const path = monitorStorePath(logsConfig);
    chmodSync(path, 0o444);
    try {
      assert.doesNotThrow(() => forgetSession('sess-1', logsConfig));
    } finally {
      // Restore write permission so the mkdtemp-created directory can be
      // cleaned up (by the OS temp reaper or a later test run).
      chmodSync(path, 0o644);
    }
  });
});
