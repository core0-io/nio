// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

// The fixture is hand-synthesised from the real transcript shape
// (verified against a live Claude Code session); it contains no real
// conversation data.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeCodeSource } from '../scripts/lib/conversation/claude-code-source.js';

// Test runs from dist/tests/, fixtures live in src/tests/fixtures/ and
// are not part of the compiled output. Resolve from project root so
// tests work regardless of compiled layout (mirrors adapter.test.ts).
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(TEST_DIR, '..', '..');
const FIXTURE = join(PROJECT_ROOT, 'src', 'tests', 'fixtures', 'conversation', 'claude-code-transcript.jsonl');
const MALFORMED_TYPES_FIXTURE = join(
  PROJECT_ROOT,
  'src',
  'tests',
  'fixtures',
  'conversation',
  'claude-code-malformed-lines.jsonl',
);

describe('claude-code source', () => {
  it('yields one call per assistant entry', () => {
    const calls = createClaudeCodeSource(FIXTURE).callsSince(0);
    assert.ok(calls.length >= 3, `expected at least 3 calls, got ${calls.length}`);
  });

  it('preserves block order within a call', () => {
    const calls = createClaudeCodeSource(FIXTURE).callsSince(0);
    const withAll = calls.find((c) => c.blocks.length >= 3);
    assert.ok(withAll, 'fixture must contain a call with thinking+text+tool_use');
    assert.deepEqual(withAll!.blocks.map((b) => b.type), ['thinking', 'text', 'tool_use']);
    assert.deepEqual(withAll!.blocks.map((b) => b.index), [0, 1, 2]);
  });

  it('marks thinking as full fidelity', () => {
    const calls = createClaudeCodeSource(FIXTURE).callsSince(0);
    const thinking = calls.flatMap((c) => c.blocks).filter((b) => b.type === 'thinking');
    assert.ok(thinking.length > 0, 'fixture must contain thinking');
    for (const b of thinking) assert.equal(b.fidelity, 'full');
  });

  it('carries tool_use id and name', () => {
    const calls = createClaudeCodeSource(FIXTURE).callsSince(0);
    const tu = calls.flatMap((c) => c.blocks).find((b) => b.type === 'tool_use');
    assert.ok(tu?.toolUse, 'tool_use block must carry toolUse detail');
    assert.ok(tu!.toolUse!.id.length > 0);
    assert.ok(tu!.toolUse!.name.length > 0);
  });

  it('flags sidechain calls', () => {
    const calls = createClaudeCodeSource(FIXTURE).callsSince(0);
    assert.ok(calls.some((c) => c.isSidechain), 'fixture must contain a sidechain call');
    assert.ok(calls.some((c) => !c.isSidechain));
  });

  it('filters by sinceMs', () => {
    const all = createClaudeCodeSource(FIXTURE).callsSince(0);
    assert.ok(all.length >= 2);
    const cutoff = all[all.length - 1].startMs;
    const late = createClaudeCodeSource(FIXTURE).callsSince(cutoff);
    assert.ok(late.length < all.length, 'sinceMs must actually filter');
    assert.ok(late.every((c) => c.startMs >= cutoff));
  });

  it('survives a malformed line and a missing usage field', () => {
    // The fixture contains both; parsing must not throw and must not
    // drop the well-formed entries around them.
    const calls = createClaudeCodeSource(FIXTURE).callsSince(0);
    assert.ok(calls.length >= 3);
  });

  it('returns an empty array for a nonexistent file', () => {
    const src = createClaudeCodeSource('/nonexistent/nope.jsonl');
    assert.deepEqual(src.callsSince(0), []);
  });

  it('does not throw on a bare null/array/string/number line and still parses the entries around them', () => {
    // JSON.parse succeeds for `null`, `[1,2,3]`, `"str"`, and `42` — the
    // try/catch around JSON.parse cannot catch these, only an explicit
    // `!entry || typeof entry !== 'object'` guard does. Regression for
    // the "null line aborts callsSince entirely" bug.
    const calls = createClaudeCodeSource(MALFORMED_TYPES_FIXTURE).callsSince(0);
    assert.equal(calls.length, 5, 'all five well-formed assistant entries must survive');
    assert.deepEqual(
      calls.map((c) => c.callId),
      ['req_ml_a', 'req_ml_b', 'req_ml_c', 'req_ml_d', 'req_ml_e'],
      'every entry around the malformed-type lines must still parse, in order, none dropped',
    );
  });
});
