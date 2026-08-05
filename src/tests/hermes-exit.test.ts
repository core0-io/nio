// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression test for the Hermes hang: hook-cli.ts must exit after
 * writing its response even when collector.endpoint is configured but
 * unreachable.
 *
 * Root cause: the meter provider's PeriodicExportingMetricReader keeps
 * a retry timer alive past forceFlush() when the endpoint refuses the
 * connection, so the event loop never drains and the subprocess hangs
 * forever unless something calls process.exit() explicitly. Neither
 * the collector path (runHermesCollector) nor the guard path
 * (pre_tool_call branch) called process.exit() before this fix — only
 * forceFlush(). No existing hook-cli test ever set collector.endpoint,
 * so this path was never exercised.
 *
 * The 3 cases below spawn independent `hook-cli.js` subprocesses against
 * independent mkdtemp homes — no shared state — so they run concurrently
 * (kicked off together in `before`, each `it` just awaits its own
 * promise) rather than serially. Each carries its own explicit timeout
 * (see helpers/hermes-hook.ts) that turns a hang back into a fast test failure
 * instead of blocking the suite.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHermesHookAsync } from './helpers/hermes-hook.js';
import { trackTempDir } from './helpers/tmp-dirs.js';

function freshHomeWithUnreachableEndpoint(): string {
  const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-hermes-exit-')));
  // monitor_all_sessions: true keeps this test exercising real provider
  // creation (and therefore the real forceFlush()-against-an-unreachable-
  // endpoint path this file pins) after hook-cli.ts's Hermes paths were
  // gated on isSessionMonitored() — none of these fixture session ids
  // are ever armed, so without this the gate would make meter/tracer/
  // logger providers null and the test would pass without ever touching
  // the network, silently stopping being a regression test for the hang.
  writeFileSync(join(home, 'config.yaml'), `guard:
  protection_level: balanced
  confirm_action: allow
collector:
  endpoint: "http://127.0.0.1:19999"
  monitor_all_sessions: true
`, 'utf-8');
  return home;
}

// Timeout, spawn wiring and CLI resolution all live in
// helpers/hermes-hook.ts — monitor-hermes.test.ts drives the same binary
// the same way, and this used to be a byte-identical copy in each file
// with a comment asking the reader to keep the constants in sync by
// hand. See that helper for the measured refused-endpoint timings the
// 45s ceiling is sized against.
const runHookAsync = runHermesHookAsync;

describe('hermes hook-cli exits with an unreachable OTLP endpoint', () => {
  let collectorPromise: Promise<string>;
  let guardDenyPromise: Promise<string>;
  let guardAllowPromise: Promise<string>;

  // Kick off all 3 subprocesses together, before any `it` runs, so they
  // execute concurrently instead of one-after-another. Each `it` below
  // just awaits the promise that belongs to it.
  before(() => {
    const collectorHome = freshHomeWithUnreachableEndpoint();
    collectorPromise = runHookAsync(collectorHome, {
      hook_event_name: 'post_tool_call',
      tool_name: 'terminal',
      tool_input: { command: 'ls' },
      session_id: 'sess-exit-1',
      cwd: collectorHome,
      extra: { tool_call_id: 'call-1', result: 'ok' },
    });

    const guardDenyHome = freshHomeWithUnreachableEndpoint();
    guardDenyPromise = runHookAsync(guardDenyHome, {
      hook_event_name: 'pre_tool_call',
      tool_name: 'terminal',
      tool_input: { command: 'rm -rf /' },
      session_id: 'sess-exit-2',
      cwd: guardDenyHome,
      extra: {},
    });

    const guardAllowHome = freshHomeWithUnreachableEndpoint();
    guardAllowPromise = runHookAsync(guardAllowHome, {
      hook_event_name: 'pre_tool_call',
      tool_name: 'terminal',
      tool_input: { command: 'ls /tmp' },
      session_id: 'sess-exit-3',
      cwd: guardAllowHome,
      extra: {},
    });
  });

  it('collector path (post_tool_call) exits and emits {} instead of hanging', async () => {
    const out = await collectorPromise;
    assert.equal(out.trim(), '{}');
  });

  it('guard path (pre_tool_call) exits and emits the block decision instead of hanging', async () => {
    const out = await guardDenyPromise;
    const parsed = JSON.parse(out.trim());
    assert.equal(parsed.decision, 'block');
    assert.ok(typeof parsed.reason === 'string' && parsed.reason.length > 0);
  });

  it('guard path (pre_tool_call) allow branch exits and emits {} instead of hanging', async () => {
    const out = await guardAllowPromise;
    assert.equal(out.trim(), '{}');
  });
});
