// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

// The fixtures are hand-synthesised from the format documented in the
// installed `@earendil-works/pi-coding-agent` 0.83.0
// `docs/session-format.md`; they contain no real conversation data and
// no path under the developer's `~/.pi`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPiSource } from '../scripts/lib/conversation/pi-source.js';
import { blockOrderIsSane } from '../scripts/lib/conversation/types.js';

// Test runs from dist/tests/; fixtures live in src/tests/fixtures/pi/ and
// are never copied into dist/ (tsc only emits .ts sources). Resolve from
// the project root rather than from the compiled layout — same convention
// as adapter.test.ts and conversation-codex.test.ts.
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(TEST_DIR, '..', '..');
const PI_FIXTURES = join(PROJECT_ROOT, 'src', 'tests', 'fixtures', 'pi');
const FIXTURE = join(PI_FIXTURES, 'session.jsonl');
const MALFORMED_FIXTURE = join(PI_FIXTURES, 'session-malformed-lines.jsonl');
const OPENAI_FIXTURE = join(PI_FIXTURES, 'session-openai.jsonl');

// session.jsonl holds exactly two assistant entries (m2, m4). The user
// entry (m1) and the toolResult entry (m3) must not produce calls.
const ASSISTANT_ENTRY_COUNT = 2;
const M2_START_MS = 1785060002000;
const M4_START_MS = 1785060004000;

describe('pi-source', () => {
  it('yields one call per assistant message', () => {
    const calls = createPiSource(FIXTURE).callsSince(0);
    assert.equal(calls.length, ASSISTANT_ENTRY_COUNT);
  });

  it('preserves block order and types within a call', () => {
    const [first] = createPiSource(FIXTURE).callsSince(0);
    assert.deepEqual(
      first.blocks.map((b) => b.type),
      ['thinking', 'text', 'tool_use'],
    );
    assert.ok(blockOrderIsSane(first));
  });

  it('carries the thinking text verbatim from the `thinking` field', () => {
    const [first] = createPiSource(FIXTURE).callsSince(0);
    assert.equal(first.blocks[0].content, 'I should list them.');
  });

  // Fidelity follows the provider on the message, not the platform.
  it('marks an Anthropic-provider call as full fidelity', () => {
    const [first] = createPiSource(FIXTURE).callsSince(0);
    assert.equal(first.blocks[0].fidelity, 'full');
  });

  // The other half of the same wiring: a Pi session configured against a
  // non-Anthropic provider must NOT be labelled 'full'. Pinning only the
  // Anthropic direction leaves a hard-coded `'full'` undetected.
  it('marks a non-Anthropic-provider call as summary fidelity', () => {
    const [only] = createPiSource(OPENAI_FIXTURE).callsSince(0);
    assert.equal(only.blocks[0].type, 'thinking');
    assert.equal(only.blocks[0].fidelity, 'summary');
  });

  it('extracts the tool call id, name and serialised arguments', () => {
    const [first] = createPiSource(FIXTURE).callsSince(0);
    const tool = first.blocks.find((b) => b.type === 'tool_use');
    assert.equal(tool?.toolUse?.id, 'call_1');
    assert.equal(tool?.toolUse?.name, 'bash');
    assert.equal(tool?.toolUse?.input, JSON.stringify({ command: 'ls' }));
  });

  it('reads usage, model and stop reason', () => {
    const [first] = createPiSource(FIXTURE).callsSince(0);
    assert.deepEqual(first.usage, { input: 10, output: 20, cacheRead: 5, cacheWrite: 2 });
    assert.equal(first.model, 'claude-sonnet-4-5');
    assert.equal(first.stopReason, 'toolUse');
  });

  // Pi puts the record id on the ENTRY (`{"type":"message","id":"m2",…}`),
  // not inside `message`. Callers on a streaming source deduplicate on
  // callId (see ConversationSource docs); falling back to the ordinal
  // would hand out a different id for the same call once the file is
  // compacted or tail-read, so the real id must win.
  it('uses the entry id as the call id, not a synthesised ordinal', () => {
    const calls = createPiSource(FIXTURE).callsSince(0);
    assert.deepEqual(
      calls.map((c) => c.callId),
      ['m2', 'm4'],
    );
  });

  // Pi stamps every message with a real Unix-ms timestamp, so start is
  // genuine and end is derived from the next message — 'inferred', never
  // 'synthetic'. buildSpanTree only enables its time-window attribution
  // channel when timing !== 'synthetic', so this value is load-bearing.
  it('reports inferred timing from the real per-message timestamps', () => {
    const [first] = createPiSource(FIXTURE).callsSince(0);
    assert.equal(first.timing, 'inferred');
    assert.equal(first.startMs, M2_START_MS);
    assert.equal(
      first.endMs,
      M4_START_MS,
      'end must be derived from the following assistant message',
    );
    assert.ok(first.endMs > first.startMs, 'end must be derived from the following message');
  });

  // The last call has nothing after it to bound it, so it degrades to a
  // zero-length span rather than inventing a duration.
  it('collapses the final call to a zero-length span', () => {
    const calls = createPiSource(FIXTURE).callsSince(0);
    const last = calls[calls.length - 1];
    assert.equal(last.startMs, M4_START_MS);
    assert.equal(last.endMs, M4_START_MS);
  });

  it('filters by sinceMs — a real filter on the replay family', () => {
    const calls = createPiSource(FIXTURE).callsSince(1785060003000);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].stopReason, 'stop');
  });

  it('returns an empty array, never throwing, for a missing file', () => {
    assert.deepEqual(createPiSource('/nonexistent/session.jsonl').callsSince(0), []);
  });

  it('does not throw on bare null/array/string/number lines and keeps the calls around them', () => {
    // JSON.parse succeeds for `null`, `[1,2,3]`, `"str"` and `42` — the
    // try/catch around JSON.parse cannot catch those, only an explicit
    // `!entry || typeof entry !== 'object'` guard does. `JSON.parse('null')`
    // returning null WITHOUT throwing is the exact shape that crashed an
    // earlier source. The fixture interleaves one of each between the two
    // assistant entries, plus a truncated trailing line.
    const calls = createPiSource(MALFORMED_FIXTURE).callsSince(0);
    assert.equal(
      calls.length,
      ASSISTANT_ENTRY_COUNT,
      'both assistant entries must survive the malformed lines',
    );
    assert.deepEqual(
      calls.map((c) => c.callId),
      ['n2', 'n4'],
    );
    const tool = calls[0].blocks.find((b) => b.type === 'tool_use');
    assert.equal(tool?.toolUse?.name, 'bash', 'the tool call before the malformed lines survives');
    assert.equal(
      calls[1].blocks[0].content,
      'There is one file.',
      'the assistant entry after the malformed lines survives',
    );
  });

  it('ignores non-message entry types', () => {
    // The malformed fixture carries a `model_change` entry between the
    // two assistant messages; it describes the session, not an LLM call.
    const calls = createPiSource(MALFORMED_FIXTURE).callsSince(0);
    assert.equal(calls.length, ASSISTANT_ENTRY_COUNT);
  });
});
