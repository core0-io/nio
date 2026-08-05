// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

// UNVERIFIED. The fixture and the assertions below are built from
// OpenClaw's published documentation only — the OpenClaw install
// available while writing this suite was broken (MODULE_NOT_FOUND,
// gateway would not start), so there is no live capture behind any of
// this. llm_output's metadata fields (runId/callId/provider/model/
// outcome/durationMs/...) follow the documented field table; the
// message-stream envelope shape, the 'Thinking' prefix convention, and
// the assistantTexts/usage fields on llm_output are best-effort
// readings, not verified facts — see the fixture's own `_fixture_note`
// and `openclaw-source.ts`'s module doc for the same caveat. All string
// content in the fixture is synthetic placeholder text.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpenClawSource } from '../scripts/lib/conversation/openclaw-source.js';

// Test runs from dist/tests/, fixtures live in src/tests/fixtures/ and
// are not part of the compiled output. Resolve from project root so
// tests work regardless of compiled layout (mirrors adapter.test.ts /
// conversation-claude-code.test.ts / conversation-codex.test.ts /
// conversation-hermes.test.ts).
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(TEST_DIR, '..', '..');
const FIXTURE_PATH = join(PROJECT_ROOT, 'src', 'tests', 'fixtures', 'conversation', 'openclaw-events.json');

function loadEvents(): unknown[] {
  const parsed = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { events: unknown[] };
  return parsed.events;
}

describe('openclaw source', () => {
  it('yields one call per llm_output event', () => {
    const calls = createOpenClawSource(loadEvents()).callsSince(0);
    assert.equal(calls.length, 3);
  });

  it('reads the documented llm_output fields (callId, model, outcome→stopReason)', () => {
    const calls = createOpenClawSource(loadEvents()).callsSince(0);
    const callB = calls.find((c) => c.callId === 'call-ph-2');
    assert.ok(callB, 'fixture must contain call-ph-2');
    assert.equal(callB!.model, 'gpt-5-reasoning-placeholder');
    assert.equal(callB!.stopReason, 'success');
  });

  it('identifies a Thinking-prefixed message as a thinking block, fidelity keyed off provider', () => {
    const calls = createOpenClawSource(loadEvents()).callsSince(0);
    const callA = calls.find((c) => c.callId === 'call-ph-1');
    assert.ok(callA, 'fixture must contain call-ph-1');
    const thinking = callA!.blocks.filter((b) => b.type === 'thinking');
    assert.equal(thinking.length, 1);
    assert.equal(thinking[0].fidelity, 'summary', 'provider "openai" must not be reported as full fidelity');

    const callC = calls.find((c) => c.callId === 'call-ph-3');
    assert.ok(callC, 'fixture must contain call-ph-3');
    const thinkingC = callC!.blocks.filter((b) => b.type === 'thinking');
    assert.equal(thinkingC.length, 1);
    assert.equal(thinkingC[0].fidelity, 'full', 'provider "anthropic" must be reported as full fidelity');
  });

  it('degrades gracefully when the undocumented assistantTexts/usage fields are absent', () => {
    const calls = createOpenClawSource(loadEvents()).callsSince(0);
    const callA = calls.find((c) => c.callId === 'call-ph-1');
    assert.ok(callA, 'fixture must contain call-ph-1');
    // call-ph-1's llm_output carries no assistantTexts/usage — the call
    // must still be valid (documented fields present) with usage simply
    // undefined, not thrown away or defaulted to a fake zero object.
    assert.equal(callA!.usage, undefined);
    assert.equal(callA!.model, 'gpt-5-reasoning-placeholder');
  });

  it('reads the undocumented usage field as an optional supplement when present', () => {
    const calls = createOpenClawSource(loadEvents()).callsSince(0);
    const callB = calls.find((c) => c.callId === 'call-ph-2');
    assert.deepEqual(callB!.usage, { input: 120, output: 45, cacheRead: 10, cacheWrite: 0 });
  });

  it('does not produce a thinking block for a call with no preceding Thinking message', () => {
    const calls = createOpenClawSource(loadEvents()).callsSince(0);
    const callB = calls.find((c) => c.callId === 'call-ph-2');
    assert.ok(callB, 'fixture must contain call-ph-2');
    assert.ok(!callB!.blocks.some((b) => b.type === 'thinking'));
  });

  it('does not duplicate text when assistantTexts and a later message_sending event carry identical content', () => {
    const calls = createOpenClawSource(loadEvents()).callsSince(0);
    const callB = calls.find((c) => c.callId === 'call-ph-2');
    const texts = callB!.blocks.filter((b) => b.type === 'text');
    assert.equal(texts.length, 1);
    assert.equal(texts[0].content, 'Placeholder final answer for call B.');
  });

  it('marks timing as synthetic (startMs is Date.now() + array index)', () => {
    const calls = createOpenClawSource(loadEvents()).callsSince(0);
    assert.ok(calls.length > 0);
    for (const c of calls) assert.equal(c.timing, 'synthetic');
  });

  it('returns an empty array for non-array input', () => {
    assert.deepEqual(createOpenClawSource(undefined as unknown as unknown[]).callsSince(0), []);
    assert.deepEqual(createOpenClawSource(null as unknown as unknown[]).callsSince(0), []);
    assert.deepEqual(createOpenClawSource('nope' as unknown as unknown[]).callsSince(0), []);
  });

  it('skips malformed entries without throwing', () => {
    const calls = createOpenClawSource([
      null,
      42,
      'garbage',
      { hook: 'unknown_hook', event: { foo: 'bar' } },
      { hook: 'llm_output', event: null },
      { hook: 'llm_output' },
      { event: { model: 'x' } },
      { hook: 'llm_output', event: { callId: 'call-ok', model: 'ok-model', outcome: 'success', provider: 'openai' } },
    ]).callsSince(0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].callId, 'call-ok');
  });
});
