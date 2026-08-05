// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

// Cross-source structural parity check.
//
// The four ConversationSource implementations fall into two families —
// replay (claude-code-source.ts, codex-source.ts) reads a session file;
// streaming (hermes-source.ts, openclaw-source.ts) consumes an in-memory
// event/payload object the host handed to a hook. All four are supposed
// to collapse onto the same ChatCall[] shape so the chat-span layer
// above never has to know which platform produced a call. Each source's
// own test suite only compares its output against its own fixture, so
// none of them can catch two sources disagreeing on the *shape* they
// both claim to produce — that drift needs a test that runs all of them
// against semantically-equivalent input and diffs the results directly.
// This file is that test.
//
// Scope: Claude Code, Codex, and Hermes only (one streaming family
// member, two replay family members — enough to span both families).
// OpenClaw is deliberately excluded from the parity comparison and
// pinned separately below: its tool_use gap is a known, accepted
// limitation (see openclaw-source.ts's module doc), not a drift bug,
// and folding it into the parity assertions would either force a false
// "structural mismatch" or silently drop tool_use from the comparison
// for all four sources. Neither is what this test is for.
//
// The two calls constructed below (fixtures for Claude Code and Codex,
// inline payload for Hermes) describe the same semantic conversation:
// call A thinks about searching docs, says so, then calls
// `search_docs`; call B thinks about applying a patch, says so, then
// calls `apply_patch`. All fixture/payload content is hand-synthesised
// placeholder text — none of it is real conversation data.
//
// What's asserted equal: call count, per-call block-type sequence,
// blockOrderIsSane for every call, and tool_use name per call.
// What's deliberately NOT asserted equal: callId (each source has its
// own id scheme — provider request id vs. synthesised ordinal),
// timestamps (each source's time source differs), and the *value* of
// thinking's fidelity (Claude Code's Anthropic model returns full
// reasoning traces; Codex's summary-only reasoning does not — that gap
// is the real platform difference this abstraction exists to preserve,
// not paper over). Fidelity must still be *present* on every thinking
// block from every source; only its value is allowed to vary.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeCodeSource } from '../scripts/lib/conversation/claude-code-source.js';
import { createCodexSource } from '../scripts/lib/conversation/codex-source.js';
import { createHermesSource } from '../scripts/lib/conversation/hermes-source.js';
import { createOpenClawSource } from '../scripts/lib/conversation/openclaw-source.js';
import { blockOrderIsSane, type ChatCall } from '../scripts/lib/conversation/types.js';

// Test runs from dist/tests/, fixtures live in src/tests/fixtures/ and
// are not part of the compiled output. Resolve from project root
// (mirrors conversation-claude-code.test.ts / conversation-codex.test.ts
// / conversation-hermes.test.ts / conversation-openclaw.test.ts).
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(TEST_DIR, '..', '..');
const CC_FIXTURE = join(PROJECT_ROOT, 'src', 'tests', 'fixtures', 'conversation', 'cross-source-claude-code.jsonl');
const CODEX_FIXTURE = join(PROJECT_ROOT, 'src', 'tests', 'fixtures', 'conversation', 'cross-source-codex.jsonl');

// Hermes has no file at all to point at (see hermes-source.ts's module
// doc) — its input is the in-memory `post_llm_call` envelope, so the
// semantically-equivalent payload is constructed inline instead of as a
// fixture file. Anthropic-shaped `content[]` array (not the flat
// reasoning/-content string fields) so this exercises the same
// full-fidelity branch as claude-code-source.ts's own content array.
const HERMES_PAYLOAD = {
  session_id: 'cross-source-session',
  extra: {
    user_message: 'placeholder: please look into this and fix it',
    assistant_response: 'placeholder reply: I will apply the patch',
    model: 'hermes-cross-placeholder',
    platform: 'cli',
    conversation_history: [
      { role: 'user', content: 'placeholder: please look into this and fix it' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'placeholder reasoning: deciding how to search' },
          { type: 'text', text: 'placeholder reply: I will search the docs' },
        ],
        tool_calls: [
          { id: 'call-cross-a', function: { name: 'search_docs', arguments: '{"query":"placeholder"}' } },
        ],
        finish_reason: 'tool_calls',
      },
      { role: 'tool', content: 'placeholder tool result', tool_call_id: 'call-cross-a' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'placeholder reasoning: deciding how to patch' },
          { type: 'text', text: 'placeholder reply: I will apply the patch' },
        ],
        tool_calls: [
          { id: 'call-cross-b', function: { name: 'apply_patch', arguments: '{"path":"placeholder.txt"}' } },
        ],
        finish_reason: 'tool_calls',
      },
    ],
  },
};

function loadCalls(): { claudeCode: ChatCall[]; codex: ChatCall[]; hermes: ChatCall[] } {
  return {
    claudeCode: createClaudeCodeSource(CC_FIXTURE).callsSince(0),
    codex: createCodexSource(CODEX_FIXTURE).callsSince(0),
    hermes: createHermesSource(HERMES_PAYLOAD).callsSince(0),
  };
}

const EXPECTED_BLOCK_SEQUENCE = [
  ['thinking', 'text', 'tool_use'],
  ['thinking', 'text', 'tool_use'],
];
const EXPECTED_TOOL_NAMES = ['search_docs', 'apply_patch'];

