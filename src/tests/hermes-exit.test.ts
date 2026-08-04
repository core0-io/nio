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
 * execFileSync's `timeout` option turns a hang back into a fast test
 * failure (SIGTERM + thrown error) instead of blocking the suite
 * indefinitely.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Bundled by bun into plugins/claude-code/skills/nio/scripts/, not
// dist/scripts/ — see hook-cli.test.ts for the same resolution.
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(
  HERE, '..', '..', 'plugins', 'claude-code', 'skills', 'nio', 'scripts', 'hook-cli.js',
);

function freshHomeWithUnreachableEndpoint(): string {
  const home = mkdtempSync(join(tmpdir(), 'nio-hermes-exit-'));
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

// The exporter's per-attempt budget is config.timeout (5s), but a
// refused connection is retried (RetryingTransport, up to 5 attempts
// with jittered backoff) inside that budget, and the meter/tracer/
// logger providers' forceFlush() calls run concurrently but each
// carries its own retry cycle plus whatever the 1s periodic metrics
// tick already had in flight. Measured against this exact fixture:
// the collector path (post_tool_call) settles around ~11s and the
// guard path (pre_tool_call, deny branch — meter + tracer both
// flushing) around ~20s. 35s leaves headroom for backoff jitter
// without masking a real hang as a slow pass.
const EXIT_TIMEOUT_MS = 35000;

function runHook(home: string, envelope: unknown): string {
  return execFileSync('node', [CLI, '--platform', 'hermes', '--stdin'], {
    env: { ...process.env, NIO_HOME: home },
    input: JSON.stringify(envelope),
    encoding: 'utf-8',
    timeout: EXIT_TIMEOUT_MS,
  });
}

describe('hermes hook-cli exits with an unreachable OTLP endpoint', () => {
  it('collector path (post_tool_call) exits and emits {} instead of hanging', () => {
    const home = freshHomeWithUnreachableEndpoint();
    const out = runHook(home, {
      hook_event_name: 'post_tool_call',
      tool_name: 'terminal',
      tool_input: { command: 'ls' },
      session_id: 'sess-exit-1',
      cwd: home,
      extra: { tool_call_id: 'call-1', result: 'ok' },
    });
    assert.equal(out.trim(), '{}');
  });

  it('guard path (pre_tool_call) exits and emits the block decision instead of hanging', () => {
    const home = freshHomeWithUnreachableEndpoint();
    const out = runHook(home, {
      hook_event_name: 'pre_tool_call',
      tool_name: 'terminal',
      tool_input: { command: 'rm -rf /' },
      session_id: 'sess-exit-2',
      cwd: home,
      extra: {},
    });
    const parsed = JSON.parse(out.trim());
    assert.equal(parsed.decision, 'block');
    assert.ok(typeof parsed.reason === 'string' && parsed.reason.length > 0);
  });

  it('guard path (pre_tool_call) allow branch exits and emits {} instead of hanging', () => {
    const home = freshHomeWithUnreachableEndpoint();
    const out = runHook(home, {
      hook_event_name: 'pre_tool_call',
      tool_name: 'terminal',
      tool_input: { command: 'ls /tmp' },
      session_id: 'sess-exit-3',
      cwd: home,
      extra: {},
    });
    assert.equal(out.trim(), '{}');
  });
});
