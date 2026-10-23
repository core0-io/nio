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
      const calls = createClaudeCodeSource(path).callsSince(ms);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0]!.blocks.map((b) => b.index), [0, 2, 3, 4, 5]);
      assert.deepEqual(calls[0]!.blocks.map((b) => b.content), ['consider risk', 'repeat', 'repeat', '{"path":"a"}', 'last']);
      assert.equal(calls[0]!.blocks[0]!.fidelity, 'full');
      assert.equal(calls[0]!.blocks[1]!.sourceId, 'entry-a:2');
      assert.equal(blockOrderIsSane(calls[0]!), true);
      assert.deepEqual(createClaudeCodeSource(path).callsSince(ms + 1), []);
    });
  });

  it('keeps Codex summary fidelity, separate text blocks, tool identity and token metadata', () => {
    withTranscript([
      { type: 'turn_context', timestamp: stamp, payload: { model: 'gpt-5' } },
      { type: 'response_item', timestamp: stamp, payload: { type: 'reasoning', id: 'reason-1', summary: [{ type: 'summary_text', text: 'summary' }] } },
      { type: 'response_item', timestamp: stamp, payload: { type: 'message', id: 'msg-1', role: 'assistant', content: [{ type: 'output_text', text: 'repeat' }, { type: 'output_text', text: 'repeat' }] } },
      { type: 'response_item', timestamp: stamp, payload: { type: 'function_call', name: 'read', arguments: '{}', call_id: 'tool-1' } },
      { type: 'event_msg', timestamp: stamp, payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 3 } } } },
    ], (path) => {
      const [call] = createCodexSource(path).callsSince(ms);
      assert.ok(call);
      assert.equal(call.callId, 'reason-1');
      assert.deepEqual(call.blocks.map((b) => b.content), ['summary', 'repeat', 'repeat', '{}']);
      assert.deepEqual(call.blocks.map((b) => b.index), [0, 1, 2, 3]);
      assert.equal(call.blocks[0]!.fidelity, 'summary');
      assert.equal(call.blocks[3]!.toolUse?.id, 'tool-1');
      assert.deepEqual(call.usage, { input: 10, output: 5, reasoning: 3 });
      assert.equal(buildContentRecords(call, '2'.repeat(16), '1'.repeat(32), DEFAULT_CONTENT_LIMITS).length, 3);
    });
  });

  it('reconstructs all current-turn Hermes calls with stable replay identities and exposed unknown-fidelity reasoning', () => {
    const messages = [
      { role: 'assistant', id: 'a', content: richBlocks },
      { role: 'assistant', reasoning_content: 'unclassified reasoning', content: 'same' },
      { role: 'assistant', reasoning_content: 'unclassified reasoning', content: 'same' },
      { role: 'assistant', codex_reasoning_items: [{ id: 'r', summary: [{ text: 'step summary' }] }], content: 'final' },
    ];
    const payload = { extra: { conversation_history: [{ role: 'user', content: 'current' }, ...messages], model: 'new-model', assistant_response: 'final' } };
    const first = createHermesSource(payload).callsSince(ms);
    const replay = createHermesSource(payload).callsSince(ms + 100000);
    assert.equal(first.length, 4);
    assert.deepEqual(first.map((c) => c.callId), replay.map((c) => c.callId));
    assert.notEqual(first[1]!.callId, first[2]!.callId);
    assert.deepEqual(first[0]!.blocks.map((b) => b.index), [0, 2, 3, 4]);
    assert.equal(first[1]!.blocks[0]!.fidelity, 'unknown');
    assert.equal(first[3]!.blocks[0]!.fidelity, 'summary');
    assert.equal(first[3]!.blocks.filter((b) => b.type === 'text').length, 1);
    const compacted = createHermesSource({ extra: { conversation_history: [{ role: 'user', content: 'current' }, ...messages.slice(1)], model: 'new-model' } }).callsSince(0);
    assert.equal(compacted[0]!.callId, first[1]!.callId);
  });

  it('preserves Hermes separate reasoning alongside array text and scopes untimestamped history to the current user turn', () => {
    const history = [
      { role: 'user', content: 'previous' },
      { role: 'assistant', id: 'old', content: 'previous reply' },
      { role: 'user', content: 'current' },
      { role: 'assistant', id: 'current-a', reasoning_content: 'exposed thought', content: [{ type: 'text', text: 'repeat' }, { type: 'text', text: 'repeat' }] },
      { role: 'assistant', id: 'current-b', reasoning_content: 'inline thought', content: [{ type: 'thinking', thinking: 'inline thought' }, { type: 'text', text: 'done' }] },
    ];
    const calls = createHermesSource({ extra: { model: 'claude-opus-4-6', conversation_history: history } }).callsSince(0);
    assert.deepEqual(calls.map((c) => c.callId), ['current-a', 'current-b']);
    assert.deepEqual(calls[0]!.blocks.map((b) => [b.index, b.content]), [[0, 'exposed thought'], [1, 'repeat'], [2, 'repeat']]);
    assert.deepEqual(calls[0]!.blocks.map((b) => b.sourceId), ['reasoning_content', 'content:0', 'content:1']);
    assert.equal(calls[0]!.blocks[0]!.fidelity, 'full');
    assert.equal(calls[1]!.blocks.filter((b) => b.type === 'thinking').length, 1);
  });

  it('does not link ambiguous Hermes historical calls but retains an explicitly observed current response', () => {
    const conversation_history = [{ role: 'assistant', id: 'old', content: 'historical body' }];
    assert.deepEqual(createHermesSource({ extra: { conversation_history } }).callsSince(0), []);
    const calls = createHermesSource({ extra: { conversation_history, assistant_response: 'current body' } }).callsSince(0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.blocks.map((b) => [b.content, b.sourceId]), [['current body', 'assistant_response']]);
    assert.notEqual(calls[0]!.callId, 'old');
  });

  it('reconstructs Pi session files and ephemeral message events using the same content positions', () => {
    const entry = { type: 'message', id: 'pi-entry', message: { role: 'assistant', model: 'claude-opus-4-6', timestamp: ms, content: richBlocks.map((b) => b.type === 'tool_use' ? { type: 'toolCall', id: b.id, name: b.name, arguments: b.input } : b), usage: { input: 3, output: 4 } } };
    const fromEvents = createPiSource(undefined, [entry]).callsSince(ms);
    assert.equal(fromEvents[0]!.callId, 'pi-entry');
    assert.deepEqual(fromEvents[0]!.blocks.map((b) => b.index), [0, 2, 3, 4]);
    assert.equal(fromEvents[0]!.blocks[0]!.fidelity, 'full');
    withTranscript([entry], (path) => {
      const fromFile = createPiSource(path).callsSince(ms);
      assert.deepEqual(fromFile[0]!.blocks, fromEvents[0]!.blocks);
      assert.equal(fromFile[0]!.callId, fromEvents[0]!.callId);
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
    const calls = createOpenCodeSource(events).callsSince(ms);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.blocks.map((b) => [b.index, b.sourceId, b.content]), [[1, 'r', 'step'], [2, 'a', 'repeat'], [3, 'b', 'repeat']]);
    assert.equal(calls[0]!.usage?.output, 6);
    assert.equal(calls[0]!.blocks[0]!.fidelity, 'summary');
  });

  it('reads OpenClaw lastAssistant blocks without guessing associations or duplicating assistantTexts', () => {
    const events = [
      { hook: 'message_sending', event: { text: 'Thinking unrelated' } },
      { hook: 'llm_output', event: { runId: 'same-run', model: 'claude-opus-4-6', lastAssistant: { id: 'first', content: richBlocks }, assistantTexts: ['repeat', 'repeat'] } },
      { hook: 'llm_output', event: { runId: 'same-run', assistantTexts: ['next'] } },
    ];
    const calls = createOpenClawSource(events).callsSince(ms);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.callId, 'first');
    assert.deepEqual(calls[0]!.blocks.map((b) => b.index), [0, 2, 3, 4]);
    assert.equal(calls[0]!.blocks[0]!.fidelity, 'full');
    assert.equal(calls[1]!.blocks[0]!.content, 'next');
    assert.deepEqual(createOpenClawSource(events).callsSince(0).map((c) => c.callId), calls.map((c) => c.callId));
    assert.equal(createOpenClawSource([{ hook: 'llm_output', event: { runId: 'empty' } }]).callsSince(0)[0]!.blocks.length, 0);
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
    ], (path) => assert.equal(createClaudeCodeSource(path).callsSince(ms)[0]!.blocks[0]!.content, 'ok'));
    withTranscript([
      { type: 'response_item', timestamp: stamp, payload: { type: 'reasoning', summary: 'not an array' } },
      { type: 'response_item', timestamp: stamp, payload: { type: 'message', role: 'assistant', id: 'valid', content: [{ text: 'ok' }] } },
    ], (path) => assert.equal(createCodexSource(path).callsSince(ms)[0]!.blocks[0]!.content, 'ok'));
    assert.deepEqual(createHermesSource({ extra: { conversation_history: 'not history' } }).callsSince(0), []);
    assert.deepEqual(createPiSource(undefined, [{ type: 'message', message: 'not a message' }]).callsSince(0), []);
    assert.deepEqual(createOpenCodeSource([{ kind: 'message', info: { role: 'assistant', id: 4 } }]).callsSince(0), []);
    assert.deepEqual(createOpenClawSource([{ hook: 'llm_output', event: { lastAssistant: 'not a message' } }]).callsSince(0), []);
  });

  it('does not assign raw reasoning fidelity from an unrelated gateway', () => {
    assert.equal(fidelityForModel('claude-opus-4-6', 'openrouter'), 'full');
    assert.equal(fidelityForModel('gpt-5', 'openrouter'), 'summary');
    assert.equal(fidelityForModel('future-model', 'anthropic'), 'unknown');
    assert.equal(fidelityForModel(undefined, 'anthropic'), 'full');
    assert.equal(fidelityForModel(undefined, 'openrouter'), 'unknown');
  });
});
