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
 * (see EXIT_TIMEOUT_MS) that turns a hang back into a fast test failure
 * instead of blocking the suite.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

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
// tick already had in flight. Measured directly (independent of node:
// test's own per-`it` timer, which understates cases whose promise was
// already settled by the time `before` handed it off — see the report),
// across 3 concurrent runs of this exact fixture: collector path
// (post_tool_call) ~10.6-12.1s, guard path deny branch (meter + tracer
// both flushing) ~17.9-21.1s — the consistent worst case — guard path
// allow branch ~14.4-16.1s. Concurrency does not measurably worsen these
// (each case is I/O-bound on its own retry/backoff timers, not
// CPU-bound, so running 3 at once isn't contending for anything that
// slows an individual case down). 45s keeps ~2x headroom over the
// observed ~21s worst case for CI machines slower than this one,
// without masking a real hang as a slow pass.
const EXIT_TIMEOUT_MS = 45000;

/**
 * Async, non-blocking spawn — required for concurrency (execFileSync
 * blocks the caller until the child exits, which serializes any cases
 * that share it). Each call owns its own timeout so one hung case
 * can't stall the others sharing the same `before` kickoff.
 */
function runHookAsync(home: string, envelope: unknown, timeoutMs = EXIT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI, '--platform', 'hermes', '--stdin'], {
      env: { ...process.env, NIO_HOME: home },
    });
    let out = '';
    let err = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`hook-cli timed out after ${timeoutMs}ms; stderr so far: ${err}`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`hook-cli exited with code ${code}; stderr: ${err}`));
        return;
      }
      resolve(out);
    });
    child.stdin.write(JSON.stringify(envelope));
    child.stdin.end();
  });
}

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
