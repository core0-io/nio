// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression test for the flush backstop on `collector-hook.ts` and on
 * BOTH of `hook-cli.ts`'s Hermes paths (guard + collector).
 *
 * Companion to `guard-hook-flush-timeout.test.ts`, which pins the same
 * property for `guard-hook.ts`. The three entrypoints share
 * `lib/flush-budget.ts`.
 *
 * Before the fix, every OTLP-touching await in these files was unbounded.
 * `collector.timeout` does not bound them: it governs the request timeout
 * once a socket exists and does nothing during TCP connect. Against an
 * endpoint that silently DROPS packets, connect() blocks until the OS TCP
 * timeout and the exporter then retries on top of that. Measured on the
 * author's machine against RFC 5737 TEST-NET-1 (192.0.2.1:4318), all four
 * runs killed at 95s with none having exited:
 *
 *   collector-hook  PostToolUse           95023ms (SIGKILL)
 *   hook-cli        pre_tool_call allow   95026ms (SIGKILL)
 *   hook-cli        pre_tool_call deny    95023ms (SIGKILL)
 *   hook-cli        post_tool_call        95023ms (SIGKILL)
 *
 * Note the hang site: it is INSIDE `dispatchCollectorEvent` /
 * `recordGuardDecision`, not at the closing `Promise.all([...forceFlush])`
 * — nearly every branch ends in a library helper carrying its own
 * `provider.forceFlush()`. A fix that bounds only the closing flush
 * leaves these tests red, which is what the mutation check confirmed.
 *
 * The deny case is the sharpest one: Hermes runs hook-cli under
 * `subprocess.run(..., timeout=60)`, so an unbounded guard path means the
 * host kills the hook before the block decision is ever written and a
 * dangerous action is allowed through.
 *
 * Environment caveat (same as guard-hook-flush-timeout.test.ts and
 * scanner-hook-shutdown-timeout.test.ts): discriminating power depends on
 * connect() to 192.0.2.1 actually blocking rather than failing fast. On a
 * host whose network RSTs or ICMP-unreachables it immediately, the
 * unbounded version would also return quickly and these tests pass
 * without exercising the fix. That is a loss of power on such hosts,
 * never a false failure.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { trackTempDir } from './helpers/tmp-dirs.js';

// Both entrypoints are consumed as bun bundles, not as dist/ output —
// same resolution as guard-hook-flush-timeout.test.ts / hermes-exit.test.ts.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const COLLECTOR_HOOK = join(
  REPO, 'plugins', 'claude-code', 'skills', 'nio', 'scripts', 'collector-hook.js',
);
const HOOK_CLI = join(REPO, 'plugins', 'hermes', 'scripts', 'hook-cli.js');

// RFC 5737 TEST-NET-1: reserved for documentation, guaranteed unroutable.
const UNROUTABLE_ENDPOINT = 'http://192.0.2.1:4318';

// Ceiling for a whole hook run. The backstop budget is 5s
// (FLUSH_BACKSTOP_MS, and `collector.timeout` when smaller) plus process
// start and guard evaluation. 20s leaves ~4x headroom for slow CI while
// staying far below the 95s+ the unbounded version blocks for, so a
// regression shows up as a failure rather than a slow pass.
const EXIT_BOUND_MS = 20_000;

interface RunResult {
  code: number | null;
  elapsedMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * A fresh NIO_HOME whose telemetry points at the unroutable endpoint.
 *
 * `monitor_all_sessions: true` matters: both entrypoints gate provider
 * creation on `isSessionMonitored`, and these fixture sessions are never
 * armed — without it meter/tracer/logger would all be null, no socket
 * would ever be opened, and the test would pass without touching the code
 * path it exists to pin.
 */
function nioHome(): string {
  const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-collector-flush-')));
  writeFileSync(join(home, 'config.yaml'), `guard:
  protection_level: balanced
  confirm_action: allow
collector:
  endpoint: "${UNROUTABLE_ENDPOINT}"
  monitor_all_sessions: true
`, 'utf-8');
  return home;
}

/**
 * Async spawn (not execFileSync) so every case runs concurrently — they
 * would otherwise serialize behind each other's multi-second budget.
 */
function runHook(cli: string, args: string[], payloadFor: (home: string) => unknown): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const home = nioHome();
    const start = Date.now();
    const child = spawn('node', [cli, ...args], { env: { ...process.env, NIO_HOME: home } });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ code: null, elapsedMs: Date.now() - start, stdout, stderr, timedOut: true });
    }, EXIT_BOUND_MS);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
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
      resolve({ code, elapsedMs: Date.now() - start, stdout, stderr, timedOut: false });
    });
    child.stdin.write(JSON.stringify(payloadFor(home)));
    child.stdin.end();
  });
}

