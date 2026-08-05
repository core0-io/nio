// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

// The fixture is hand-synthesised from the real rollout shape (verified
// against a live Codex CLI session); it contains no real conversation
// data.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexSource } from '../scripts/lib/conversation/codex-source.js';

// Test runs from dist/tests/, fixtures live in src/tests/fixtures/ and
// are not part of the compiled output. Resolve from project root so
// tests work regardless of compiled layout (mirrors adapter.test.ts).
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(TEST_DIR, '..', '..');
const FIXTURE = join(PROJECT_ROOT, 'src', 'tests', 'fixtures', 'conversation', 'codex-rollout.jsonl');
const MALFORMED_TYPES_FIXTURE = join(
  PROJECT_ROOT,
  'src',
  'tests',
  'fixtures',
  'conversation',
  'codex-malformed-lines.jsonl',
);

// Fixture contains exactly two `reasoning` entries (rs_001, rs_002).
// The trailing assistant message attaches to rs_002's already-open
// call rather than opening a third, so the call count equals the
// reasoning-entry count here.
const REASONING_ENTRY_COUNT = 2;

describe('codex source', () => {
  it('splits calls on reasoning-entry boundaries', () => {
    const calls = createCodexSource(FIXTURE).callsSince(0);
    assert.equal(calls.length, REASONING_ENTRY_COUNT);
  });

  it('marks all thinking blocks as summary fidelity', () => {
    const calls = createCodexSource(FIXTURE).callsSince(0);
    const thinking = calls.flatMap((c) => c.blocks).filter((b) => b.type === 'thinking');
    assert.ok(thinking.length > 0, 'fixture must contain thinking blocks');
    for (const b of thinking) assert.equal(b.fidelity, 'summary');
  });

  it('produces no thinking block for a reasoning entry with an empty summary', () => {
    const calls = createCodexSource(FIXTURE).callsSince(0);
    // rs_002 has summary: [] and is followed only by the assistant
    // message — its call must carry a text block but no thinking block.
    const emptySummaryCall = calls.find((c) => c.blocks.some((b) => b.type === 'text'));
    assert.ok(emptySummaryCall, 'fixture must contain the call closed by the assistant message');
    assert.ok(
      !emptySummaryCall!.blocks.some((b) => b.type === 'thinking'),
      'a reasoning entry with summary: [] must not produce a thinking block',
    );
  });

  it('maps function_call to a tool_use block carrying call_id and name', () => {
    const calls = createCodexSource(FIXTURE).callsSince(0);
    const tu = calls.flatMap((c) => c.blocks).find((b) => b.type === 'tool_use');
    assert.ok(tu?.toolUse, 'fixture must contain a function_call mapped to tool_use');
    assert.equal(tu!.toolUse!.name, 'exec_command');
    assert.equal(tu!.toolUse!.id, 'call_001');
  });

  it('fills timeToFirstTokenMs from task_complete', () => {
    const calls = createCodexSource(FIXTURE).callsSince(0);
    assert.ok(
      calls.some((c) => c.timeToFirstTokenMs === 650),
      'task_complete.time_to_first_token_ms must land on a call',
    );
  });

  it('fills usage.reasoning from token_count', () => {
    const calls = createCodexSource(FIXTURE).callsSince(0);
    assert.ok(
      calls.some((c) => c.usage?.reasoning === 40),
      'token_count reasoning tokens must land on a call',
    );
  });

  it('maps all of last_token_usage, not just reasoning_output_tokens', () => {
    // codex-rs's TokenUsage struct (verified against a live Codex CLI
    // session) carries input_tokens/output_tokens/cached_input_tokens/
    // cache_write_input_tokens/reasoning_output_tokens/total_tokens.
    // Only reasoning used to be mapped, leaving input/output/cache
    // token attributes empty on every Codex chat span.
    const calls = createCodexSource(FIXTURE).callsSince(0);
    const withUsage = calls.find((c) => c.usage?.reasoning === 40);
    assert.ok(withUsage, 'fixture must contain the call closed by token_count');
    assert.deepEqual(withUsage!.usage, {
      input: 500,
      output: 80,
      cacheRead: 100,
      cacheWrite: 15,
      reasoning: 40,
    });
  });

  it('marks timing as exact (task_complete carries real start/end)', () => {
    const calls = createCodexSource(FIXTURE).callsSince(0);
    assert.ok(calls.length > 0);
    for (const c of calls) assert.equal(c.timing, 'exact');
  });

  it('takes model from turn_context', () => {
    const calls = createCodexSource(FIXTURE).callsSince(0);
    assert.ok(calls.length > 0);
    for (const c of calls) assert.equal(c.model, 'gpt-5-codex');
  });

  it('skips developer and user messages', () => {
    const calls = createCodexSource(FIXTURE).callsSince(0);
    const texts = calls.flatMap((c) => c.blocks).filter((b) => b.type === 'text');
    assert.ok(
      texts.every((b) => !b.content.includes('developer instructions') && !b.content.includes('user message')),
      'developer/user input must not surface as a text block',
    );
  });

  it('survives a malformed trailing line', () => {
    const calls = createCodexSource(FIXTURE).callsSince(0);
    assert.equal(calls.length, REASONING_ENTRY_COUNT);
  });

  it('returns an empty array for a nonexistent file', () => {
    const src = createCodexSource('/nonexistent/nope.jsonl');
    assert.deepEqual(src.callsSince(0), []);
  });

  it('does not throw on a bare null/array/string/number line and still parses the entries around them', () => {
    // JSON.parse succeeds for `null`, `[1,2,3]`, `"str"`, and `42` — the
    // try/catch around JSON.parse cannot catch these, only an explicit
    // `!entry || typeof entry !== 'object'` guard does. Regression for
    // the "null line aborts callsSince entirely" bug. Fixture interleaves
    // one of each malformed type between two reasoning-opened calls plus
    // their function_call/message closers.
    const calls = createCodexSource(MALFORMED_TYPES_FIXTURE).callsSince(0);
    assert.equal(calls.length, 2, 'both reasoning-opened calls must survive the malformed-type lines');
    const toolNames = calls.flatMap((c) => c.blocks.filter((b) => b.type === 'tool_use').map((b) => b.toolUse!.name));
    assert.deepEqual(toolNames, ['exec_command', 'exec_command'], 'function_call entries around the malformed lines must still attach');
    const text = calls.flatMap((c) => c.blocks).find((b) => b.type === 'text');
    assert.equal(text?.content, 'final reply placeholder', 'trailing assistant message must still close the last call');
  });
});
