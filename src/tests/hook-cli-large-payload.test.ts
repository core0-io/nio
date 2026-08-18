// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression test for stdout truncation in hook-cli.ts's `writeAndExit`.
 *
 * The naive shape for `writeAndExit` — a flat wall-clock timer that
 * calls `process.exit(0)` when it fires, regardless of how much of the
 * payload has actually left the buffer — makes truncation a matter of
 * luck, and it is tempting to dismiss on the grounds that "Hermes
 * payloads never approach that size". They do:
 *
 *   guard.external_analyser (Phase 6) accepts `{ score, reason }` from a
 *   user-configured HTTP endpoint, and that `reason` becomes the deny
 *   explanation, which becomes the `{"decision":"block","reason":...}`
 *   written here. A long reason is a 300KB stdout payload through an
 *   entirely supported code path.
 *
 * Measured before the fix, with the same 300KB payload and a consumer
 * that stalls 3s: the process exited at ~2.2s having written exactly
 * 131072 bytes — one pipe buffer — and dropped the remaining ~169KB.
 *
 * Why that matters more than a lost log line: Hermes parses our stdout
 * (`shell_hooks.py::_parse_response`). Truncated JSON raises
 * JSONDecodeError, `_parse_response` returns None, and None means
 * no-action. A truncated DENY is an allowed dangerous action.
 *
 * The fix measures the deadline against progress rather than wall clock,
 * so a slow-but-draining consumer is never cut off. This test pins the
 * whole payload arriving intact and still parsing as a block decision.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { trackTempDir } from './helpers/tmp-dirs.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(
  HERE, '..', '..', 'plugins', 'hermes', 'scripts', 'hook-cli.js',
);

// Comfortably larger than a pipe buffer (64KB) and than the 128KB the
// broken version managed to deliver, so a truncated result is
// unambiguous rather than borderline.
const BIG_REASON_BYTES = 300_000;

// How long the consumer refuses to read. Must exceed the old flat 2s
// backstop — that is the entire point — while staying well under the
// 10s no-progress window the fix uses, so a correct implementation waits
// this out instead of giving up.
const CONSUMER_STALL_MS = 3000;

const RUN_TIMEOUT_MS = 30_000;

interface ScoreServer { url: string; close: () => Promise<void> }

/** A Phase 6 scoring endpoint whose `reason` is deliberately enormous. */
function startScoreServer(): Promise<ScoreServer> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ score: 1, reason: 'X'.repeat(BIG_REASON_BYTES) });
    const server: Server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('score server failed to bind'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}/score`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

interface RunResult { code: number | null; stdout: string; elapsedMs: number }

/**
 * Spawn hook-cli with a deliberately stalled stdout consumer: the stream
 * is paused immediately (so the OS pipe buffer fills and the write cannot
 * complete) and only resumed after CONSUMER_STALL_MS.
 */
function runWithStalledConsumer(home: string, envelope: unknown): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn('node', [CLI, '--platform', 'hermes', '--stdin'], {
      env: { ...process.env, NIO_HOME: home },
    });
    let stdout = '';
    let settled = false;
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (d: string) => { stdout += d; });
    child.stdout.pause();
    const resumeTimer = setTimeout(() => child.stdout.resume(), CONSUMER_STALL_MS);
    child.stderr.resume();

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
      resolve({ code, stdout, elapsedMs: Date.now() - start });
    });

    child.stdin.write(JSON.stringify(envelope));
    child.stdin.end();
  });
}

describe('hook-cli large payload vs. a stalled stdout consumer', () => {
  it('delivers the whole deny payload instead of one pipe buffer', async () => {
    const scorer = await startScoreServer();
    try {
      const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-hook-cli-big-')));
      writeFileSync(join(home, 'config.yaml'), `guard:
  protection_level: balanced
  confirm_action: deny
  external_analyser:
    - name: big-reason
      enabled: true
      endpoint: "${scorer.url}"
collector:
  endpoint: ""
`, 'utf-8');

      const r = await runWithStalledConsumer(home, {
        hook_event_name: 'pre_tool_call',
        tool_name: 'terminal',
        tool_input: { command: 'ls /tmp' },
        session_id: 'sess-big-payload',
        cwd: home,
        extra: {},
      });

      assert.equal(r.code, 0);

      // Fail loudly and specifically on the historical truncation point.
      assert.ok(
        r.stdout.length > BIG_REASON_BYTES,
        `stdout was truncated to ${r.stdout.length} bytes (expected > ${BIG_REASON_BYTES}); ` +
        `131072 means exactly one pipe buffer got through, i.e. the write backstop fired ` +
        `before the payload drained`,
      );

      // The property that actually matters to Hermes: it must still
      // parse, and must still say "block". A truncated payload raises
      // JSONDecodeError in _parse_response and degrades to no-action.
      const parsed = JSON.parse(r.stdout.trim()) as { decision?: string; reason?: string };
      assert.equal(parsed.decision, 'block');
      assert.ok(
        (parsed.reason ?? '').length >= BIG_REASON_BYTES,
        `the deny reason itself was truncated (${(parsed.reason ?? '').length} chars)`,
      );

      // Sanity on the mechanism: a run that finished before the consumer
      // even resumed would mean the stall never actually applied, and the
      // test would prove nothing.
      assert.ok(
        r.elapsedMs >= CONSUMER_STALL_MS,
        `expected the run to outlast the ${CONSUMER_STALL_MS}ms consumer stall, took ${r.elapsedMs}ms`,
      );
    } finally {
      await scorer.close();
    }
  });
});
