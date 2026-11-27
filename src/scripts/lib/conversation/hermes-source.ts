// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import type { AssistantMessage, ContentBlock, ConversationSource } from './types.js';
import { fidelityForModel, sourceFingerprint } from './shared.js';

const blockSchema = z.object({
  type: z.string().optional(), thinking: z.string().optional(), text: z.string().optional(), id: z.string().optional(),
}).passthrough();
const historyMessageSchema = z.object({
  role: z.string().optional(), id: z.string().optional(), message_id: z.string().optional(),
  content: z.union([z.string(), z.array(z.unknown())]).optional(), finish_reason: z.string().optional(),
  reasoning: z.string().optional(), reasoning_content: z.string().optional(),
  codex_reasoning_items: z.array(z.object({
    id: z.string().optional(),
    summary: z.array(z.object({ type: z.string().optional(), text: z.string().optional() }).passthrough()).optional(),
  }).passthrough()).optional(),
}).passthrough();
const payloadSchema = z.object({
  extra: z.object({
    assistant_response: z.string().optional(), conversation_history: z.array(z.unknown()).optional(), model: z.string().optional(),
    user_message_id: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();
type HistoryMessage = z.infer<typeof historyMessageSchema>;

/** Tool-result-only pseudo-users are model context, not observed user boundaries. */
export function isHermesUserMessage(message: unknown): boolean {
  if (!message || typeof message !== 'object' || !('role' in message) || message.role !== 'user'
    || !('content' in message)) return false;
  return typeof message.content === 'string' || (Array.isArray(message.content)
    && message.content.some((raw) => { const result = blockSchema.safeParse(raw); return result.success && result.data.type === 'text'; }));
}

function observedBlocks(message: HistoryMessage, model?: string): ContentBlock[] {
  const inline = Array.isArray(message.content) ? message.content.flatMap((raw) => {
    const parsed = blockSchema.safeParse(raw);
    return parsed.success ? [parsed.data] : [];
  }) : [];
  const blocks: ContentBlock[] = [];
  // An inline thinking sequence is authoritative. Separate reasoning fields are
  // fallback representations, not extra parts inferred by comparing text values.
  if (!inline.some((part) => part.type === 'thinking' && typeof part.thinking === 'string' && part.thinking)) {
    if (typeof message.reasoning_content === 'string' && message.reasoning_content) {
      blocks.push({ type: 'thinking', index: 0, sourceId: 'reasoning_content', content: message.reasoning_content, fidelity: fidelityForModel(model) });
    } else if (typeof message.reasoning === 'string' && message.reasoning) {
      blocks.push({ type: 'thinking', index: 0, sourceId: 'reasoning', content: message.reasoning, fidelity: fidelityForModel(model) });
    } else {
      let index = 0;
      for (const item of message.codex_reasoning_items ?? []) {
        for (const summary of item.summary ?? []) {
          if (typeof summary.text === 'string' && summary.text) {
            blocks.push({ type: 'thinking', index, content: summary.text, fidelity: 'summary', ...(item.id ? { sourceId: `${item.id}:${index}` } : {}) });
          }
          index++;
        }
      }
    }
  }
  const offset = blocks.length ? blocks[blocks.length - 1]!.index + 1 : 0;
  if (Array.isArray(message.content)) {
    for (const [sourceIndex, raw] of message.content.entries()) {
      const parsed = blockSchema.safeParse(raw);
      if (!parsed.success) continue;
      const part = parsed.data;
      const sourceId = part.id || `content:${sourceIndex}`;
      const index = offset + sourceIndex;
      if (part.type === 'thinking' && typeof part.thinking === 'string' && part.thinking) {
        blocks.push({ type: 'thinking', index, sourceId, content: part.thinking, fidelity: 'full' });
      } else if (part.type === 'text' && typeof part.text === 'string' && part.text) {
        blocks.push({ type: 'text', index, sourceId, content: part.text });
      }
    }
  } else if (typeof message.content === 'string' && message.content) {
    blocks.push({ type: 'text', index: offset, sourceId: 'content', content: message.content });
  }
  return blocks;
}

export function createHermesSource(payload: unknown): ConversationSource {
  return {
    name: 'hermes-post-llm-call',
    messagesSince(_sinceMs: number): AssistantMessage[] {
      const parsed = payloadSchema.safeParse(payload);
      if (!parsed.success || !parsed.data.extra) return [];
      const extra = parsed.data.extra;
      const history = (extra.conversation_history ?? []).flatMap((raw) => {
        const result = historyMessageSchema.safeParse(raw);
        return result.success ? [result.data] : [];
      });
      let lastUser = -1;
      let boundaryId = extra.user_message_id;
      const userOccurrences = new Map<string, number>();
      history.forEach((message, index) => {
        if (!isHermesUserMessage(message)) return;
        lastUser = index;
        boundaryId = extra.user_message_id || message.id || message.message_id
          || sourceFingerprint('hermes-user', message.content, userOccurrences);
      });
      // Anonymous boundary+occurrence keys remain ambiguous after indistinguishable history compaction.
      const current = lastUser < 0 ? [] : history.slice(lastUser + 1).filter((message) => message.role === 'assistant');
      const fallback = !current.length && typeof extra.assistant_response === 'string' && extra.assistant_response
        ? { role: 'assistant', content: extra.assistant_response } : undefined;
      if (fallback) current.push(fallback);
      const occurrences = new Map<string, number>();
      const seen = new Set<string>();
      const messages: AssistantMessage[] = [];
      for (const message of current) {
        const id = message.id || message.message_id || sourceFingerprint('hermes', { boundaryId, message }, occurrences);
        if (seen.has(id)) continue;
        seen.add(id);
        const blocks = observedBlocks(message, extra.model);
        if (message === fallback) for (const block of blocks) block.sourceId = 'assistant_response';
        // The host's explicit response supplements a latest history message
        // lacking text; it is not replayed when that message already has text.
        if (message === current[current.length - 1] && !blocks.some((block) => block.type === 'text')
          && typeof extra.assistant_response === 'string' && extra.assistant_response) {
          const index = blocks.length ? blocks[blocks.length - 1]!.index + 1 : 0;
          blocks.push({ type: 'text', index, sourceId: 'assistant_response', content: extra.assistant_response });
        }
        if (!blocks.length) continue;
        messages.push({ id, source: 'hermes-post-llm-call', blocks, finishReason: message.finish_reason });
      }
      return messages;
    },
  };
}
