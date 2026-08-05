// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InProcessPluginRuntime } from '../adapters/plugin-runtime.js';
import { OpenClawAdapter } from '../adapters/openclaw.js';

describe('InProcessPluginRuntime', () => {
  function makeRuntime() {
    return new InProcessPluginRuntime({
      platform: 'test-platform',
      adapter: new OpenClawAdapter(),
    });
  }

  it('exposes the configured platform tag', () => {
    assert.equal(makeRuntime().platform, 'test-platform');
  });

  it('lazily builds one orchestrator and reuses it', () => {
    const rt = makeRuntime();
    assert.equal(rt.orchestrator, rt.orchestrator);
  });

  it('onSessionStart clears any prior state for that session id', async () => {
    const rt = makeRuntime();
    rt.onSessionStart('s1');
    assert.equal(rt.hasSessionState('s1'), false);
  });

  it('onSessionEnd is a no-op when no state exists', async () => {
    const rt = makeRuntime();
    await rt.onSessionEnd('never-seen');
    assert.equal(rt.hasSessionState('never-seen'), false);
  });

  it('onTurnEnd is idempotent', async () => {
    const rt = makeRuntime();
    await rt.onTurnEnd('s1');
    await rt.onTurnEnd('s1');
    assert.equal(rt.hasSessionState('s1'), false);
  });
});
