// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * The two mechanisms inside `hook-cli.ts`'s `writeAndExit` that
 * `hook-cli-large-payload.test.ts` does NOT pin.
 *
 * Review finding M1 — both survived mutation with the whole suite green:
 *
 *   c4  delete `process.stdout.on('error', finish)` /
 *       `process.stderr.on('error', finish)`             SURVIVED
 *   c5  delete the progress-detection branch, i.e. revert the backstop
 *       from progress-aware to a flat 10s wall clock      SURVIVED
 *
 * `hook-cli-large-payload.test.ts` stalls its consumer for 3s, which only
 * ever proved "10s > 2s" — it is killed by shrinking
 * WRITE_STALL_TIMEOUT_MS, and by nothing else. A flat 10s deadline passes
 * it comfortably, so the very regression the progress-aware rewrite was
 * made to prevent (a 300KB+ `external_analyser` deny reason getting cut
 * mid-JSON, which Hermes's `_parse_response` degrades to no-action —
 * an ALLOWED dangerous action) is invisible.
 *
 * Both tests below drive `plugins/hermes/scripts/hook-cli.js`, the
 * single-file bundle Hermes actually executes, not the chunked Claude Code
 * one — `writeAndExit`'s whole reason to exist is the Hermes stdout
 * contract.
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
const CLI = join(HERE, '..', '..', 'plugins', 'hermes', 'scripts', 'hook-cli.js');

/**
 * Payload size and drain rate are chosen together so the write is STILL
 * in flight when the 10s no-progress window elapses, with the consumer
 * never once stopping:
 *
 *   drain rate = 8192 B / 450 ms ≈ 18.2 KB/s
 *   by SLOW_PHASE_MS the consumer has taken ~200KB and node has buffered
 *   ~130KB more, so ~120KB of a 450KB payload is still unwritten.
 *
 * After SLOW_PHASE_MS the consumer switches to full speed. That is not a
 * convenience: `child.stdout` DROPS whatever is still in its readable
 * buffer the moment the child's stdout closes (measured: bufLen=57344 one
 * tick before EOF, 0 at 'end'), so a slow consumer can never collect the
 * tail after the child exits — it has to overtake the writer first. The
 * switch happens after the stall window, so a flat-deadline build has
 * already given up by then and its tail is genuinely gone.
 */
const BIG_REASON_BYTES = 450_000;
const DRAIN_CHUNK_BYTES = 8192;
const DRAIN_INTERVAL_MS = 450;

/** Mirrors WRITE_STALL_TIMEOUT_MS in hook-cli.ts. */
const WRITE_STALL_TIMEOUT_MS = 10_000;

/** How long the consumer stays slow. Must outlast the stall window. */
const SLOW_PHASE_MS = 11_000;

const RUN_TIMEOUT_MS = 60_000;

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

function denyHome(scorerUrl: string): string {
  const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-hook-cli-stall-')));
  writeFileSync(join(home, 'config.yaml'), `guard:
  protection_level: balanced
  confirm_action: deny
  external_analyser:
    - name: big-reason
      enabled: true
      endpoint: "${scorerUrl}"
collector:
  endpoint: ""
`, 'utf-8');
  return home;
}

function denyEnvelope(home: string): unknown {
  return {
    hook_event_name: 'pre_tool_call',
    tool_name: 'terminal',
    tool_input: { command: 'ls /tmp' },
    session_id: 'sess-write-stall',
    cwd: home,
    extra: {},
  };
}

interface RunResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; elapsedMs: number }

/**
 * Spawn hook-cli behind a consumer that is slow but never stopped: the
 * stream is paused and `read(DRAIN_CHUNK_BYTES)` is called on a timer, so
 * bytes keep leaving at a steady ~18KB/s. After SLOW_PHASE_MS — i.e. once
 * the stall window has been survived — it switches to full speed so the
 * tail can be collected before the child's stdout closes.
 */
function runWithSlowConsumer(home: string, envelope: unknown): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn('node', [CLI, '--platform', 'hermes', '--stdin'], {
      env: { ...process.env, NIO_HOME: home },
    });
    const chunks: Buffer[] = [];
    let settled = false;
    child.stdout.pause();
    child.stderr.resume();

    const pump = setInterval(() => {
      if (Date.now() - start >= SLOW_PHASE_MS) {
        clearInterval(pump);
        child.stdout.on('data', (d: Buffer) => chunks.push(d));
        child.stdout.resume();
        return;
      }
      const c = child.stdout.read(DRAIN_CHUNK_BYTES) as Buffer | null;
      if (c) chunks.push(c);
    }, DRAIN_INTERVAL_MS);

    const killTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearInterval(pump);
      child.kill('SIGKILL');
      reject(new Error(`hook-cli did not exit within ${RUN_TIMEOUT_MS}ms`));
    }, RUN_TIMEOUT_MS);

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearInterval(pump);
      clearTimeout(killTimer);
      reject(e);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearInterval(pump);
      clearTimeout(killTimer);
      let rest: Buffer | null;
      while ((rest = child.stdout.read() as Buffer | null) !== null) chunks.push(rest);
      resolve({
        code, signal,
        stdout: Buffer.concat(chunks).toString('utf-8'),
        elapsedMs: Date.now() - start,
      });
    });

    child.stdin.write(JSON.stringify(envelope));
    child.stdin.end();
  });
}

