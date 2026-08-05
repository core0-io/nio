// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression test for the flush backstop on guard-hook.ts
 * (`FLUSH_BACKSTOP_MS` / `withFlushBudget`).
 *
 * Before this fix guard-hook awaited its OTEL exports unbounded:
 *   - `recordGuardDecision()` ends with `meterProvider.forceFlush()`,
 *   - `recordPostToolUse()` (deny path) ends with
 *     `tracerProvider.forceFlush()`,
 *   - and the closing `Promise.all([...forceFlush()])`.
 * None of them is bounded by `collector.timeout`: that config governs the
 * request timeout once a socket exists and does nothing during TCP
 * connect. Pointed at an endpoint that silently drops packets, connect()
 * blocks until the OS-level TCP timeout (~75s macOS, 100s+ Linux).
 * guard-hook runs on PreToolUse, so that stall is the host CLI's tool
 * call sitting frozen. Measured on the author's machine before the fix:
 * still alive when killed at 40s (both allow and deny paths). After:
 * ~5.3s, exit code preserved (0 allow / 2 deny).
 *
 * Note the hang site: it was inside `recordGuardDecision`, i.e. *before*
 * the closing Promise.all. A fix that bounds only the final flush leaves
 * this test red — which is exactly what the mutation check confirmed.
 *
 * Environment caveat (same as scanner-hook-shutdown-timeout.test.ts):
 * discriminating power depends on connect() to RFC 5737 TEST-NET-1
 * (192.0.2.1, reserved for documentation, guaranteed unroutable)
 * actually blocking rather than failing fast. On a host whose network
 * RSTs or ICMP-unreachables it immediately, the unbounded version would
 * also return quickly and this test passes without exercising the fix.
 * That's a loss of power on such hosts, never a false failure.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { trackTempDir } from './helpers/tmp-dirs.js';

// Bundled by bun into plugins/claude-code/skills/nio/scripts/, not
// dist/scripts/ — same resolution as monitor-guard-hook.test.ts.
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(
  HERE, '..', '..', 'plugins', 'claude-code', 'skills', 'nio', 'scripts', 'guard-hook.js',
);

// RFC 5737 TEST-NET-1: reserved for documentation, guaranteed unroutable.
const UNROUTABLE_ENDPOINT = 'http://192.0.2.1:4318';

// Ceiling for the whole hook run. The backstop budget is 5s
// (FLUSH_BACKSTOP_MS, and `collector.timeout` when smaller), plus
// process start and guard evaluation — measured ~5.3s. 20s leaves ~4x
// headroom for slow CI while staying far below the ~75s OS TCP connect
// timeout the unbounded version blocks on, so a regression still shows
// up as a failure rather than a slow pass.
const EXIT_BOUND_MS = 20000;

interface RunResult { code: number | null; elapsedMs: number; stdout: string; stderr: string; timedOut: boolean }

/**
 * A fresh NIO_HOME whose telemetry points at an unroutable endpoint.
 *
 * `monitor_all_sessions: true` matters: guard-hook gates provider
 * creation on `isSessionMonitored`, and these fixture sessions are never
 * armed — without it, meter/tracer/logger would all be null, no socket
 * would ever be opened, and the test would pass without touching the
 * code path it exists to pin.
 */
function nioHome(): string {
  const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-guard-flush-')));
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
 * Async spawn (not execFileSync) so both cases run concurrently — each
 * would otherwise serialize behind the other's multi-second budget.
 */
function runGuardHook(home: string, payload: unknown): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn('node', [CLI], { env: { ...process.env, NIO_HOME: home } });
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
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

describe('guard-hook flush backstop against an unroutable OTLP endpoint', () => {
  let allowRun: Promise<RunResult>;
  let denyRun: Promise<RunResult>;

  before(() => {
    const allowHome = nioHome();
    allowRun = runGuardHook(allowHome, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls /tmp' },
      session_id: 'sess-guard-flush-allow',
      cwd: allowHome,
    });

    const denyHome = nioHome();
    denyRun = runGuardHook(denyHome, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
      session_id: 'sess-guard-flush-deny',
      cwd: denyHome,
    });
  });

  it('allow path exits within the budget instead of blocking on TCP connect', async () => {
    const r = await allowRun;
    assert.ok(
      !r.timedOut,
      `guard-hook (allow) did not exit within ${EXIT_BOUND_MS}ms — the flush backstop ` +
      `appears to have regressed; stderr so far: ${r.stderr.slice(0, 400)}`,
    );
    assert.equal(r.code, 0, `expected allow exit code 0, got ${r.code}; stderr: ${r.stderr.slice(0, 400)}`);
  });

  it('deny path still emits its reason and exits 2 within the budget', async () => {
    const r = await denyRun;
    assert.ok(
      !r.timedOut,
      `guard-hook (deny) did not exit within ${EXIT_BOUND_MS}ms — the flush backstop ` +
      `appears to have regressed; stderr so far: ${r.stderr.slice(0, 400)}`,
    );
    // Exit code 2 + a non-empty stderr reason is the Claude Code deny
    // contract; the backstop must not cost us the decision itself.
    assert.equal(r.code, 2, `expected deny exit code 2, got ${r.code}; stderr: ${r.stderr.slice(0, 400)}`);
    assert.ok(r.stderr.trim().length > 0, 'deny path must write a reason to stderr');
  });
});
