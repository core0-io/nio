// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * The capture gate at the Hermes entry point, driven through the bundled
 * `hook-cli.js` exactly as Hermes's shell hooks invoke it.
 *
 * Hermes is the only platform whose guard and collector paths both live
 * in one script, and the only one whose `session_id` can arrive as the
 * empty string, so its gate wiring is not covered by the Claude Code
 * end-to-end file.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';
import { trackTempDir } from './helpers/tmp-dirs.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..', '..', 'plugins', 'claude-code', 'skills', 'nio', 'scripts');
const HOOK_CLI = join(SCRIPTS, 'hook-cli.js');
const COLLECTOR = join(SCRIPTS, 'collector-hook.js');

const STATE_FILE = 'traces-state-store.json';
const STORE_FILE = 'monitored-sessions.json';

// Bounded so a regression that makes the CLI block cannot hang CI.
const RUN_TIMEOUT_MS = 30000;

interface RunResult { stdout: string; code: number | null }

function run(bin: string, args: string[], home: string, stdin: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [bin, ...args], {
      env: { ...process.env, NIO_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`${bin} timed out after ${RUN_TIMEOUT_MS}ms`));
    }, RUN_TIMEOUT_MS);
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', () => { /* diagnostics are not under test here */ });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ stdout, code }); });
    proc.stdin.write(stdin);
    proc.stdin.end();
  });
}

/**
 * A local OTLP sink that answers 200 to everything.
 *
 * Required, not a convenience, for any case that ARMS a session: with a
 * provider built, `hook-cli.js` ends in `forceFlush()`, and against an
 * unreachable endpoint the metric reader's retry timer keeps the event
 * loop alive well past it (the bounded flush that fixes this is not part
 * of this change). The unmonitored cases deliberately keep a closed port
 * instead — there a leaked exporter would hang and fail the test, which
 * is exactly the signal they want.
 */
function startSink(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      req.on('data', () => { /* drain */ });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
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
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

function freshHome(endpoint: string, extraYaml = ''): string {
  const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-monitor-hermes-')));
  writeFileSync(join(home, 'config.yaml'),
    `collector:\n  endpoint: "${endpoint}"\n${extraYaml}`, 'utf-8');
  return home;
}

/** A home whose endpoint is a closed port — for the cases that must export nothing. */
const CLOSED_PORT = 'http://127.0.0.1:19999';

/** Arm a session the same way `/nio monitor on` does, by writing the store. */
function arm(home: string, sessionId: string): void {
  writeFileSync(
    join(home, STORE_FILE),
    JSON.stringify({ sessions: { [sessionId]: { armed_at: Date.now(), cwd: home } } }),
    'utf-8',
  );
}

function armedSessions(home: string): string[] {
  if (!existsSync(join(home, STORE_FILE))) return [];
  const raw = JSON.parse(readFileSync(join(home, STORE_FILE), 'utf-8')) as {
    sessions: Record<string, unknown>;
  };
  return Object.keys(raw.sessions);
}

function auditRows(home: string): Array<Record<string, unknown>> {
  const path = join(home, 'audit.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l) as Record<string, unknown>);
}

function preToolCall(sessionId: string, command: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    hook_event_name: 'pre_tool_call',
    tool_name: 'terminal',
    tool_input: { command },
    session_id: sessionId,
    cwd: '/tmp',
    extra,
  });
}

describe('monitor gate — Hermes guard path', () => {
  it('an unarmed session writes local audit, no trace state, and is still blocked', async () => {
    const home = freshHome(CLOSED_PORT);
    const { stdout, code } = await run(
      HOOK_CLI, ['--platform', 'hermes', '--stdin'], home,
      preToolCall('hermes-sess-off', 'rm -rf /'),
    );

    assert.equal(code, 0);
    assert.equal(JSON.parse(stdout).decision, 'block',
      'enforcement is orthogonal to capture — an unarmed session is still guarded');
    assert.ok(auditRows(home).length > 0,
      'local audit log must be written even when unmonitored');
    assert.equal(existsSync(join(home, STATE_FILE)), false,
      'no tracer provider means no pending span state');
  });

  it('an armed session opens the pending span', async () => {
    const sink = await startSink();
    try {
      const home = freshHome(sink.url);
      arm(home, 'hermes-sess-on');

      await run(
        HOOK_CLI, ['--platform', 'hermes', '--stdin'], home,
        preToolCall('hermes-sess-on', 'ls /tmp'),
      );

      assert.equal(existsSync(join(home, STATE_FILE)), true,
        'armed session must open a pending span');
    } finally {
      await sink.close();
    }
  });
});

