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

  it('attaches assistant_response to the last call without duplicating identical content', () => {
    const calls = createHermesSource(loadFixture()).callsSince(0);
    const last = calls[calls.length - 1];
    const texts = last.blocks.filter((b) => b.type === 'text');
    // Fixture's last history entry content is byte-identical to
    // extra.assistant_response — must collapse to exactly one text
    // block, not two.
    assert.equal(texts.length, 1);
    assert.equal(texts[0].content, 'placeholder final assistant answer after checking the placeholder file');
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
