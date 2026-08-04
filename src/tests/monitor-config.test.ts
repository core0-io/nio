// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function withConfig<T>(yaml: string, fn: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'nio-monitor-config-'));
  writeFileSync(join(dir, 'config.yaml'), yaml, 'utf-8');
  const prev = process.env['NIO_HOME'];
  process.env['NIO_HOME'] = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env['NIO_HOME'];
    else process.env['NIO_HOME'] = prev;
  }
}

describe('loadMonitorAllSessions', () => {
  it('defaults to false when the key is absent', async () => {
    const { loadMonitorAllSessions } = await import('../scripts/lib/config-loader.js');
    const result = withConfig('collector:\n  endpoint: "http://x"\n', () =>
      loadMonitorAllSessions());
    assert.equal(result, false);
  });

  it('defaults to false when there is no config file at all', async () => {
    const { loadMonitorAllSessions } = await import('../scripts/lib/config-loader.js');
    const dir = mkdtempSync(join(tmpdir(), 'nio-monitor-config-empty-'));
    const prev = process.env['NIO_HOME'];
    process.env['NIO_HOME'] = dir;
    try {
      assert.equal(loadMonitorAllSessions(), false);
    } finally {
      if (prev === undefined) delete process.env['NIO_HOME'];
      else process.env['NIO_HOME'] = prev;
    }
  });

  it('reads true when explicitly set', async () => {
    const { loadMonitorAllSessions } = await import('../scripts/lib/config-loader.js');
    const result = withConfig('collector:\n  monitor_all_sessions: true\n', () =>
      loadMonitorAllSessions());
    assert.equal(result, true);
  });

  it('treats a non-boolean value as false', async () => {
    const { loadMonitorAllSessions } = await import('../scripts/lib/config-loader.js');
    const result = withConfig('collector:\n  monitor_all_sessions: "yes"\n', () =>
      loadMonitorAllSessions());
    assert.equal(result, false);
  });
});
