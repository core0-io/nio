// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

function withEnv<T>(nioHome: string | undefined, fn: () => T): T {
  const prev = process.env['NIO_HOME'];
  if (nioHome === undefined) delete process.env['NIO_HOME'];
  else process.env['NIO_HOME'] = nioHome;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env['NIO_HOME'];
    else process.env['NIO_HOME'] = prev;
  }
}

describe('NIO_HOME empty-string handling', () => {
  it('treats NIO_HOME="" as unset, matching adapters/common.ts', async () => {
    const { loadLogsConfig } = await import('../scripts/lib/config-loader.js');
    const p = withEnv('', () => loadLogsConfig().path);
    assert.equal(p, join(homedir(), '.nio', 'audit.jsonl'),
      'empty NIO_HOME must fall back to ~/.nio, not resolve to /audit.jsonl');
  });
});

describe('readRawConfig caching', () => {
  it('reflects a config written before first read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nio-cfg-cache-'));
    writeFileSync(join(dir, 'config.yaml'), 'collector:\n  monitor_all_sessions: true\n', 'utf-8');
    const { loadMonitorAllSessions } = await import('../scripts/lib/config-loader.js');
    assert.equal(withEnv(dir, () => loadMonitorAllSessions()), true);
  });

  it('does not leak one NIO_HOME cached value into another', async () => {
    const a = mkdtempSync(join(tmpdir(), 'nio-cfg-a-'));
    const b = mkdtempSync(join(tmpdir(), 'nio-cfg-b-'));
    writeFileSync(join(a, 'config.yaml'), 'collector:\n  monitor_all_sessions: true\n', 'utf-8');
    writeFileSync(join(b, 'config.yaml'), 'collector:\n  monitor_all_sessions: false\n', 'utf-8');
    const { loadMonitorAllSessions } = await import('../scripts/lib/config-loader.js');
    assert.equal(withEnv(a, () => loadMonitorAllSessions()), true);
    assert.equal(withEnv(b, () => loadMonitorAllSessions()), false,
      'cache must be keyed by resolved config path, not global');
    assert.equal(withEnv(a, () => loadMonitorAllSessions()), true);
  });
});
