// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * guard-hook.ts's session monitor gate — the highest-traffic gate in the
 * product and, until this file, the only one with no regression cover.
 *
 * guard-hook is registered on **both** PreToolUse and PostToolUse for
 * Claude Code and Codex, so its `isSessionMonitored(...)` call runs on
 * every single tool call a user makes. Deleting it (mutating the call to
 * `true || isSessionMonitored(...)`) turned the whole suite green —
 * 1474/1474 — while a brand-new NIO_HOME that had never been armed
 * POSTed nine requests to the configured OTLP endpoint for one tool call:
 * eight `/v1/metrics` plus one `/v1/logs` carrying the guard decision
 * audit record — tool name, command summary, risk level, risk tags and
 * risk score. The four sibling entry points (collector-hook, scanner-hook,
 * hook-cli, openclaw-plugin) each had 2-4 cases fail under the same
 * mutation. This one had none.
 *
 * The discriminating assertion is the sink request count, and only that.
 * Exit code, stderr and the local audit log are byte-identical armed or
 * not — they are asserted here to pin the gate's two invariants, not to
 * detect a leak:
 *
 *   1. Enforcement is orthogonal to capture. An unarmed session still
 *      gets `rm -rf /` denied, exit 2, reason on stderr.
 *   2. The local audit log is always written. The gate nulls the OTLP
 *      LoggerProvider; it must not touch ~/.nio/audit.jsonl.
 *
 * Structured after monitor-scanner-hook.test.ts, including its async
 * spawn: the sink lives in *this* process, so a synchronous spawn would
 * block the event loop and never service the child's connection.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { trackTempDir } from './helpers/tmp-dirs.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(
  HERE, '..', '..', 'plugins', 'claude-code', 'skills', 'nio', 'scripts', 'guard-hook.js',
);

/**
 * Bounded, like every other subprocess test here — this suite has a
 * history of CI hangs from an unbounded spawn (see monitor-e2e.test.ts's
 * note on the exit-on-flush guarantee).
 */
const HOOK_TIMEOUT_MS = 45000;

interface Sink {
  url: string;
  requestCount: () => number;
  paths: () => string[];
  close: () => Promise<void>;
}

function startSink(): Promise<Sink> {
  return new Promise((resolve, reject) => {
    const seen: string[] = [];
    const server: Server = createServer((req, res) => {
      seen.push(req.url ?? '');
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
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
        requestCount: () => seen.length,
        paths: () => [...seen],
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

/** A fresh NIO_HOME whose config points telemetry at `sinkUrl`. */
function nioHomeFor(sinkUrl: string): string {
  const home = trackTempDir(realpathSync(trackTempDir(mkdtempSync(join(tmpdir(), 'nio-guard-gate-')))));
  writeFileSync(join(home, 'config.yaml'), `collector:\n  endpoint: "${sinkUrl}"\n`, 'utf-8');
  return home;
}

/** Arm a session in the store, mirroring what `monitor-cli on` persists. */
function armSession(nioHome: string, sessionId: string): void {
  writeFileSync(
    join(nioHome, 'monitored-sessions.json'),
    JSON.stringify({ sessions: { [sessionId]: { armed_at: Date.now(), cwd: nioHome } } }),
    'utf-8',
  );
}

function runGuardHook(
  nioHome: string,
  payload: unknown,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI, '--platform', 'claude-code'], {
      env: { ...process.env, NIO_HOME: nioHome },
      cwd: nioHome,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`guard-hook timed out after ${HOOK_TIMEOUT_MS}ms; stderr: ${stderr}`));
    }, HOOK_TIMEOUT_MS);
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
      resolve({ code, stdout, stderr });
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

function auditEvents(nioHome: string): Array<Record<string, unknown>> {
  const p = join(nioHome, 'audit.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function preToolUse(sessionId: string, cwd: string, command: string): unknown {
  return {
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    cwd,
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: 'toolu_guard_gate_1',
  };
}

function postToolUse(sessionId: string, cwd: string, command: string): unknown {
  return {
    hook_event_name: 'PostToolUse',
    session_id: sessionId,
    cwd,
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: 'toolu_guard_gate_1',
    tool_response: { stdout: 'hi\n' },
  };
}

describe('guard-hook session monitor gate', () => {
  it('exports nothing for an unarmed session, on both PreToolUse and PostToolUse', async () => {
    const sink = await startSink();
    try {
      const home = nioHomeFor(sink.url);
      assert.equal(sink.requestCount(), 0, 'sanity: sink starts empty');

      const pre = await runGuardHook(home, preToolUse('sess-guard-unarmed', home, 'echo hi'));
      assert.equal(pre.code, 0, `an allowed call must exit 0; stderr: ${pre.stderr}`);

      const post = await runGuardHook(home, postToolUse('sess-guard-unarmed', home, 'echo hi'));
      assert.equal(post.code, 0, `PostToolUse must exit 0; stderr: ${post.stderr}`);

      // Invariant 2 — and the sanity check that makes the count below
      // mean something: the hook did run and did evaluate the call.
      assert.ok(
        auditEvents(home).length > 0,
        'the local audit log must be written for an unarmed session — otherwise the ' +
        'zero-request assertion below only proves the hook did nothing at all',
      );

      assert.equal(
        sink.requestCount(), 0,
        'an unarmed session must POST nothing to the OTLP endpoint; got ' +
        JSON.stringify(sink.paths()),
      );
    } finally {
      await sink.close();
    }
  });

  it('exports for an armed session — the contrast that gives the zero its meaning', async () => {
    const sink = await startSink();
    try {
      const home = nioHomeFor(sink.url);
      armSession(home, 'sess-guard-armed');

      const pre = await runGuardHook(home, preToolUse('sess-guard-armed', home, 'echo hi'));
      assert.equal(pre.code, 0, `an allowed call must exit 0; stderr: ${pre.stderr}`);

      assert.ok(
        sink.requestCount() > 0,
        'an armed session must export its guard telemetry; got 0 requests',
      );
    } finally {
      await sink.close();
    }
  });

  it('still denies a dangerous command while unarmed, and still exports nothing', async () => {
    // Invariant 1: enforcement is orthogonal to capture. evaluateHook
    // runs outside the gate, so an unmonitored session is protected just
    // the same — while the decision record stays on this machine.
    const sink = await startSink();
    try {
      const home = nioHomeFor(sink.url);

      const r = await runGuardHook(home, preToolUse('sess-guard-deny', home, 'rm -rf /'));
      assert.equal(r.code, 2, 'guard must deny `rm -rf /` regardless of monitor state');
      assert.ok(r.stderr.trim().length > 0, 'a deny must carry a reason on stderr');

      assert.ok(
        auditEvents(home).length > 0,
        'the deny decision must still be recorded locally',
      );
      assert.equal(
        sink.requestCount(), 0,
        'the guard decision audit record — tool name, command summary, risk level, risk ' +
        'tags, risk score — must not leave an unarmed machine; got ' +
        JSON.stringify(sink.paths()),
      );
    } finally {
      await sink.close();
    }
  });

  it('exports the deny path for an armed session', async () => {
    const sink = await startSink();
    try {
      const home = nioHomeFor(sink.url);
      armSession(home, 'sess-guard-deny-armed');

      const r = await runGuardHook(home, preToolUse('sess-guard-deny-armed', home, 'rm -rf /'));
      assert.equal(r.code, 2, 'guard must still deny');
      assert.ok(
        sink.requestCount() > 0,
        'an armed session must export the blocked call; got 0 requests',
      );
    } finally {
      await sink.close();
    }
  });
});
