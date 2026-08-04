// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';

// Bundled by bun into plugins/claude-code/skills/nio/scripts/, not
// dist/scripts/ — see hook-cli.test.ts for the same resolution.
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(
  HERE, '..', '..', 'plugins', 'claude-code', 'skills', 'nio', 'scripts', 'hook-cli.js',
);

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'nio-monitor-hermes-'));
}

// Same reasoning and value as hermes-exit.test.ts's EXIT_TIMEOUT_MS (kept
// in sync with it — see that file for the measured timings this is sized
// against): this suite's fixtures include an unreachable collector.
// endpoint, and without an explicit timeout a regression that
// reintroduces *both* the hang (hook-cli.ts's writeAndExit) *and* the
// monitor gate (this file's own subject) at once would block CI forever
// instead of failing fast.
const HOOK_TIMEOUT_MS = 45000;

function runHook(home: string, envelope: unknown): string {
  return execFileSync('node', [CLI, '--platform', 'hermes', '--stdin'], {
    env: { ...process.env, NIO_HOME: home },
    input: JSON.stringify(envelope),
    encoding: 'utf-8',
    timeout: HOOK_TIMEOUT_MS,
  });
}

/**
 * Async equivalent of runHook(), required (not just preferred) for the
 * armed-vs-unarmed sink test below.
 *
 * execFileSync/spawnSync blocks the calling process's entire event loop
 * until the child exits — including the in-process `http.createServer`
 * sink that test stands up. Since the spawned hook-cli.js child needs to
 * connect *back* to that same parent process's HTTP server, a sync spawn
 * deadlocks: the child's connection sits unserviced until the parent's
 * event loop is free, which only happens after the (still-waiting) child
 * exits. Confirmed empirically — swapping runHook (execFileSync) in for
 * this in the sink test reproduced a hang that "Request timed out"
 * diagnostics in the audit log traced back to exactly this; switching to
 * spawn (which does not block the parent's event loop) fixed it
 * immediately, no other change required.
 */
function runHookAsync(home: string, envelope: unknown, timeoutMs = HOOK_TIMEOUT_MS): Promise<string> {
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

describe('hermes collector gating', () => {
  it('still writes the local audit log for an unmonitored session', () => {
    const home = freshHome();
    writeFileSync(join(home, 'config.yaml'),
      'collector:\n  endpoint: "http://127.0.0.1:19999"\n', 'utf-8');

    const out = runHook(home, {
      hook_event_name: 'post_tool_call',
      tool_name: 'terminal',
      tool_input: { command: 'ls' },
      session_id: 'sess-hermes-1',
      cwd: home,
      extra: { tool_call_id: 'call-1', result: 'ok' },
    });
    assert.equal(out.trim(), '{}');

    const auditPath = join(home, 'audit.jsonl');
    assert.equal(existsSync(auditPath), true);
    const lines = readFileSync(auditPath, 'utf-8').trim().split('\n');
    assert.equal(lines.length >= 1, true);
  });

  it('emits {} on stdout regardless of monitor state', () => {
    const home = freshHome();
    const out = runHook(home, {
      hook_event_name: 'on_session_start',
      session_id: 'sess-hermes-2',
      cwd: home,
      extra: {},
    });
    assert.equal(out.trim(), '{}');
  });
});

// ── Real discriminating coverage for the gate itself ────────────────────
//
// The two cases above only assert "stdout stays {}" and "the local audit
// log gets a line" — both true identically whether or not the monitor
// gate is wired at all (a mutation test that deletes every `monitored &&`
// in the bundled hook-cli.js still leaves all 1203 suite tests green).
// They pin the *contract* Hermes depends on, not the gating behavior
// Task 6 actually added.
//
// This block closes that gap: it stands up a real local OTLP sink and
// asserts an armed session's telemetry actually reaches it while an
// unarmed session's does not — the one property that can only be true
// if `monitored &&` is actually gating provider creation.

interface Sink {
  url: string;
  requestCount: () => number;
  close: () => Promise<void>;
}

function startSink(): Promise<Sink> {
  return new Promise((resolve, reject) => {
    let count = 0;
    const server: Server = createServer((req, res) => {
      count++;
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/x-protobuf' });
      res.end();
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('sink failed to bind to a port'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        requestCount: () => count,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

/** Arm a session directly in the store file, mirroring what monitor-cli's
 * `on` subcommand (or a claimed pending_arm) would persist — see
 * monitor-integration.test.ts's use of saveMonitorStore for the same
 * shape via the library function; done here as a raw write so this test
 * only depends on the on-disk contract, not another module's internals. */
function armSession(home: string, sessionId: string, cwd: string): void {
  writeFileSync(join(home, 'monitored-sessions.json'), JSON.stringify({
    sessions: { [sessionId]: { armed_at: Date.now(), cwd } },
  }), 'utf-8');
}

describe('hermes collector gating: armed vs unarmed reach the wire', () => {
  it('an armed session exports telemetry; an unarmed session in the same home does not', async () => {
    const home = freshHome();
    const sink = await startSink();
    try {
      writeFileSync(join(home, 'config.yaml'),
        `collector:\n  endpoint: "${sink.url}"\n`, 'utf-8');
      armSession(home, 'sess-armed', home);

      assert.equal(sink.requestCount(), 0, 'sanity: sink starts empty');

      const armedOut = await runHookAsync(home, {
        hook_event_name: 'post_tool_call',
        tool_name: 'terminal',
        tool_input: { command: 'ls' },
        session_id: 'sess-armed',
        cwd: home,
        extra: { tool_call_id: 'call-armed', result: 'ok' },
      });
      assert.equal(armedOut.trim(), '{}');
      const afterArmed = sink.requestCount();
      assert.ok(afterArmed > 0,
        `armed session should have exported at least one OTLP request, got ${afterArmed}`);

      const unarmedOut = await runHookAsync(home, {
        hook_event_name: 'post_tool_call',
        tool_name: 'terminal',
        tool_input: { command: 'ls' },
        session_id: 'sess-unarmed',
        cwd: home,
        extra: { tool_call_id: 'call-unarmed', result: 'ok' },
      });
      assert.equal(unarmedOut.trim(), '{}');
      assert.equal(sink.requestCount(), afterArmed,
        'unarmed session must add zero requests to the sink');
    } finally {
      await sink.close();
    }
  });
});
