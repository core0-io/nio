// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveMonitorStore, loadMonitorStore } from '../scripts/lib/monitor-store.js';
import { runMonitorCommand } from '../scripts/lib/monitor-commands.js';
import type { CollectorLogsConfig } from '../adapters/config-schema.js';
import { trackTempDir } from './helpers/tmp-dirs.js';

// runMonitorCommand(command, {cwd}) resolves logsConfig via loadLogsConfig()
// and the session id via resolveSessionId() — both read the environment,
// neither is a parameter. So the fixture drives it through NIO_HOME and
// CLAUDE_CODE_SESSION_ID rather than passing them in.
function withEnv<T>(home: string, sessionId: string | null, fn: () => T): T {
  const prevHome = process.env['NIO_HOME'];
  const prevSid = process.env['CLAUDE_CODE_SESSION_ID'];
  process.env['NIO_HOME'] = home;
  if (sessionId === null) delete process.env['CLAUDE_CODE_SESSION_ID'];
  else process.env['CLAUDE_CODE_SESSION_ID'] = sessionId;
  try { return fn(); } finally {
    if (prevHome === undefined) delete process.env['NIO_HOME']; else process.env['NIO_HOME'] = prevHome;
    if (prevSid === undefined) delete process.env['CLAUDE_CODE_SESSION_ID']; else process.env['CLAUDE_CODE_SESSION_ID'] = prevSid;
  }
}

function fresh(): { home: string; logsConfig: CollectorLogsConfig } {
  const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-cmd-pending-')));
  return { home, logsConfig: { path: join(home, 'audit.jsonl') } as CollectorLogsConfig };
}

describe('monitor on (direct) preserves a foreign pending arm', () => {
  it('keeps another session-s pending_arm intact', () => {
    const { home, logsConfig } = fresh();
    saveMonitorStore(logsConfig, {
      sessions: {},
      pending_arm: { at: Date.now(), cwd: '/other/project' },
    });

    withEnv(home, 'sess-direct', () => runMonitorCommand('on', { cwd: '/my/project' }));

    const store = loadMonitorStore(logsConfig);
    assert.equal('sess-direct' in store.sessions, true, 'own session must be armed');
    assert.notEqual(store.pending_arm, undefined,
      'a pending arm belonging to another session must survive');
    assert.equal(store.pending_arm?.cwd, '/other/project');
  });

  it('off still clears the pending arm', () => {
    const { home, logsConfig } = fresh();
    saveMonitorStore(logsConfig, {
      sessions: {},
      pending_arm: { at: Date.now(), cwd: '/x' },
    });
    withEnv(home, 'sess-x', () => runMonitorCommand('off', { cwd: '/x' }));
    assert.equal(loadMonitorStore(logsConfig).pending_arm, undefined);
  });
});