describe('monitor gate — Hermes empty session_id', () => {
  it('recovers extra.parent_session_id when session_id is the empty string', async () => {
    // Hermes's `_serialize_payload` writes
    // `session_id or parent_session_id or ""`, so a call site with no
    // session sends `""` rather than omitting the key. Under `??` the
    // empty string counts as present and the parent recovery below is
    // unreachable — every tool invoked from inside the code-execution
    // sandbox would then be attributed to `""` instead of its parent.
    const sink = await startSink();
    try {
      const home = freshHome(sink.url);
      arm(home, 'hermes-parent');

      await run(
        HOOK_CLI, ['--platform', 'hermes', '--stdin'], home,
        preToolCall('', 'ls /tmp', { parent_session_id: 'hermes-parent' }),
      );

      // The hook-event row, not the guard row: only the former is built
      // from `hermesToCollectorInput`'s output.
      const row = auditRows(home).find(r => r['event'] === 'PreToolUse');
      assert.ok(row, 'sanity: the collector wrote a PreToolUse audit row');
      assert.equal(row!['session_id'], 'hermes-parent',
        'the audit row must carry the recovered parent session id, not ""');
      assert.equal(existsSync(join(home, STATE_FILE)), true,
        'and the recovered id must be the one the gate looked up');
    } finally {
      await sink.close();
    }
  });

  it('an unrecoverable empty session_id fails closed, even under monitor_all_sessions', async () => {
    // `''` is one of UNTRUSTED_SESSION_IDS, and that guard runs ahead of
    // the whole gate — including the global override. The local audit
    // entry is still written.
    const home = freshHome(CLOSED_PORT, '  monitor_all_sessions: true\n');

    await run(
      HOOK_CLI, ['--platform', 'hermes', '--stdin'], home,
      preToolCall('', 'ls /tmp'),
    );

    assert.ok(auditRows(home).length > 0);
    assert.equal(existsSync(join(home, STATE_FILE)), false,
      'an id-less event must never export, however permissive the config');
  });
});

describe('SessionEnd and the arm record', () => {
  it('Hermes keeps the arm record — its session_end is a turn boundary', async () => {
    // Hermes fires on_session_end at the end of every TURN. Disarming
    // there buys a single turn of capture and then goes silent, and
    // nothing re-creates the arm.
    const sink = await startSink();
    try {
      const home = freshHome(sink.url);
      arm(home, 'hermes-sess-end');

      await run(HOOK_CLI, ['--platform', 'hermes', '--stdin'], home, JSON.stringify({
        hook_event_name: 'on_session_end',
        session_id: 'hermes-sess-end',
        cwd: '/tmp',
        extra: {},
      }));

      assert.deepEqual(armedSessions(home), ['hermes-sess-end'],
        'a per-turn session_end must not disarm the session');
    } finally {
      await sink.close();
    }
  });

  it('Claude Code drops the arm record at SessionEnd', async () => {
    // The other side of `sessionEndDisarms`: a real teardown reaps the
    // record now instead of leaving it for the 7-day backstop.
    const sink = await startSink();
    try {
      const home = freshHome(sink.url);
      arm(home, 'cc-sess-end');

      await run(COLLECTOR, ['--platform', 'claude-code'], home, JSON.stringify({
        hook_event_name: 'SessionEnd',
        session_id: 'cc-sess-end',
        cwd: home,
      }));

      assert.deepEqual(armedSessions(home), [],
        'a real session end must drop the arm record');
    } finally {
      await sink.close();
    }
  });
});
