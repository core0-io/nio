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

  it('treats a non-boolean value as false', async () => {
    const { loadMonitorAllSessions } = await import('../scripts/lib/config-loader.js');
    const result = withNioHome('collector:\n  monitor_all_sessions: "yes"\n', () =>
      loadMonitorAllSessions());
    assert.equal(result, false);
  });
});