describe('hook-cli writeAndExit: the backstop measures PROGRESS, not wall clock', () => {
  it('delivers the whole deny payload to a consumer that is slow for longer than the stall window', async () => {
    const scorer = await startScoreServer();
    try {
      const home = denyHome(scorer.url);
      const r = await runWithSlowConsumer(home, denyEnvelope(home));

      // The mechanism has to have actually been exercised: if the run
      // finished inside the 10s window, a flat deadline would pass too and
      // the test proves nothing.
      assert.ok(
        r.elapsedMs > WRITE_STALL_TIMEOUT_MS,
        `the drain finished in ${r.elapsedMs}ms, inside the ${WRITE_STALL_TIMEOUT_MS}ms stall ` +
        'window — this run did not exercise the progress-aware backstop at all',
      );

      assert.equal(r.code, 0, `expected exit 0, got code=${r.code} signal=${r.signal}`);

      assert.ok(
        r.stdout.length > BIG_REASON_BYTES,
        `stdout was cut to ${r.stdout.length} bytes (expected > ${BIG_REASON_BYTES}) after ` +
        `${r.elapsedMs}ms — the backstop fired against a consumer that was still making ` +
        'progress, i.e. it is a flat wall-clock deadline again',
      );

      // What Hermes actually does with it: a cut payload raises
      // JSONDecodeError in _parse_response, which returns None, which
      // means no-action — a truncated DENY is an allowed dangerous action.
      const parsed = JSON.parse(r.stdout.trim()) as { decision?: string; reason?: string };
      assert.equal(parsed.decision, 'block');
      assert.ok(
        (parsed.reason ?? '').length >= BIG_REASON_BYTES,
        `the deny reason itself was cut (${(parsed.reason ?? '').length} chars)`,
      );
    } finally {
      await scorer.close();
    }
  });
});

describe('hook-cli writeAndExit: a closed stdout pipe exits cleanly', () => {
  /**
   * A MULTI-CHUNK payload is required here, which is why this reuses the
   * big-reason scorer rather than a plain `{}` allow.
   *
   * Measured (node 25.9): an EPIPE whose write callback exits the process
   * never reaches the deferred `emitErrorNT` tick, so a SINGLE-chunk
   * payload exits 0 with or without the listener — the listener only
   * looks load-bearing. With the payload chunked, the failing write is a
   * NON-final chunk whose callback does not exit, the 'error' event lands
   * unhandled, and node exits 1:
   *
   *   single write, cb exits, no listener → code 0
   *   single write, no exiting cb, no listener → code 1 (uncaught EPIPE)
   */
  it('exits 0 rather than dying on an uncaught EPIPE mid-payload', async () => {
    const scorer = await startScoreServer();
    try {
      const home = denyHome(scorer.url);
      const r = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; elapsedMs: number }>(
        (resolve, reject) => {
          const start = Date.now();
          const child = spawn('node', [CLI, '--platform', 'hermes', '--stdin'], {
            env: { ...process.env, NIO_HOME: home },
          });
          let settled = false;
          child.stderr.resume();
          child.stdout.destroy();          // slam the read end shut

          const killTimer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill('SIGKILL');
            reject(new Error('hook-cli did not exit after its stdout pipe was closed'));
          }, 30_000);

          child.on('error', (e) => {
            if (settled) return;
            settled = true;
            clearTimeout(killTimer);
            reject(e);
          });
          child.on('close', (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(killTimer);
            resolve({ code, signal, elapsedMs: Date.now() - start });
          });

          child.stdin.write(JSON.stringify(denyEnvelope(home)));
          child.stdin.end();
        },
      );

      assert.equal(
        r.code, 0,
        'a host that closed its end of the pipe must not be reported to Hermes as a hook ' +
        `failure (shell_hooks.py logs it as one); got code=${r.code} signal=${r.signal}`,
      );
      assert.ok(
        r.elapsedMs < WRITE_STALL_TIMEOUT_MS,
        `EPIPE must be handled by the stream's own 'error' event, not by waiting out the ` +
        `${WRITE_STALL_TIMEOUT_MS}ms backstop; took ${r.elapsedMs}ms`,
      );
    } finally {
      await scorer.close();
    }
  });
});
