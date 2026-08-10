// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveMonitorStore, loadMonitorStore } from '../scripts/lib/monitor-store.js';
import { runMonitorCommand } from '../scripts/lib/monitor-commands.js';
import { isSessionMonitored } from '../scripts/lib/monitor-check.js';
import type { CollectorLogsConfig } from '../adapters/config-schema.js';
import { trackTempDir } from './helpers/tmp-dirs.js';

// runMonitorCommand(command, {cwd}) resolves logsConfig via loadLogsConfig()
// and the session id via resolveSessionId() — both read the environment,
// neither is a parameter. So the fixture drives it through NIO_HOME and
// CLAUDE_CODE_SESSION_ID rather than passing them in.
//
// Like every other process.env['NIO_HOME'] mutator in this test suite
// (see helpers/with-nio-home.ts's docblock for the full reasoning), this
// is safe only under node:test's default serial-within-a-file execution —
// there is no injectable seam in the production code to target instead.
// try/finally restores on a thrown assertion so a failure inside `fn`
// can't leak env vars into a later test in this file.
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

describe('monitor on canonicalises the directory it keys the arm to', () => {
  /**
   * The gate canonicalises the EVENT's cwd before comparing it against
   * `pending_arm.cwd` (`isSessionMonitored`), so an arm stored in
   * unresolved form can never be claimed.
   *
   * This never bit while every caller passed `process.cwd()` — POSIX
   * always reports that resolved, so both sides were canonical by
   * accident. It bites the moment a caller passes a directory it got
   * from somewhere else: the in-process runtimes now thread the SESSION's
   * directory in, and a host is free to hand over the unresolved form.
   * On macOS that is every path under `/tmp` and `/var`.
   */
  it('stores the resolved path when handed a symlinked one', () => {
    const { home, logsConfig } = fresh();
    const realDir = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-cmd-real-')));
    const linkParent = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-cmd-link-')));
    const linkDir = join(linkParent, 'link');
    symlinkSync(realDir, linkDir, 'dir');

    withEnv(home, null, () => runMonitorCommand('on', { cwd: linkDir }));

    assert.equal(
      loadMonitorStore(logsConfig).pending_arm?.cwd, realpathSync(linkDir),
      'an arm stored under the symlinked path is unclaimable: the gate resolves the ' +
        'session\'s cwd before comparing, so the two forms never match',
    );
  });

  it('a session reporting the symlinked path claims that arm', () => {
    const { home, logsConfig } = fresh();
    const realDir = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-cmd-real2-')));
    const linkParent = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-cmd-link2-')));
    const linkDir = join(linkParent, 'link');
    symlinkSync(realDir, linkDir, 'dir');

    withEnv(home, null, () => runMonitorCommand('on', { cwd: linkDir }));
    const monitored = withEnv(home, null, () =>
      isSessionMonitored('sess-symlinked', linkDir, logsConfig));

    assert.equal(
      monitored, true,
      'the end-to-end pairing: arm from a directory, then be a session in it',
    );
  });
});
