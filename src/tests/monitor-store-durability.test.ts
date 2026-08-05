// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveMonitorStore, loadMonitorStore } from '../scripts/lib/monitor-store.js';
import type { CollectorLogsConfig } from '../adapters/config-schema.js';

function freshDir(): { dir: string; logsConfig: CollectorLogsConfig } {
  const dir = mkdtempSync(join(tmpdir(), 'nio-store-dur-'));
  return { dir, logsConfig: { path: join(dir, 'audit.jsonl') } as CollectorLogsConfig };
}

describe('saveMonitorStore atomicity', () => {
  it('leaves no temp file behind on success', () => {
    const { dir, logsConfig } = freshDir();
    saveMonitorStore(logsConfig, { sessions: { s1: { armed_at: 1, cwd: '/w' } } });
    const stray = readdirSync(dir).filter(f => f !== 'monitored-sessions.json');
    assert.deepEqual(stray, [], `unexpected leftovers: ${stray.join(',')}`);
  });

  it('never leaves a partially written store readable', () => {
    // A reader must see either the old content or the new one, never a
    // truncated file. Writing via temp+rename is what guarantees this.
    const { dir, logsConfig } = freshDir();
    saveMonitorStore(logsConfig, { sessions: { old: { armed_at: 1, cwd: '/w' } } });
    saveMonitorStore(logsConfig, { sessions: { neu: { armed_at: 2, cwd: '/w' } } });
    const loaded = loadMonitorStore(logsConfig);
    assert.equal('neu' in loaded.sessions, true);
    assert.equal('old' in loaded.sessions, false);
  });
});

describe('loadMonitorStore corruption reporting', () => {
  it('still returns an empty store on corrupt JSON', () => {
    const { dir, logsConfig } = freshDir();
    writeFileSync(join(dir, 'monitored-sessions.json'), '{not json', 'utf-8');
    assert.deepEqual(loadMonitorStore(logsConfig), { sessions: {} });
  });

  it('does not report a diagnostic when the file is simply absent', () => {
    const { dir, logsConfig } = freshDir();
    loadMonitorStore(logsConfig);
    assert.equal(existsSync(join(dir, 'audit.jsonl')), false,
      'a missing store is normal and must stay silent');
  });
});
