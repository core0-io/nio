// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildChatSpanNodes, chatSpanAttributes, chatSpanName } from '../scripts/lib/chat-span.js';
import type { ChatCall } from '../scripts/lib/conversation/types.js';

function call(): ChatCall {
  return {
    callId: 'message-id', source: 'codex-rollout', model: 'gpt-5', startMs: 10, endMs: 20, timing: 'exact', isSidechain: true,
    usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5 },
    timeToFirstTokenMs: 6,
    stopReason: 'tool_use',
    blocks: [
      { type: 'thinking', index: 0, content: 'private reasoning', fidelity: 'summary' },
      { type: 'text', index: 1, content: 'private reply' },
      { type: 'tool_use', index: 2, content: '{"private":"arguments"}', toolUse: { id: 'exact-tool-id', name: 'read', input: '{"private":"arguments"}' } },
    ],
  };
}

describe('content association chat spans', () => {
  it('retains operational model, timing, tokens and exact tool IDs without full bodies or previews', () => {
    const attributes = chatSpanAttributes(call());
    assert.equal(attributes['gen_ai.request.model'], 'gpt-5');
    assert.equal(attributes['gen_ai.response.id'], 'message-id');
    assert.equal(attributes['gen_ai.usage.input_tokens'], 1);
    assert.equal(attributes['gen_ai.usage.output_tokens'], 2);
    assert.equal(attributes['gen_ai.usage.cache_read.input_tokens'], 3);
    assert.equal(attributes['gen_ai.usage.cache_creation.input_tokens'], 4);
    assert.equal(attributes['gen_ai.usage.reasoning.output_tokens'], 5);
    assert.equal(attributes['gen_ai.response.time_to_first_token_ms'], 6);
    assert.equal(attributes['nio.chat.timing'], 'exact');
    assert.equal(attributes['nio.chat.is_sidechain'], true);
    assert.equal(attributes['nio.content.source'], 'logs');
    assert.deepEqual(attributes['nio.chat.tool_call_ids'], ['exact-tool-id']);
    assert.equal(attributes['nio.chat.reply'], undefined);
    assert.equal(attributes['gen_ai.tool.call.arguments'], undefined);
    assert.ok(!JSON.stringify(attributes).includes('private'));
    assert.equal(chatSpanName(call()), 'chat gpt-5');
  });

  it('mints a unique span association per observed chat, without inventing tool parenting', () => {
    const first = call();
    const nodes = buildChatSpanNodes([first, { ...first, callId: 'next' }]);
    assert.equal(nodes.length, 2);
    assert.equal(nodes[0]!.call, first);
    assert.match(nodes[0]!.span_id, /^[0-9a-f]{16}$/);
    assert.notEqual(nodes[0]!.span_id, nodes[1]!.span_id);
    assert.deepEqual(Object.keys(nodes[0]!).sort(), ['call', 'span_id']);
    assert.deepEqual(buildChatSpanNodes([]), []);
  });
});
