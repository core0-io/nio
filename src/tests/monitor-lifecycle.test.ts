// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetSession } from '../scripts/lib/monitor-check.js';
import { saveMonitorStore, loadMonitorStore } from '../scripts/lib/monitor-store.js';
import type { CollectorLogsConfig } from '../adapters/config-schema.js';

function freshHome(): { home: string; logsConfig: CollectorLogsConfig } {
  const home = mkdtempSync(join(tmpdir(), 'nio-monitor-life-'));
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

  it('never throws when the store is unwritable', () => {
    const logsConfig = { path: '/proc/nonexistent/audit.jsonl' } as CollectorLogsConfig;
    assert.doesNotThrow(() => forgetSession('sess-1', logsConfig));
  });
});