describe('collector flush backstop against a packet-dropping OTLP endpoint', () => {
  let collectorRun: Promise<RunResult>;
  let hermesAllowRun: Promise<RunResult>;
  let hermesDenyRun: Promise<RunResult>;
  let hermesPostRun: Promise<RunResult>;

  before(() => {
    collectorRun = runHook(COLLECTOR_HOOK, ['--platform', 'claude-code'], (home) => ({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: { output: 'x' },
      session_id: 'sess-collector-flush',
      cwd: home,
    }));

    hermesAllowRun = runHook(HOOK_CLI, ['--platform', 'hermes', '--stdin'], (home) => ({
      hook_event_name: 'pre_tool_call',
      tool_name: 'exec_command',
      tool_input: { command: 'ls /tmp' },
      session_id: 'sess-hermes-flush-allow',
      cwd: home,
    }));

    hermesDenyRun = runHook(HOOK_CLI, ['--platform', 'hermes', '--stdin'], (home) => ({
      hook_event_name: 'pre_tool_call',
      tool_name: 'exec_command',
      tool_input: { command: 'rm -rf /' },
      session_id: 'sess-hermes-flush-deny',
      cwd: home,
    }));

    hermesPostRun = runHook(HOOK_CLI, ['--platform', 'hermes', '--stdin'], (home) => ({
      hook_event_name: 'post_tool_call',
      tool_name: 'exec_command',
      tool_input: { command: 'ls' },
      session_id: 'sess-hermes-flush-post',
      cwd: home,
      extra: { result: 'ok', tool_call_id: 'tc-flush-1' },
    }));
  });

  it('collector-hook exits within the budget on PostToolUse', async () => {
    const r = await collectorRun;
    assert.ok(
      !r.timedOut,
      `collector-hook did not exit within ${EXIT_BOUND_MS}ms — the flush backstop ` +
      `appears to have regressed; stderr so far: ${r.stderr.slice(0, 400)}`,
    );
    // Telemetry never blocks the agent: collector-hook always exits 0.
    assert.equal(r.code, 0, `expected exit code 0, got ${r.code}; stderr: ${r.stderr.slice(0, 400)}`);
  });

  it('hook-cli guard path (allow) answers Hermes within the budget', async () => {
    const r = await hermesAllowRun;
    assert.ok(
      !r.timedOut,
      `hook-cli (allow) did not exit within ${EXIT_BOUND_MS}ms — the flush backstop ` +
      `appears to have regressed; stderr so far: ${r.stderr.slice(0, 400)}`,
    );
    assert.equal(r.code, 0, `expected exit code 0, got ${r.code}; stderr: ${r.stderr.slice(0, 400)}`);
    // Hermes's allow contract is a bare `{}` on stdout.
    assert.equal(r.stdout.trim(), '{}', `unexpected allow stdout: ${r.stdout.slice(0, 200)}`);
  });

  it('hook-cli guard path (deny) still delivers the block decision within the budget', async () => {
    const r = await hermesDenyRun;
    assert.ok(
      !r.timedOut,
      `hook-cli (deny) did not exit within ${EXIT_BOUND_MS}ms — the flush backstop ` +
      `appears to have regressed; stderr so far: ${r.stderr.slice(0, 400)}`,
    );
    assert.equal(r.code, 0, `expected exit code 0, got ${r.code}; stderr: ${r.stderr.slice(0, 400)}`);
    // The backstop must not cost us the decision itself — this is the
    // enforcement leg, not just a latency one.
    const parsed = JSON.parse(r.stdout.trim()) as { decision?: string; reason?: string };
    assert.equal(parsed.decision, 'block', `expected a block decision, got: ${r.stdout.slice(0, 200)}`);
    assert.ok((parsed.reason ?? '').length > 0, 'block decision must carry a reason');
  });

  it('hook-cli collector path exits within the budget on post_tool_call', async () => {
    const r = await hermesPostRun;
    assert.ok(
      !r.timedOut,
      `hook-cli (post_tool_call) did not exit within ${EXIT_BOUND_MS}ms — the flush ` +
      `backstop appears to have regressed; stderr so far: ${r.stderr.slice(0, 400)}`,
    );
    assert.equal(r.code, 0, `expected exit code 0, got ${r.code}; stderr: ${r.stderr.slice(0, 400)}`);
    assert.equal(r.stdout.trim(), '{}', `unexpected collector stdout: ${r.stdout.slice(0, 200)}`);
  });
});
