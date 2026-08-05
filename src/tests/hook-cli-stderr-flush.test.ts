// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression test for stderr loss in hook-cli.ts's `writeAndExit`.
 *
 * `writeAndExit` used to call `process.exit(0)` from stdout's write
 * callback. stdout and stderr are different file descriptors with no
 * ordering guarantee between them, and both are async pipes when Hermes
 * spawns us — so an exit driven by stdout alone tears the process down
 * with stderr still buffered.
 *
 * Everything hook-cli writes to stderr is written BEFORE `writeAndExit`
 * is reached: the guard's diagnostics block, the
 * `confirm_action: 'ask'` fallback warning, and every
 * `[nio:collector:*]` export diagnostic. All of it is at risk.
 *
 * Measured through the real CLI before the fix: one `external_analyser`
 * entry whose endpoint is long (the failure diagnostic echoes the
 * endpoint) produces a 500248-byte stderr block, and the process exited
 * in 228ms having delivered 65536 bytes of it — one pipe buffer. The
 * whole point of those diagnostics is to tell the user their collector
 * or scoring endpoint is misconfigured; cutting them at 64KB defeats it.
 *
 * The fix exits only once stdout's callback has fired AND stderr has
 * nothing left buffered. This test stalls the stderr consumer past the
 * point where the old code would have exited, then asserts the whole
 * block arrived.
 *
 * Note the allow path is used deliberately: stdout is 3 bytes ("{}\n"),
 * so its write completes essentially instantly and the exit is entirely
 * stdout-driven — which is exactly the race being pinned. A large stdout
 * would mask it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { trackTempDir } from './helpers/tmp-dirs.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(
  HERE, '..', '..', 'plugins', 'claude-code', 'skills', 'nio', 'scripts', 'hook-cli.js',
);

// Padding for the analyser endpoint. The `response_invalid` / request
// failure diagnostic embeds the endpoint, so this is the knob that makes
// stderr exceed a pipe buffer without needing a cooperating server.
const ENDPOINT_PAD = 250_000;

// Comfortably above one pipe buffer (65536) — the exact figure the
// broken version delivered — so a truncated result is unambiguous.
const MIN_EXPECTED_STDERR = 200_000;

// How long the stderr consumer refuses to read. Only has to outlast the
// ~230ms the old code took to exit; kept short so the test is fast.
const CONSUMER_STALL_MS = 2000;

const RUN_TIMEOUT_MS = 30_000;

interface RunResult { code: number | null; stdout: string; stderrBytes: number; elapsedMs: number }

/** Spawn hook-cli with stderr paused, resumed only after the stall. */
function runWithStalledStderr(home: string, envelope: unknown): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn('node', [CLI, '--platform', 'hermes', '--stdin'], {
      env: { ...process.env, NIO_HOME: home },
    });
    let stdout = '';
    let stderrBytes = 0;
    let settled = false;

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (d: string) => { stdout += d; });
    child.stderr.on('data', (d: Buffer) => { stderrBytes += d.length; });
    child.stderr.pause();
    const resumeTimer = setTimeout(() => child.stderr.resume(), CONSUMER_STALL_MS);

    const killTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearTimeout(resumeTimer);
      child.kill('SIGKILL');
      reject(new Error(`hook-cli did not exit within ${RUN_TIMEOUT_MS}ms`));
    }, RUN_TIMEOUT_MS);

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(resumeTimer);
      clearTimeout(killTimer);
      reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(resumeTimer);
      clearTimeout(killTimer);
      resolve({ code, stdout, stderrBytes, elapsedMs: Date.now() - start });
    });

    child.stdin.write(JSON.stringify(envelope));
    child.stdin.end();
  });
}

describe('hook-cli waits for stderr before exiting', () => {
  it('delivers the whole diagnostics block, not one pipe buffer', async () => {
    const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-hook-cli-stderr-')));
    // Port 59999 is expected to refuse/ignore the connection — the point
    // is the failed request's diagnostic, not a response. `timeout: 500`
    // keeps the failure quick.
    const endpoint = `http://127.0.0.1:59999/${'z'.repeat(ENDPOINT_PAD)}`;
    writeFileSync(join(home, 'config.yaml'), `guard:
  protection_level: balanced
  confirm_action: allow
  external_analyser:
    - name: long-endpoint
      enabled: true
      endpoint: "${endpoint}"
      timeout: 500
collector:
  endpoint: ""
`, 'utf-8');

    const r = await runWithStalledStderr(home, {
      hook_event_name: 'pre_tool_call',
      tool_name: 'terminal',
      tool_input: { command: 'ls /tmp' },
      session_id: 'sess-stderr-flush',
      cwd: home,
      extra: {},
    });

    assert.equal(r.code, 0);
    // The allow contract is unchanged — stdout still says {}.
    assert.equal(r.stdout.trim(), '{}');

    assert.ok(
      r.stderrBytes >= MIN_EXPECTED_STDERR,
      `stderr was truncated to ${r.stderrBytes} bytes (expected >= ${MIN_EXPECTED_STDERR}); ` +
      `65536 means exactly one pipe buffer got through, i.e. the process exited on stdout's ` +
      `callback while stderr was still draining`,
    );

    // Guard against the test passing because stderr happened to drain
    // before the stall even began — then it would prove nothing.
    assert.ok(
      r.elapsedMs >= CONSUMER_STALL_MS,
      `expected the run to outlast the ${CONSUMER_STALL_MS}ms stderr stall, took ${r.elapsedMs}ms`,
    );
  });
});
