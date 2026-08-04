// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSessionMonitored } from '../scripts/lib/monitor-check.js';
import { saveMonitorStore } from '../scripts/lib/monitor-store.js';
import type { CollectorLogsConfig } from '../adapters/config-schema.js';

function freshHome(): { home: string; logsConfig: CollectorLogsConfig } {
  const home = mkdtempSync(join(tmpdir(), 'nio-monitor-int-'));
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
});
