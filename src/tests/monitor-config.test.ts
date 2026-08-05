// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withNioHome } from './helpers/with-nio-home.js';

describe('loadMonitorAllSessions', () => {
  it('defaults to false when the key is absent', async () => {
    const { loadMonitorAllSessions } = await import('../scripts/lib/config-loader.js');
    const result = withNioHome('collector:\n  endpoint: "http://x"\n', () =>
      loadMonitorAllSessions());
    assert.equal(result, false);
  });

  it('defaults to false when there is no config file at all', async () => {
    const { loadMonitorAllSessions } = await import('../scripts/lib/config-loader.js');
    const result = withNioHome(null, () => loadMonitorAllSessions());
    assert.equal(result, false);
  });

  it('reads true when explicitly set', async () => {
    const { loadMonitorAllSessions } = await import('../scripts/lib/config-loader.js');
    const result = withNioHome('collector:\n  monitor_all_sessions: true\n', () =>
      loadMonitorAllSessions());
    assert.equal(result, true);
  });

  it('treats a non-boolean string value as false', async () => {
    const { loadMonitorAllSessions } = await import('../scripts/lib/config-loader.js');
    const result = withNioHome('collector:\n  monitor_all_sessions: "yes"\n', () =>
      loadMonitorAllSessions());
    assert.equal(result, false);
  });

  it('treats numeric 1 as false — only the boolean literal true counts', async () => {
    // The strict `=== true` check in loadMonitorAllSessions is
    // specifically about rejecting truthy-but-not-boolean values, and a
    // string ("yes") doesn't pin that against the most obvious near-miss:
    // YAML's own `1`, which parses to a number, not a boolean.
    const { loadMonitorAllSessions } = await import('../scripts/lib/config-loader.js');
    const result = withNioHome('collector:\n  monitor_all_sessions: 1\n', () =>
      loadMonitorAllSessions());
    assert.equal(result, false);
  });

  it('treats numeric 0 as false', async () => {
    const { loadMonitorAllSessions } = await import('../scripts/lib/config-loader.js');
    const result = withNioHome('collector:\n  monitor_all_sessions: 0\n', () =>
      loadMonitorAllSessions());
    assert.equal(result, false);
  });
});
