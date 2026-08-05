// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Runs `fn` with NIO_HOME set to `nioHome` (or unset when undefined) AND
 * HOME repointed at a freshly minted temp directory.
 *
 * The HOME swap matters because `nioDir()` in config-loader.ts falls back
 * to `homedir()/.nio` whenever NIO_HOME is unset OR empty — `os.homedir()`
 * reads `$HOME` first on POSIX. Without this swap, a test that exercises
 * that fallback (e.g. NIO_HOME="") would resolve straight to the
 * developer's real `~/.nio/config.yaml` / `~/.nio/audit.jsonl`, making the
 * test read (and, on a corrupt real config, write diagnostics into) the
 * machine it happens to run on. See review C1.
 */
function withEnv<T>(nioHome: string | undefined, fn: (fakeHome: string) => T): T {
  const prevNioHome = process.env['NIO_HOME'];
  const prevHome = process.env['HOME'];
  const fakeHome = mkdtempSync(join(tmpdir(), 'nio-fake-home-'));
  process.env['HOME'] = fakeHome;
  if (nioHome === undefined) delete process.env['NIO_HOME'];
  else process.env['NIO_HOME'] = nioHome;
  try {
    return fn(fakeHome);
  } finally {
    if (prevNioHome === undefined) delete process.env['NIO_HOME'];
    else process.env['NIO_HOME'] = prevNioHome;
    if (prevHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = prevHome;
  }
}

describe('NIO_HOME empty-string handling', () => {
  it('treats NIO_HOME="" as unset, matching adapters/common.ts, without touching the real ~/.nio', async () => {
    const { loadLogsConfig, loadCollectorConfig } = await import('../scripts/lib/config-loader.js');

    let fakeHome = '';
    const result = withEnv('', (home) => {
      fakeHome = home;
      // Plant a config with an unmistakable marker value. If the empty
      // NIO_HOME fallback ever resolved to the real ~/.nio instead of this
      // fake one, the assertion below would fail (or, worse, silently
      // read whatever the developer's real config happens to contain).
      mkdirSync(join(home, '.nio'), { recursive: true });
      writeFileSync(
        join(home, '.nio', 'config.yaml'),
        'collector:\n  endpoint: "http://FAKE-ISOLATED-ENDPOINT"\n',
        'utf-8',
      );
      return {
        path: loadLogsConfig().path,
        endpoint: loadCollectorConfig().endpoint,
      };
    });

    assert.equal(result.path, join(fakeHome, '.nio', 'audit.jsonl'),
      'empty NIO_HOME must fall back to ~/.nio (the fake HOME here), not resolve to /audit.jsonl');
    assert.equal(result.endpoint, 'http://FAKE-ISOLATED-ENDPOINT',
      'must read the isolated fake-home config, never the developer\'s real ~/.nio/config.yaml');
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
