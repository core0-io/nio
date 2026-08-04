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
const CLI = join(
  HERE, '..', '..', 'plugins', 'claude-code', 'skills', 'nio', 'scripts', 'hook-cli.js',
);

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'nio-monitor-hermes-'));
}

function runHook(home: string, envelope: unknown): string {
  return execFileSync('node', [CLI, '--platform', 'hermes', '--stdin'], {
    env: { ...process.env, NIO_HOME: home },
    input: JSON.stringify(envelope),
    encoding: 'utf-8',
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
