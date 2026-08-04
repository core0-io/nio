// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  monitorStorePath,
  loadMonitorStore,
  saveMonitorStore,
  type MonitorStore,
} from '../scripts/lib/monitor-store.js';
import type { CollectorLogsConfig } from '../adapters/config-schema.js';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'nio-monitor-store-'));
}

describe('monitorStorePath', () => {
  it('sits next to the audit log when logs.path is set', () => {
    const dir = freshDir();
    const logsConfig = { path: join(dir, 'audit.jsonl') } as CollectorLogsConfig;
    assert.equal(monitorStorePath(logsConfig), join(dir, 'monitored-sessions.json'));
  });

  it('falls back to NIO_HOME when logs.path is absent', () => {
    const dir = freshDir();
    const prev = process.env['NIO_HOME'];
    process.env['NIO_HOME'] = dir;
    try {
      assert.equal(monitorStorePath(undefined), join(dir, 'monitored-sessions.json'));
    } finally {
      if (prev === undefined) delete process.env['NIO_HOME'];
      else process.env['NIO_HOME'] = prev;
    }
  });
});

describe('loadMonitorStore', () => {
  it('returns an empty store when the file is missing', () => {
    const dir = freshDir();
    const logsConfig = { path: join(dir, 'audit.jsonl') } as CollectorLogsConfig;
    assert.deepEqual(loadMonitorStore(logsConfig), { sessions: {} });
  });

  it('returns an empty store when the file is corrupt', () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'monitored-sessions.json'), '{not json', 'utf-8');
    const logsConfig = { path: join(dir, 'audit.jsonl') } as CollectorLogsConfig;
    assert.deepEqual(loadMonitorStore(logsConfig), { sessions: {} });
  });

  it('normalises a file with no sessions key', () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'monitored-sessions.json'), '{}', 'utf-8');
    const logsConfig = { path: join(dir, 'audit.jsonl') } as CollectorLogsConfig;
    assert.deepEqual(loadMonitorStore(logsConfig), { sessions: {} });
  });

  it('round-trips a saved store', () => {
    const dir = freshDir();
    const logsConfig = { path: join(dir, 'audit.jsonl') } as CollectorLogsConfig;
    const store: MonitorStore = {
      sessions: { 'sess-1': { armed_at: 1754300000000, cwd: '/work/proj' } },
      pending_arm: { at: 1754300001000, cwd: '/work/other' },
    };
    saveMonitorStore(logsConfig, store);
    assert.deepEqual(loadMonitorStore(logsConfig), store);
  });
});

describe('saveMonitorStore', () => {
  it('creates the parent directory when missing', () => {
    const dir = freshDir();
    const nested = join(dir, 'a', 'b');
    const logsConfig = { path: join(nested, 'audit.jsonl') } as CollectorLogsConfig;
    saveMonitorStore(logsConfig, { sessions: {} });
    assert.deepEqual(loadMonitorStore(logsConfig), { sessions: {} });
  });

  it('omits pending_arm when absent', () => {
    const dir = freshDir();
    mkdirSync(dir, { recursive: true });
    const logsConfig = { path: join(dir, 'audit.jsonl') } as CollectorLogsConfig;
    saveMonitorStore(logsConfig, { sessions: {} });
    const loaded = loadMonitorStore(logsConfig);
    assert.equal('pending_arm' in loaded, false);
  });
});
