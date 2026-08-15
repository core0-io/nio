// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `dumpPayload()` — the debug-only NIO_DUMP_PAYLOAD switch.
 *
 * Three properties matter enough to pin directly:
 *   1. Unset env var → zero files written (not just "the current test's
 *      file is missing" — the whole directory must stay empty).
 *   2. Set env var → a file lands with the *exact* input payload,
 *      unmodified (no redaction, no truncation — that's the whole point).
 *   3. An unwritable target directory must never throw — this is a
 *      sampling tool bolted onto hot hook paths, and a dump failure must
 *      never surface as a hook crash.
 */

import { describe, it, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir, platform as osPlatform } from 'node:os';
import { join } from 'node:path';
import { dumpPayload } from '../scripts/lib/payload-dump.js';
import { trackTempDir } from './helpers/tmp-dirs.js';

const ENV_VAR = 'NIO_DUMP_PAYLOAD';
let prevEnv: string | undefined;
const cleanupDirs: string[] = [];

beforeEach(() => {
  prevEnv = process.env[ENV_VAR];
  delete process.env[ENV_VAR];
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = prevEnv;
});

after(() => {
  for (const d of cleanupDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function freshDir(prefix: string): string {
  const dir = trackTempDir(mkdtempSync(join(tmpdir(), prefix)));
  cleanupDirs.push(dir);
  return dir;
}

function filesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
}

describe('dumpPayload: env var unset', () => {
  it('writes no file at all when NIO_DUMP_PAYLOAD is unset', () => {
    const dir = freshDir('nio-dump-unset-');
    // Deliberately do NOT set process.env[ENV_VAR] here.
    dumpPayload('claude-code', 'PreToolUse', { tool_name: 'Bash', command: 'ls' });
    assert.deepEqual(filesIn(dir), [], 'no file should exist — dumpPayload never even looked at this dir');
  });
});

describe('dumpPayload: env var set', () => {
  it('writes a file containing the exact input payload', () => {
    const dir = freshDir('nio-dump-set-');
    process.env[ENV_VAR] = dir;

    const payload = {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-123',
      tool_name: 'Bash',
      tool_input: { command: 'echo hi', nested: { a: [1, 2, 3], b: null } },
      reasoning: 'some internal thinking content we are researching',
    };
    dumpPayload('claude-code', 'PreToolUse', payload);

    const files = filesIn(dir);
    assert.equal(files.length, 1, `expected exactly one dump file, got: ${files.join(', ')}`);
    assert.match(files[0]!, /^\d+-claude-code-PreToolUse-[0-9a-f]{6}\.json$/);

    const written = JSON.parse(readFileSync(join(dir, files[0]!), 'utf-8'));
    assert.deepEqual(written, payload, 'dump content must match the input payload verbatim — no redaction/truncation');
  });

  it('names files with platform and event so multiple hooks are distinguishable', () => {
    const dir = freshDir('nio-dump-names-');
    process.env[ENV_VAR] = dir;

    dumpPayload('hermes', 'pre_tool_call', { a: 1 });
    dumpPayload('openclaw', 'llm_output', { b: 2 });

    const files = filesIn(dir).sort();
    assert.equal(files.length, 2);
    assert.ok(files.some((f) => f.includes('-hermes-pre_tool_call-')));
    assert.ok(files.some((f) => f.includes('-openclaw-llm_output-')));
  });

  it('does not collide when called twice in immediate succession with identical platform/event', () => {
    const dir = freshDir('nio-dump-collision-');
    process.env[ENV_VAR] = dir;

    dumpPayload('claude-code', 'PreToolUse', { call: 1 });
    dumpPayload('claude-code', 'PreToolUse', { call: 2 });

    const files = filesIn(dir);
    assert.equal(files.length, 2, 'both dumps must land as separate files, mirroring guard-hook + collector-hook firing on the same PreToolUse event');
    const contents = files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8')).call).sort();
    assert.deepEqual(contents, [1, 2]);
  });
});

describe('dumpPayload: failure handling', () => {
  it('does not throw when the target directory does not exist', () => {
    const missing = join(tmpdir(), 'nio-dump-does-not-exist-' + Date.now());
    process.env[ENV_VAR] = missing;
    assert.doesNotThrow(() => dumpPayload('claude-code', 'PreToolUse', { x: 1 }));
    assert.equal(existsSync(missing), false, 'dumpPayload must not create the directory either');
  });

  it('does not throw when the target directory is unwritable', { skip: osPlatform() === 'win32' ? 'chmod semantics differ on Windows' : false }, () => {
    const dir = freshDir('nio-dump-readonly-');
    process.env[ENV_VAR] = dir;
    chmodSync(dir, 0o500); // read + execute, no write
    try {
      assert.doesNotThrow(() => dumpPayload('claude-code', 'PreToolUse', { x: 1 }));
      assert.deepEqual(filesIn(dir), [], 'write should have failed silently, so no file lands');
    } finally {
      // Restore write permission so the outer cleanup (after hook) can rmSync it.
      chmodSync(dir, 0o700);
    }
  });

  it('does not throw on a non-JSON-serialisable payload (circular reference)', () => {
    const dir = freshDir('nio-dump-circular-');
    process.env[ENV_VAR] = dir;
    const circular: Record<string, unknown> = { a: 1 };
    circular['self'] = circular;
    assert.doesNotThrow(() => dumpPayload('claude-code', 'PreToolUse', circular));
    assert.deepEqual(filesIn(dir), [], 'a payload that fails to serialise must not leave a partial/corrupt file');
  });
});
