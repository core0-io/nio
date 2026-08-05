// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

// The fixture's envelope structure (top-level `session_id`/`cwd`/`extra`,
// and `extra.user_message` / `assistant_response` / `conversation_history`
// / `model` / `platform`) is hand-synthesised from a real `post_llm_call`
// capture on a live Hermes deployment fronting gpt-5.5. All string
// content in the fixture is synthetic placeholder text — it contains no
// real conversation data.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHermesSource } from '../scripts/lib/conversation/hermes-source.js';

// Test runs from dist/tests/, fixtures live in src/tests/fixtures/ and
// are not part of the compiled output. Resolve from project root so
// tests work regardless of compiled layout (mirrors adapter.test.ts /
// conversation-claude-code.test.ts / conversation-codex.test.ts).
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(TEST_DIR, '..', '..');
const FIXTURE_PATH = join(PROJECT_ROOT, 'src', 'tests', 'fixtures', 'conversation', 'hermes-post-llm-call.json');

function loadFixture(): unknown {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
}

describe('hermes source', () => {
  it('yields one call per assistant entry in conversation_history', () => {
    const calls = createHermesSource(loadFixture()).callsSince(0);
    assert.equal(calls.length, 2);
  });

  it('marks the codex_reasoning_items call as summary fidelity', () => {
    const calls = createHermesSource(loadFixture()).callsSince(0);
    const withThinking = calls.find((c) => c.blocks.some((b) => b.type === 'thinking'));
    assert.ok(withThinking, 'fixture must contain a call with a thinking block');
    const thinking = withThinking!.blocks.filter((b) => b.type === 'thinking');
    assert.equal(thinking.length, 1);
    assert.equal(thinking[0].fidelity, 'summary');
  });

  it('produces no thinking block for the assistant entry without any reasoning field', () => {
    const calls = createHermesSource(loadFixture()).callsSince(0);
    const withoutThinking = calls.filter((c) => !c.blocks.some((b) => b.type === 'thinking'));
    assert.equal(withoutThinking.length, 1);
  });

  it('maps tool_calls to a tool_use block', () => {
    const calls = createHermesSource(loadFixture()).callsSince(0);
    const tu = calls.flatMap((c) => c.blocks).find((b) => b.type === 'tool_use');
    assert.ok(tu?.toolUse, 'fixture must contain a tool_calls entry mapped to tool_use');
    assert.equal(tu!.toolUse!.id, 'call_placeholder_1');
    assert.equal(tu!.toolUse!.name, 'exec_command');
  });

  it('attaches assistant_response to the last call when it carries content beyond the last history entry', () => {
    // Fixture's extra.assistant_response has a trailing clause the last
    // history entry's content doesn't — the real-world shape when a
    // streaming completion finishes but conversation_history hasn't
    // synced yet. A test where the two strings are byte-identical (see
    // the dedup test below) cannot observe this code path at all: the
    // dedup check would swallow the attach either way, so passing there
    // proves nothing about whether attach actually runs.
    const calls = createHermesSource(loadFixture()).callsSince(0);
    const last = calls[calls.length - 1];
    const texts = last.blocks.filter((b) => b.type === 'text');
    assert.equal(texts.length, 2, 'history content and assistant_response must both surface as text blocks');
    assert.equal(texts[0].content, 'placeholder final assistant answer after checking the placeholder file');
    assert.equal(
      texts[1].content,
      'placeholder final assistant answer after checking the placeholder file -- plus a trailing clause only present in the streaming completion, not yet synced into conversation_history',
    );
  });

  it('does not duplicate assistant_response when it is byte-identical to the last history entry', () => {
    const payload = {
      extra: {
        model: 'gpt-5.5',
        assistant_response: 'identical placeholder content',
        conversation_history: [
          { role: 'user', content: 'placeholder question' },
          { role: 'assistant', content: 'identical placeholder content', finish_reason: 'stop' },
        ],
      },
    };
    const calls = createHermesSource(payload).callsSince(0);
    const last = calls[calls.length - 1];
    const texts = last.blocks.filter((b) => b.type === 'text');
    assert.equal(texts.length, 1, 'byte-identical assistant_response must collapse into the existing text block');
    assert.equal(texts[0].content, 'identical placeholder content');
  });

  it('marks timing as synthetic (all calls share one Date.now() snapshot)', () => {
    const calls = createHermesSource(loadFixture()).callsSince(0);
    assert.ok(calls.length > 0);
    for (const c of calls) assert.equal(c.timing, 'synthetic');
  });

  it('takes model from extra.model', () => {
    const calls = createHermesSource(loadFixture()).callsSince(0);
    assert.ok(calls.length > 0);
    for (const c of calls) assert.equal(c.model, 'gpt-5.5');
  });

  it('gives the same assistant message the same callId whether or not earlier history was trimmed', () => {
    // Hermes replays the *entire* conversation_history on every
    // post_llm_call (see module doc); the span layer's only defence
    // against reprocessing the same call twice is deduplicating on
    // callId. A long session eventually trims/compacts leading history
    // entries, shifting every surviving index — an index-only callId
    // (`hermes-{i}`) would silently break dedup at that point. This test
    // is the dedup contract's only guard: the same assistant message
    // must yield the same callId whether it sits at index 5 in a full
    // history or index 0 after the first 5 entries were dropped.
    const assistantWithReasoning = {
      role: 'assistant',
      content: 'placeholder reply after trim',
      finish_reason: 'stop',
      codex_reasoning_items: [
        { type: 'reasoning', id: 'rs_stable_abc123', summary: [{ type: 'summary_text', text: 'placeholder plan' }] },
      ],
    };

    const fullHistory = {
      extra: {
        model: 'gpt-5.5',
        conversation_history: [
          { role: 'user', content: 'placeholder turn 1' },
          { role: 'assistant', content: 'placeholder reply 1' },
          { role: 'user', content: 'placeholder turn 2' },
          { role: 'assistant', content: 'placeholder reply 2' },
          { role: 'user', content: 'placeholder turn 3' },
          assistantWithReasoning,
        ],
      },
    };

    const trimmedHistory = {
      extra: {
        model: 'gpt-5.5',
        // Simulates the host dropping the first 5 entries once history
        // grew past whatever cap it enforces — the same assistant
        // message now sits at index 0 instead of index 5.
        conversation_history: [assistantWithReasoning],
      },
    };

    const fullCalls = createHermesSource(fullHistory).callsSince(0);
    const trimmedCalls = createHermesSource(trimmedHistory).callsSince(0);

    // fullHistory has three assistant entries (indices 1, 3, 5); the one
    // under test — assistantWithReasoning — sits last in both payloads.
    assert.equal(fullCalls.length, 3);
    assert.equal(trimmedCalls.length, 1);
    const fromFull = fullCalls[fullCalls.length - 1];
    const fromTrimmed = trimmedCalls[trimmedCalls.length - 1];
    assert.equal(fromFull.callId, fromTrimmed.callId, 'callId must survive history truncation');
    assert.equal(fromFull.callId, 'rs_stable_abc123', 'must prefer the provider-issued reasoning-item id');
  });

  it('returns an empty array when the payload has no extra object', () => {
    assert.deepEqual(createHermesSource({ session_id: 'x' }).callsSince(0), []);
    assert.deepEqual(createHermesSource(undefined).callsSince(0), []);
    assert.deepEqual(createHermesSource(null).callsSince(0), []);
    assert.deepEqual(createHermesSource('not an object').callsSince(0), []);
  });

  it('returns an empty array when conversation_history is not an array', () => {
    assert.deepEqual(
      createHermesSource({ extra: { conversation_history: 'not-an-array', model: 'gpt-5.5' } }).callsSince(0),
      [],
    );
    assert.deepEqual(
      createHermesSource({ extra: {} }).callsSince(0),
      [],
    );
  });

  it('skips non-object entries in conversation_history without throwing', () => {
    const calls = createHermesSource({
      extra: {
        model: 'gpt-5.5',
        conversation_history: [null, 42, 'garbage', { role: 'user', content: 'hi' }, { role: 'assistant' }],
      },
    }).callsSince(0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].blocks.length, 0);
  });
});
