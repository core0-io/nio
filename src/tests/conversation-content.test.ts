// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeCodeSource, lastUserPromptSince } from '../scripts/lib/conversation/claude-code-source.js';
import { createCodexSource } from '../scripts/lib/conversation/codex-source.js';
import { createHermesSource } from '../scripts/lib/conversation/hermes-source.js';
import { createPiSource } from '../scripts/lib/conversation/pi-source.js';
import { createOpenCodeSource } from '../scripts/lib/conversation/opencode-source.js';
import { createOpenClawSource } from '../scripts/lib/conversation/openclaw-source.js';
import { createSourceForPlatform } from '../scripts/lib/conversation/factory.js';
import { blockOrderIsSane } from '../scripts/lib/conversation/types.js';
import { fidelityForModel } from '../scripts/lib/conversation/shared.js';
import { buildContentRecords } from '../scripts/lib/content/emit.js';
import { DEFAULT_CONTENT_LIMITS } from '../scripts/lib/content/truncate.js';

const stamp = '2026-10-23T10:00:00.000Z';
const ms = Date.parse(stamp);
function withTranscript(entries: unknown[], run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'nio-conversation-'));
  try {
    const path = join(dir, 'session.jsonl');
    writeFileSync(path, ['null', '{bad json', ...entries.map((e) => JSON.stringify(e))].join('\n'));
    run(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const richBlocks = [
  { type: 'thinking', thinking: 'consider risk' },
  { type: 'image', data: 'not text' },
  { type: 'text', text: 'repeat' },
  { type: 'text', text: 'repeat' },
  { type: 'tool_use', id: 'tool-1', name: 'read', input: { path: 'a' } },
];

describe('conversation content reconstruction', () => {
  it('preserves Claude original indices, repeated blocks, source identities and split response parts', () => {
    const first = { type: 'assistant', uuid: 'entry-a', timestamp: stamp, message: { id: 'message-1', model: 'claude-opus-4-6', content: richBlocks, usage: { input_tokens: 10 } } };
    const second = { type: 'assistant', uuid: 'entry-b', timestamp: stamp, message: { id: 'message-1', content: [{ type: 'text', text: 'last' }], usage: { output_tokens: 5 } } };
    withTranscript([first, first, second], (path) => {
      const calls = createClaudeCodeSource(path).messagesSince(ms);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0]!.blocks.map((b) => b.index), [0, 2, 3, 4]);
      assert.deepEqual(calls[0]!.blocks.map((b) => b.content), ['consider risk', 'repeat', 'repeat', 'last']);
      assert.equal(calls[0]!.blocks[0]!.fidelity, 'full');
      assert.equal(calls[0]!.blocks[1]!.sourceId, 'entry-a:2');
      assert.equal(blockOrderIsSane(calls[0]!), true);
      assert.deepEqual(createClaudeCodeSource(path).messagesSince(ms + 1), []);
    });
  });

  it('preserves actual Codex response item boundaries and exposed summaries without replaying tools or inventing generations', () => {
    withTranscript([
      { type: 'turn_context', timestamp: stamp, payload: { model: 'gpt-5' } },
      { type: 'response_item', timestamp: stamp, payload: { type: 'reasoning', id: 'reason-1', summary: [{ type: 'summary_text', text: 'summary' }] } },
      { type: 'response_item', timestamp: stamp, payload: { type: 'message', id: 'msg-1', role: 'assistant', content: [{ type: 'output_text', text: 'repeat' }, { type: 'output_text', text: 'repeat' }] } },
      { type: 'response_item', timestamp: stamp, payload: { type: 'function_call', name: 'read', arguments: '{}', call_id: 'tool-1' } },
      { type: 'event_msg', timestamp: stamp, payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 3 } } } },
    ], (path) => {
      const messages = createCodexSource(path).messagesSince(ms);
      assert.deepEqual(messages.map((message) => message.id), ['reason-1', 'msg-1']);
      assert.deepEqual(messages[0]!.blocks.map((block) => block.content), ['summary']);
      assert.deepEqual(messages[1]!.blocks.map((block) => block.content), ['repeat', 'repeat']);
      assert.deepEqual(messages[1]!.blocks.map((block) => block.index), [0, 1]);
      assert.equal(messages[0]!.blocks[0]!.fidelity, 'summary');
      for (const message of messages) {
        const records = buildContentRecords(message, '2'.repeat(16), '1'.repeat(32), DEFAULT_CONTENT_LIMITS);
        assert.equal(records.length, 1);
        assert.ok(!JSON.stringify(records).includes('tool-1'));
        assert.ok(!('usage' in message));
      }
    });
  });

  it('reconstructs current-turn Hermes messages with stable replay identities and exposed unknown-fidelity reasoning', () => {
    const messages = [
      { role: 'assistant', id: 'a', content: richBlocks },
      { role: 'assistant', reasoning_content: 'unclassified reasoning', content: 'same' },
      { role: 'assistant', reasoning_content: 'unclassified reasoning', content: 'same' },
      { role: 'assistant', codex_reasoning_items: [{ id: 'r', summary: [{ text: 'step summary' }] }], content: 'final' },
    ];
    const payload = { extra: { conversation_history: [{ role: 'user', content: 'current' }, ...messages], model: 'new-model', assistant_response: 'final' } };
    const first = createHermesSource(payload).messagesSince(ms);
    const replay = createHermesSource(payload).messagesSince(ms + 100000);
    assert.equal(first.length, 4);
    assert.deepEqual(first.map((c) => c.id), replay.map((c) => c.id));
    assert.notEqual(first[1]!.id, first[2]!.id);
    assert.deepEqual(first[0]!.blocks.map((b) => b.index), [0, 2, 3]);
    assert.equal(first[1]!.blocks[0]!.fidelity, 'unknown');
    assert.equal(first[3]!.blocks[0]!.fidelity, 'summary');
    assert.equal(first[3]!.blocks.filter((b) => b.type === 'text').length, 1);
    const compacted = createHermesSource({ extra: { conversation_history: [{ role: 'user', content: 'current' }, ...messages.slice(1)], model: 'new-model' } }).messagesSince(0);
    assert.equal(compacted[0]!.id, first[1]!.id);
  });

  it('preserves Hermes separate reasoning alongside array text and scopes untimestamped history to the current user turn', () => {
    const history = [
      { role: 'user', content: 'previous' },
      { role: 'assistant', id: 'old', content: 'previous reply' },
      { role: 'user', content: 'current' },
      { role: 'assistant', id: 'current-a', reasoning_content: 'exposed thought', content: [{ type: 'text', text: 'repeat' }, { type: 'text', text: 'repeat' }] },
      { role: 'assistant', id: 'current-b', reasoning_content: 'inline thought', content: [{ type: 'thinking', thinking: 'inline thought' }, { type: 'text', text: 'done' }] },
    ];
    const calls = createHermesSource({ extra: { model: 'claude-opus-4-6', conversation_history: history } }).messagesSince(0);
    assert.deepEqual(calls.map((c) => c.id), ['current-a', 'current-b']);
    assert.deepEqual(calls[0]!.blocks.map((b) => [b.index, b.content]), [[0, 'exposed thought'], [1, 'repeat'], [2, 'repeat']]);
    assert.deepEqual(calls[0]!.blocks.map((b) => b.sourceId), ['reasoning_content', 'content:0', 'content:1']);
    assert.equal(calls[0]!.blocks[0]!.fidelity, 'full');
    assert.equal(calls[1]!.blocks.filter((b) => b.type === 'thinking').length, 1);
  });

  it('does not link ambiguous Hermes history but retains an explicitly observed current response', () => {
    const conversation_history = [{ role: 'assistant', id: 'old', content: 'historical body' }];
    assert.deepEqual(createHermesSource({ extra: { conversation_history } }).messagesSince(0), []);
    const calls = createHermesSource({ extra: { conversation_history, assistant_response: 'current body' } }).messagesSince(0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.blocks.map((b) => [b.content, b.sourceId]), [['current body', 'assistant_response']]);
    assert.notEqual(calls[0]!.id, 'old');
  });

  it('keeps an explicit Hermes response when the latest history message exposes only reasoning', () => {
    const messages = createHermesSource({ extra: {
      conversation_history: [{ role: 'user', content: 'current' }, { role: 'assistant', id: 'latest', reasoning_content: 'visible' }],
      assistant_response: 'actual reply',
    } }).messagesSince(0);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.id, 'latest');
    assert.deepEqual(messages[0]!.blocks.map((block) => [block.type, block.content]), [['thinking', 'visible'], ['text', 'actual reply']]);
  });

  it('reconstructs Pi session files and ephemeral message events using the same content positions', () => {
    const entry = { type: 'message', id: 'pi-entry', message: { role: 'assistant', model: 'claude-opus-4-6', timestamp: ms, content: richBlocks.map((b) => b.type === 'tool_use' ? { type: 'toolCall', id: b.id, name: b.name, arguments: b.input } : b), usage: { input: 3, output: 4 } } };
    const fromEvents = createPiSource(undefined, [entry]).messagesSince(ms);
    assert.equal(fromEvents[0]!.id, 'pi-entry');
    assert.deepEqual(fromEvents[0]!.blocks.map((b) => b.index), [0, 2, 3]);
    assert.equal(fromEvents[0]!.blocks[0]!.fidelity, 'full');
    withTranscript([entry], (path) => {
      const fromFile = createPiSource(path).messagesSince(ms);
      assert.deepEqual(fromFile[0]!.blocks, fromEvents[0]!.blocks);
      assert.equal(fromFile[0]!.id, fromEvents[0]!.id);
    });
    assert.ok(createSourceForPlatform('pi', { events: [entry] }));
  });

  it('replaces OpenCode part snapshots by ID but preserves equal distinct parts and gaps', () => {
    const info = { id: 'msg', role: 'assistant', modelID: 'gpt-5', time: { created: ms, completed: ms + 1 }, tokens: { input: 4, output: 3 } };
    const events = [
      { kind: 'message', info },
      { kind: 'part', part: { messageID: 'msg', id: 'step', type: 'step-start' } },
      { kind: 'part', part: { messageID: 'msg', id: 'r', type: 'reasoning', text: 'step' } },
      { kind: 'part', part: { messageID: 'msg', id: 'a', type: 'text', text: 'rep' } },
      { kind: 'part', part: { messageID: 'msg', id: 'a', type: 'text', text: 'repeat' } },
      { kind: 'part', part: { messageID: 'msg', id: 'b', type: 'text', text: 'repeat' } },
      { kind: 'message', info: { ...info, tokens: { input: 4, output: 6 } } },
    ];
    const calls = createOpenCodeSource(events).messagesSince(ms);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.blocks.map((b) => [b.index, b.sourceId, b.content]), [[1, 'r', 'step'], [2, 'a', 'repeat'], [3, 'b', 'repeat']]);
    assert.equal(calls[0]!.blocks[0]!.fidelity, 'summary');
  });

  it('reads OpenClaw lastAssistant blocks without guessing associations or duplicating assistantTexts', () => {
    const events = [
      { hook: 'message_sending', event: { text: 'Thinking unrelated' } },
      { hook: 'llm_output', event: { runId: 'same-run', model: 'claude-opus-4-6', lastAssistant: { id: 'first', content: richBlocks }, assistantTexts: ['repeat', 'repeat'] } },
      { hook: 'llm_output', event: { runId: 'same-run', assistantTexts: ['first message', 'second message'] } },
    ];
    const calls = createOpenClawSource(events).messagesSince(ms);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.id, 'first');
    assert.deepEqual(calls[0]!.blocks.map((b) => b.index), [0, 2, 3]);
    assert.equal(calls[0]!.blocks[0]!.fidelity, 'full');
    assert.deepEqual(createOpenClawSource(events).messagesSince(0).map((c) => c.id), calls.map((c) => c.id));
    assert.deepEqual(createOpenClawSource([{ hook: 'llm_output', event: { runId: 'empty' } }]).messagesSince(0), []);
  });

  it('rejects aggregate-only OpenClaw outputs without native message content', () => {
    const events = [
      { hook: 'llm_output', event: { assistantTexts: ['first message', 'second message'] } },
      { hook: 'llm_output', event: { lastAssistant: { id: 'missing-content' }, assistantTexts: ['first message', 'second message'] } },
      { hook: 'llm_output', event: { content: [{ type: 'text', text: 'unbounded' }], reasoning: 'unbounded', assistantTexts: ['aggregate'] } },
    ];
    assert.deepEqual(createOpenClawSource(events).messagesSince(0), []);
  });

  it('preserves native OpenClaw string content and stopReason without mapping event outcome', () => {
    const messages = createOpenClawSource([
      { hook: 'llm_output', event: { outcome: 'incorrect', lastAssistant: { id: 'native', content: 'reply', stopReason: 'host-specific-reason' } } },
      { hook: 'llm_output', event: { outcome: 'not-a-native-reason', lastAssistant: { id: 'unknown', content: 'reply' } } },
    ]).messagesSince(0);
    assert.deepEqual(messages[0]!.blocks.map((block) => [block.index, block.type, block.content]), [[0, 'text', 'reply']]);
    assert.equal(messages[0]!.finishReason, 'host-specific-reason');
    assert.equal(messages[1]!.finishReason, undefined);
  });

  it('captures native separate OpenClaw reasoning with array text and respects inline part order', () => {
    const messages = createOpenClawSource([
      { hook: 'llm_output', event: { lastAssistant: { id: 'separate', reasoning_content: 'visible', content: [{ type: 'text', text: 'reply' }] } } },
      { hook: 'llm_output', event: { lastAssistant: { id: 'inline', reasoning_content: 'fallback not duplicated', content: [
        { type: 'text', text: 'first' }, { type: 'thinking', thinking: 'visible' }, { type: 'thinking', thinking: 'visible' },
        { type: 'text', text: 'first' },
      ] } } },
    ]).messagesSince(0);
    assert.deepEqual(messages[0]!.blocks.map((block) => [block.type, block.content]), [['thinking', 'visible'], ['text', 'reply']]);
    assert.deepEqual(messages[1]!.blocks.map((block) => [block.index, block.type, block.content]), [[0, 'text', 'first'], [1, 'thinking', 'visible'], [2, 'thinking', 'visible'], [3, 'text', 'first']]);
  });

  it('supports Pi string messages and keeps anonymous equal message occurrences distinct', () => {
    const entry = { type: 'message', message: { role: 'assistant', timestamp: ms, content: 'same' } };
    const messages = createPiSource(undefined, [entry, entry]).messagesSince(ms);
    assert.equal(messages.length, 2);
    assert.notEqual(messages[0]!.id, messages[1]!.id);
    assert.deepEqual(messages.map((message) => message.blocks.map((block) => [block.index, block.content])), [[[0, 'same']], [[0, 'same']]]);
  });

  it('uses actual message identity instead of a shared callback/request identity', () => {
    withTranscript([
      { type: 'assistant', requestId: 'request', uuid: 'entry-a', timestamp: stamp, message: { id: 'message-a', content: [{ type: 'text', text: 'equal' }] } },
      { type: 'assistant', requestId: 'request', uuid: 'entry-b', timestamp: stamp, message: { id: 'message-b', content: [{ type: 'text', text: 'equal' }] } },
    ], (path) => assert.deepEqual(createClaudeCodeSource(path).messagesSince(ms).map((message) => message.id), ['message-a', 'message-b']));
    const messages = createOpenClawSource(['a', 'b'].map((id) => ({
      hook: 'llm_output', event: { callId: 'callback', lastAssistant: { id, content: [{ type: 'text', text: 'equal' }] } },
    }))).messagesSince(0);
    assert.deepEqual(messages.map((message) => message.id), ['a', 'b']);
  });

  it('preserves duplicate native reasoning parts and rejects encrypted or unsupported reasoning', () => {
    withTranscript([
      { type: 'response_item', timestamp: stamp, payload: { type: 'reasoning', id: 'encrypted', encrypted_content: 'opaque' } },
      { type: 'response_item', timestamp: stamp, payload: { type: 'reasoning', id: 'visible', summary: [
        { type: 'summary_text', text: 'same' }, { type: 'image', text: 'not reasoning' }, { type: 'summary_text', text: 'same' },
      ] } },
    ], (path) => {
      const messages = createCodexSource(path).messagesSince(ms);
      assert.equal(messages.length, 1);
      assert.deepEqual(messages[0]!.blocks.map((block) => [block.index, block.sourceId, block.content]), [[0, 'visible:0', 'same'], [2, 'visible:2', 'same']]);
    });
    const messages = createHermesSource({ extra: { conversation_history: [
      { role: 'user', content: 'current' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'same' }, { type: 'thinking', thinking: 'same' }] },
    ] } }).messagesSince(0);
    assert.deepEqual(messages[0]!.blocks.map((block) => block.content), ['same', 'same']);
  });

  it('extracts actual Claude and Codex user prompts with replay identity, not tool output or metadata', () => {
    withTranscript([
      { type: 'user', uuid: 'prompt-1', timestamp: stamp, message: { content: 'keep whitespace  ' } },
      { type: 'user', isMeta: true, timestamp: stamp, message: { content: 'injected' } },
      { type: 'user', timestamp: stamp, message: { content: [{ type: 'tool_result', content: 'result' }] } },
    ], (path) => {
      assert.deepEqual(lastUserPromptSince(path, ms), { text: 'keep whitespace  ', id: 'prompt-1' });
      assert.equal(lastUserPromptSince(path, ms + 1), null);
    });
    for (const entry of [
      { type: 'event_msg', timestamp: stamp, payload: { type: 'user_message', id: 'codex-prompt', message: 'actual user' } },
      { type: 'response_item', timestamp: stamp, payload: { type: 'message', role: 'user', id: 'codex-prompt', content: [{ type: 'input_text', text: 'actual user' }] } },
    ]) withTranscript([entry], (path) => assert.deepEqual(lastUserPromptSince(path, ms), {
      text: 'actual user', id: 'codex-prompt',
      ...(entry.type === 'response_item' ? { blocks: [{ text: 'actual user', index: 0 }] } : {}),
    }));
  });

  it('keeps repeated prompt blocks and their original source positions across image gaps', () => {
    withTranscript([{ type: 'user', uuid: 'multi-prompt', timestamp: stamp, message: { content: [
      { type: 'text', text: 'repeat', id: 'prompt-part-a' },
      { type: 'image', source: 'opaque' },
      { type: 'text', text: 'repeat', id: 'prompt-part-b' },
    ] } }], (path) => {
      assert.deepEqual(lastUserPromptSince(path, ms), {
        id: 'multi-prompt', text: 'repeat\nrepeat',
        blocks: [{ text: 'repeat', index: 0, sourceId: 'prompt-part-a' }, { text: 'repeat', index: 2, sourceId: 'prompt-part-b' }],
      });
    });
  });

  it('skips malformed host records without aborting valid surrounding content', () => {
    withTranscript([
      { type: 'assistant', timestamp: stamp, message: 'not a message' },
      { type: 'assistant', timestamp: stamp, message: { id: 'valid', content: [{ type: 'text', text: 'ok' }] } },
    ], (path) => assert.equal(createClaudeCodeSource(path).messagesSince(ms)[0]!.blocks[0]!.content, 'ok'));
    withTranscript([
      { type: 'response_item', timestamp: stamp, payload: { type: 'reasoning', summary: 'not an array' } },
      { type: 'response_item', timestamp: stamp, payload: { type: 'message', role: 'assistant', id: 'valid', content: [{ text: 'ok' }] } },
    ], (path) => assert.equal(createCodexSource(path).messagesSince(ms)[0]!.blocks[0]!.content, 'ok'));
    assert.deepEqual(createHermesSource({ extra: { conversation_history: 'not history' } }).messagesSince(0), []);
    assert.deepEqual(createPiSource(undefined, [{ type: 'message', message: 'not a message' }]).messagesSince(0), []);
    assert.deepEqual(createOpenCodeSource([{ kind: 'message', info: { role: 'assistant', id: 4 } }]).messagesSince(0), []);
    assert.deepEqual(createOpenClawSource([{ hook: 'llm_output', event: { lastAssistant: 'not a message' } }]).messagesSince(0), []);
  });

  it('does not assign raw reasoning fidelity from an unrelated gateway', () => {
    assert.equal(fidelityForModel('claude-opus-4-6', 'openrouter'), 'full');
    assert.equal(fidelityForModel('gpt-5', 'openrouter'), 'summary');
    assert.equal(fidelityForModel('future-model', 'anthropic'), 'unknown');
    assert.equal(fidelityForModel(undefined, 'anthropic'), 'full');
    assert.equal(fidelityForModel(undefined, 'openrouter'), 'unknown');
  });
});
