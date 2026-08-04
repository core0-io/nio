// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Bundled by bun into plugins/claude-code/skills/nio/scripts/, not
// dist/scripts/ — see hook-cli.test.ts for the same resolution.
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..', '..', 'plugins', 'claude-code', 'skills', 'nio', 'scripts');
const COLLECTOR = join(SCRIPTS, 'collector-hook.js');
const MONITOR = join(SCRIPTS, 'monitor-cli.js');

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'nio-monitor-e2e-'));
  // Point at a closed port: if the gate leaks, the exporter will try to
  // reach it and we can detect the attempt via diagnostics.
  writeFileSync(join(home, 'config.yaml'),
    'collector:\n  endpoint: "http://127.0.0.1:19999"\n', 'utf-8');
  return home;
}

function fireHook(home: string, payload: unknown): void {
  execFileSync('node', [COLLECTOR, '--platform', 'claude-code'], {
    env: { ...process.env, NIO_HOME: home },
    input: JSON.stringify(payload),
    encoding: 'utf-8',
  });
}

function preToolUse(sessionId: string, cwd: string): unknown {
  return {
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    cwd,
    tool_name: 'Bash',
    tool_input: { command: 'echo hi' },
    tool_use_id: 'toolu_e2e_1',
  };
}

describe('monitor gate end-to-end', () => {
  it('writes local audit but no trace state when unmonitored', () => {
    const home = freshHome();
    fireHook(home, preToolUse('sess-e2e-off', home));

    assert.equal(existsSync(join(home, 'audit.jsonl')), true,
      'local audit log must be written even when unmonitored');
    assert.equal(existsSync(join(home, 'traces-state-store.json')), false,
      'no tracer provider means no pending span state');
  });

  it('creates trace state once the session is armed', () => {
    const home = freshHome();
    execFileSync('node', [MONITOR, 'on'], {
      env: { ...process.env, NIO_HOME: home, CLAUDE_CODE_SESSION_ID: 'sess-e2e-on' },
      cwd: home,
      encoding: 'utf-8',
    });

    fireHook(home, preToolUse('sess-e2e-on', home));

    assert.equal(existsSync(join(home, 'traces-state-store.json')), true,
      'armed session must open a pending span');
    const state = JSON.parse(
      readFileSync(join(home, 'traces-state-store.json'), 'utf-8'),
    ) as { session_id: string; pending_spans: Record<string, unknown> };
    assert.equal(state.session_id, 'sess-e2e-on');
    assert.equal('toolu_e2e_1' in state.pending_spans, true);
  });

  it('stops creating trace state after off', () => {
    const home = freshHome();
    const env = { ...process.env, NIO_HOME: home, CLAUDE_CODE_SESSION_ID: 'sess-e2e-toggle' };
    execFileSync('node', [MONITOR, 'on'], { env, cwd: home, encoding: 'utf-8' });
    execFileSync('node', [MONITOR, 'off'], { env, cwd: home, encoding: 'utf-8' });

    fireHook(home, preToolUse('sess-e2e-toggle', home));
    assert.equal(existsSync(join(home, 'traces-state-store.json')), false);
  });

  it('monitor_all_sessions captures without arming', () => {
    const home = mkdtempSync(join(tmpdir(), 'nio-monitor-e2e-all-'));
    writeFileSync(join(home, 'config.yaml'),
      'collector:\n  endpoint: "http://127.0.0.1:19999"\n  monitor_all_sessions: true\n',
      'utf-8');

    fireHook(home, preToolUse('sess-e2e-all', home));
    assert.equal(existsSync(join(home, 'traces-state-store.json')), true);
  });
});
