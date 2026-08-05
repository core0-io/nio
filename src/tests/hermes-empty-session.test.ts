// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Hermes sends `session_id: ""` — pin what we do about it.
 *
 * This is not a hypothetical shape. Read from the installed Hermes agent:
 *
 *   agent/shell_hooks.py::_serialize_payload
 *     "session_id": kwargs.get("session_id") or kwargs.get("parent_session_id") or ""
 *
 *   agent/model_tools.py::handle_function_call
 *     invoke_hook("pre_tool_call"/"post_tool_call", ..., session_id=session_id or "")
 *
 *   agent/tools/code_execution_tool.py (two call sites)
 *     handle_function_call(tool_name, tool_args, task_id=task_id)   # no session_id
 *
 * So every tool dispatched from inside Hermes's code-execution sandbox
 * reaches our hook with a top-level `session_id` of `""` — a *present*
 * empty string, never `undefined`.
 *
 * Two properties are pinned here:
 *
 * 1. Recovery. `hermesToCollectorInput` falls back to
 *    `extra.parent_session_id`. Under the old `??` that fallback was
 *    unreachable for `""` (nullish-coalescing treats `""` as present), so
 *    a recoverable id was thrown away. `||` matches Hermes's own `or`.
 *
 * 2. Fail-closed, and consistently so. With nothing to recover, the id
 *    stays `""`, which `UNTRUSTED_SESSION_IDS` rejects — no OTLP export
 *    even under `monitor_all_sessions: true`. That is the SAME outcome
 *    the other three platforms produce for their own id-less events
 *    (`'unknown'` on Claude Code / Codex, `'openclaw'` on OpenClaw): the
 *    set exists because a placeholder id shared by every id-less event
 *    would arm all of them globally for the arm's full TTL the moment one
 *    user armed one session. The local audit entry is still written, so
 *    the event is not lost — only its OTLP export is withheld.
 *
 * Both cases run against a real local OTLP sink, because "did telemetry
 * reach the wire" is the only assertion that can distinguish a working
 * gate from a deleted one.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { trackTempDir } from './helpers/tmp-dirs.js';

// Bundled by bun into plugins/claude-code/skills/nio/scripts/, not
// dist/scripts/ — same resolution as monitor-hermes.test.ts.
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(
  HERE, '..', '..', 'plugins', 'claude-code', 'skills', 'nio', 'scripts', 'hook-cli.js',
);

const HOOK_TIMEOUT_MS = 45000;

function freshHome(): string {
  return trackTempDir(mkdtempSync(join(tmpdir(), 'nio-hermes-empty-sess-')));
}

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

/**
 * spawn, not execFileSync: the child has to connect back to the sink
 * running on this process's event loop, and a sync spawn deadlocks that.
 * See monitor-hermes.test.ts for the full write-up.
 */
function runHookAsync(home: string, envelope: unknown): Promise<string> {
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
      reject(new Error(`hook-cli timed out after ${HOOK_TIMEOUT_MS}ms; stderr: ${err}`));
    }, HOOK_TIMEOUT_MS);
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
        reject(new Error(`hook-cli exited ${code}; stderr: ${err}`));
        return;
      }
      resolve(out);
    });
    child.stdin.write(JSON.stringify(envelope));
    child.stdin.end();
  });
}

function auditLines(home: string): Record<string, unknown>[] {
  const p = join(home, 'audit.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8').trim().split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function armSession(home: string, sessionId: string, cwd: string): void {
  writeFileSync(join(home, 'monitored-sessions.json'), JSON.stringify({
    sessions: { [sessionId]: { armed_at: Date.now(), cwd } },
  }), 'utf-8');
}

describe('hermes empty session_id', () => {
  it('recovers extra.parent_session_id when session_id is the empty string', async () => {
    const home = freshHome();
    const sink = await startSink();
    try {
      writeFileSync(join(home, 'config.yaml'),
        `collector:\n  endpoint: "${sink.url}"\n`, 'utf-8');
      // Only the PARENT id is armed. If the empty top-level session_id
      // wins, the gate sees '' → untrusted → nothing exports.
      armSession(home, 'sess-parent-armed', home);

      const out = await runHookAsync(home, {
        hook_event_name: 'post_tool_call',
        tool_name: 'terminal',
        tool_input: { command: 'ls' },
        session_id: '',
        cwd: home,
        extra: {
          tool_call_id: 'call-recovered',
          result: 'ok',
          parent_session_id: 'sess-parent-armed',
        },
      });
      assert.equal(out.trim(), '{}');

      const entries = auditLines(home);
      assert.ok(entries.length >= 1, 'expected at least one audit entry');
      assert.equal(
        entries[0]!['session_id'], 'sess-parent-armed',
        'the recovered parent id must be the identity carried on the event',
      );
      assert.ok(
        sink.requestCount() > 0,
        `a recovered-and-armed session must export OTLP, got ${sink.requestCount()} requests`,
      );
    } finally {
      await sink.close();
    }
  });

  it('fails closed on an unrecoverable empty session_id, even with monitor_all_sessions', async () => {
    const home = freshHome();
    const sink = await startSink();
    try {
      // monitor_all_sessions: true is the strongest possible "please
      // export" configuration. The untrusted-id guard runs BEFORE the
      // store is consulted, so it must still win here — that ordering is
      // what this case pins.
      writeFileSync(join(home, 'config.yaml'),
        `collector:\n  endpoint: "${sink.url}"\n  monitor_all_sessions: true\n`, 'utf-8');

      const out = await runHookAsync(home, {
        hook_event_name: 'post_tool_call',
        tool_name: 'terminal',
        tool_input: { command: 'ls' },
        session_id: '',
        cwd: home,
        extra: { tool_call_id: 'call-empty', result: 'ok' },
      });
      assert.equal(out.trim(), '{}');

      assert.equal(
        sink.requestCount(), 0,
        `an empty session_id must export nothing, got ${sink.requestCount()} requests`,
      );

      // …but the event is still recorded locally, so nothing is silently
      // dropped on the floor.
      const entries = auditLines(home);
      assert.ok(entries.length >= 1, 'local audit entry must still be written');
      assert.equal(entries[0]!['session_id'], '');
      assert.equal(entries[0]!['event'], 'PostToolUse');
    } finally {
      await sink.close();
    }
  });

  it('sanity: a control session with the same config DOES reach the sink', async () => {
    // Without this, the fail-closed case above could pass for the wrong
    // reason (sink unreachable, exporter disabled, config typo) — it only
    // asserts an absence. This proves the same home/config/endpoint does
    // export when the id is trustworthy, so the zero above is about the
    // id and nothing else.
    const home = freshHome();
    const sink = await startSink();
    try {
      writeFileSync(join(home, 'config.yaml'),
        `collector:\n  endpoint: "${sink.url}"\n  monitor_all_sessions: true\n`, 'utf-8');

      await runHookAsync(home, {
        hook_event_name: 'post_tool_call',
        tool_name: 'terminal',
        tool_input: { command: 'ls' },
        session_id: 'sess-real-id',
        cwd: home,
        extra: { tool_call_id: 'call-control', result: 'ok' },
      });

      assert.ok(
        sink.requestCount() > 0,
        `control session must export OTLP, got ${sink.requestCount()} requests`,
      );
    } finally {
      await sink.close();
    }
  });
});