describe('conversation cross-source parity (Claude Code / Codex / Hermes)', () => {
  it('produces the same call count from all three sources', () => {
    const { claudeCode, codex, hermes } = loadCalls();
    assert.equal(claudeCode.length, 2, 'claude-code call count');
    assert.equal(codex.length, 2, 'codex call count');
    assert.equal(hermes.length, 2, 'hermes call count');
  });

  it('produces the same block-type sequence per call across all three sources', () => {
    const { claudeCode, codex, hermes } = loadCalls();
    for (const [label, calls] of [
      ['claude-code', claudeCode],
      ['codex', codex],
      ['hermes', hermes],
    ] as const) {
      assert.deepEqual(
        calls.map((c) => c.blocks.map((b) => b.type)),
        EXPECTED_BLOCK_SEQUENCE,
        `${label} block-type sequence`,
      );
    }
  });

  it('gives every call from every source a sane zero-based contiguous block order', () => {
    const { claudeCode, codex, hermes } = loadCalls();
    for (const [label, calls] of [
      ['claude-code', claudeCode],
      ['codex', codex],
      ['hermes', hermes],
    ] as const) {
      for (const c of calls) {
        assert.ok(blockOrderIsSane(c), `${label} call ${c.callId} has a non-sane block order`);
      }
    }
  });

  it('produces the same tool_use name per call across all three sources', () => {
    const { claudeCode, codex, hermes } = loadCalls();
    for (const [label, calls] of [
      ['claude-code', claudeCode],
      ['codex', codex],
      ['hermes', hermes],
    ] as const) {
      const names = calls.map((c) => c.blocks.find((b) => b.type === 'tool_use')?.toolUse?.name);
      assert.deepEqual(names, EXPECTED_TOOL_NAMES, `${label} tool_use names`);
    }
  });

  it('gives every thinking block a fidelity value, without requiring the value to agree across sources', () => {
    const { claudeCode, codex, hermes } = loadCalls();
    for (const [label, calls] of [
      ['claude-code', claudeCode],
      ['codex', codex],
      ['hermes', hermes],
    ] as const) {
      for (const c of calls) {
        const thinking = c.blocks.filter((b) => b.type === 'thinking');
        assert.equal(thinking.length, 1, `${label} call ${c.callId} must have exactly one thinking block`);
        assert.ok(
          thinking[0].fidelity === 'full' || thinking[0].fidelity === 'summary',
          `${label} call ${c.callId} thinking block must carry a fidelity value`,
        );
      }
    }

    // The one property that's *supposed* to differ: Claude Code's
    // Anthropic model returns a full reasoning trace, Codex's
    // summary-only reasoning never does. Asserting these equal would
    // mean requiring every platform to report the same fidelity
    // regardless of what the underlying model actually exposes.
    assert.equal(claudeCode[0].blocks[0].fidelity, 'full');
    assert.equal(codex[0].blocks[0].fidelity, 'summary');
  });

  it('does not require callId or timestamps to agree across sources', () => {
    // Not asserted equal anywhere above by design — each source has its
    // own id scheme (provider request id vs. synthesised ordinal) and
    // its own time source. This test exists purely to document that
    // omission so a future reader doesn't "fix" it by adding one.
    const { claudeCode, codex } = loadCalls();
    assert.notEqual(claudeCode[0].callId, codex[0].callId);
  });
});

describe('OpenClaw known gap: tool_use is not reconstructed', () => {
  // Deliberately excluded from the three-way parity block above (see
  // this file's header comment and openclaw-source.ts's module doc):
  // OpenClaw's documented `llm_output` event carries no content field,
  // and correlating `before_tool_call`/`after_tool_call` back to the
  // right chat call would be guesswork on a platform this module has
  // never been verified against live. This test exists so that gap
  // cannot close silently — if someone adds tool_use support to
  // openclaw-source.ts, this assertion goes red, and the fix is to
  // widen the parity comparison above to four sources, not to leave
  // OpenClaw quietly out of step with the other three.
  const OPENCLAW_EVENTS = [
    { hook: 'before_message_write', event: { body: 'Thinking\nplaceholder reasoning: deciding how to search' } },
    {
      hook: 'llm_output',
      event: {
        callId: 'call-cross-a',
        model: 'openclaw-cross-placeholder',
        provider: 'openai-placeholder',
        outcome: 'success',
        durationMs: 5,
        assistantTexts: ['placeholder reply: I will search the docs'],
      },
    },
  ];

  it('produces thinking and text for the same semantic call, but no tool_use', () => {
    const calls = createOpenClawSource(OPENCLAW_EVENTS).callsSince(0);
    assert.equal(calls.length, 1, 'fixture must yield exactly one call');
    assert.deepEqual(
      calls[0].blocks.map((b) => b.type),
      ['thinking', 'text'],
      'openclaw should still reconstruct thinking/text for this input',
    );
    assert.equal(
      calls[0].blocks.some((b) => b.type === 'tool_use'),
      false,
      'openclaw must not fabricate a tool_use block it has no verified way to reconstruct',
    );
  });
});
