// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import type { ChatCall, ContentBlock, ConversationSource } from './types.js';
import { fidelityForModel, sourceFingerprint } from './shared.js';

const blockSchema = z.object({
  type: z.string().optional(), thinking: z.string().optional(), text: z.string().optional(),
  id: z.string().optional(), name: z.string().optional(), input: z.unknown().optional(),
}).passthrough();
const toolCallSchema = z.object({
  id: z.string().optional(),
  function: z.object({ name: z.string().optional(), arguments: z.unknown().optional() }).passthrough().optional(),
}).passthrough();
const historyMessageSchema = z.object({
  role: z.string().optional(), id: z.string().optional(), message_id: z.string().optional(),
  content: z.union([z.string(), z.array(blockSchema)]).optional(), finish_reason: z.string().optional(),
  tool_calls: z.array(toolCallSchema).optional(), reasoning: z.string().optional(), reasoning_content: z.string().optional(),
  codex_reasoning_items: z.array(z.object({
    id: z.string().optional(), _issuer_kind: z.string().optional(),
    summary: z.array(z.object({ type: z.string().optional(), text: z.string().optional() }).passthrough()).optional(),
  }).passthrough()).optional(),
}).passthrough();
const payloadSchema = z.object({
  extra: z.object({
    user_message: z.string().optional(), assistant_response: z.string().optional(),
    conversation_history: z.array(z.unknown()).optional(), model: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();
type RawHistoryMessage = z.infer<typeof historyMessageSchema>;
type RawToolCall = z.infer<typeof toolCallSchema>;

type PartialBlock = ContentBlock;

function hasCodexMarker(msg: RawHistoryMessage): boolean {
  const items = msg.codex_reasoning_items;
  if (!Array.isArray(items) || items.length === 0) return false;
  return items.every(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      (item._issuer_kind === undefined || (typeof item._issuer_kind === 'string' && item._issuer_kind.includes('codex'))),
  );
}

function stableCallId(msg: RawHistoryMessage, occurrences: Map<string, number>): string {
  if (typeof msg.id === 'string' && msg.id) return msg.id;
  if (typeof msg.message_id === 'string' && msg.message_id) return msg.message_id;
  const reasoningId = msg.codex_reasoning_items?.[0]?.id;
  if (typeof reasoningId === 'string' && reasoningId.length > 0) return reasoningId;

  const toolCallId = msg.tool_calls?.[0]?.id;
  if (typeof toolCallId === 'string' && toolCallId.length > 0) return toolCallId;

  return sourceFingerprint('hermes', msg, occurrences);
}

function reasoningText(msg: RawHistoryMessage): string | undefined {
  if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0) {
    return msg.reasoning_content;
  }
  if (typeof msg.reasoning === 'string' && msg.reasoning.length > 0) {
    return msg.reasoning;
  }
  if (Array.isArray(msg.codex_reasoning_items)) {
    const joined = msg.codex_reasoning_items
      .flatMap((item) => (Array.isArray(item?.summary) ? item.summary : []))
      .filter((s) => s && typeof s.text === 'string')
      .map((s) => s!.text as string)
      .join('\n');
    if (joined.length > 0) return joined;
  }
  return undefined;
}

function toThinkingAndText(msg: RawHistoryMessage, model?: string): PartialBlock[] {
  const blocks: PartialBlock[] = [];


  if (hasCodexMarker(msg)) {
    let index = 0;
    for (const item of msg.codex_reasoning_items ?? []) {
      if (!Array.isArray(item?.summary)) continue;
      for (const summary of item.summary) {
        if (summary && typeof summary.text === 'string' && summary.text) {
          blocks.push({ type: 'thinking', index, content: summary.text, fidelity: 'summary', ...(item.id ? { sourceId: `${item.id}:${index}` } : {}) });
        }
        index += 1;
      }
    }
  }
  if (!blocks.length) {
    const text = reasoningText(msg);
    if (text) blocks.push({ type: 'thinking', index: 0, sourceId: typeof msg.reasoning_content === 'string' ? 'reasoning_content' : 'reasoning', content: text, fidelity: hasCodexMarker(msg) ? 'summary' : fidelityForModel(model) });
  }

  if (Array.isArray(msg.content)) {
    const inlineThinking = msg.content.filter((b) => b?.type === 'thinking' && typeof b.thinking === 'string').map((b) => b.thinking).join('\n');
    if (inlineThinking && inlineThinking === blocks.map((b) => b.content).join('\n')) blocks.length = 0;
    const offset = blocks.length ? blocks[blocks.length - 1]!.index + 1 : 0;
    for (const [sourceIndex, b] of msg.content.entries()) {
      if (!b || typeof b !== 'object') continue;
      const index = offset + sourceIndex;
      const sourceId = typeof b.id === 'string' ? b.id : `content:${sourceIndex}`;
      if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.length > 0) {
        blocks.push({ type: 'thinking', index, sourceId, content: b.thinking, fidelity: 'full' });
      } else if (b.type === 'text' && typeof b.text === 'string' && b.text.length > 0) {
        blocks.push({ type: 'text', index, sourceId, content: b.text });
      } else if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        const input = JSON.stringify(b.input ?? {});
        blocks.push({ type: 'tool_use', index, sourceId, content: input, toolUse: { id: b.id, name: b.name, input } });
      }
    }
    return blocks;
  }

  if (typeof msg.content === 'string' && msg.content.length > 0) {
    blocks.push({ type: 'text', index: blocks.length ? blocks[blocks.length - 1]!.index + 1 : 0, sourceId: 'content', content: msg.content });
  }

  return blocks;
}

function toToolUseBlocks(toolCalls: unknown, offset: number): PartialBlock[] {
  if (!Array.isArray(toolCalls)) return [];
  const blocks: PartialBlock[] = [];
  toolCalls.forEach((tc: RawToolCall, i) => {
    if (!tc || typeof tc !== 'object') return;
    const fn = tc.function;
    if (!fn || typeof fn.name !== 'string' || typeof tc.id !== 'string' || !tc.id) return;
    const input = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {});
    blocks.push({
      type: 'tool_use',
      index: offset + i,
      content: input,
      toolUse: {
        id: tc.id,
        name: fn.name,
        input,
      },
    });
  });
  return blocks;
}

export function createHermesSource(payload: unknown): ConversationSource {
  return {
    name: 'hermes-post-llm-call',
    callsSince(_sinceMs: number): ChatCall[] {
      const parsedPayload = payloadSchema.safeParse(payload);
      if (!parsedPayload.success) return [];
      const raw = parsedPayload.data;
      const extra = raw.extra;
      if (!extra || typeof extra !== 'object') return [];

      let history: RawHistoryMessage[] = (extra.conversation_history ?? []).flatMap((entry) => {
        const parsed = historyMessageSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      });
      let lastUserIndex = -1;
      history.forEach((entry, index) => {
        if (!entry || typeof entry !== 'object') return;
        const msg = entry;
        if (msg.role === 'user' && (typeof msg.content === 'string' || (Array.isArray(msg.content) && msg.content.some((b) => b?.type === 'text')))) lastUserIndex = index;
      });
      let currentResponse: RawHistoryMessage | undefined;
      const hasCurrentAssistant = history.some((entry, index) => index > lastUserIndex && entry.role === 'assistant');
      // Untimestamped history without a real user boundary cannot be linked to this turn.
      if (lastUserIndex < 0) history = [];
      if ((lastUserIndex < 0 || !hasCurrentAssistant) && typeof extra.assistant_response === 'string' && extra.assistant_response) {
        currentResponse = { role: 'assistant', content: extra.assistant_response };
        history.push(currentResponse);
      }

      const nowMs = Date.now();
      const allAssistantIndices: number[] = [];
      history.forEach((entry, i) => {
        if (entry.role === 'assistant') {
          allAssistantIndices.push(i);
        }
      });
      const assistantIndices = allAssistantIndices;
      const occurrences = new Map<string, number>();

      const calls: ChatCall[] = assistantIndices.map((historyIndex, ordinal) => {
        const msg = history[historyIndex]!;
        const callId = stableCallId(msg, occurrences);
        const isLast = ordinal === assistantIndices.length - 1;

        const partials: PartialBlock[] = [...toThinkingAndText(msg, extra.model)];
        if (msg === currentResponse) {
          for (const block of partials) block.sourceId = 'assistant_response';
        }

        // assistant_response mirrors the latest history content, not an additional source block.
        if (isLast && !partials.some((b) => b.type === 'text') && typeof extra.assistant_response === 'string' && extra.assistant_response.length > 0) {
          const index = partials.length ? partials[partials.length - 1]!.index + 1 : 0;
          partials.push({ type: 'text', index, content: extra.assistant_response });
        }

        const offset = partials.length ? partials[partials.length - 1]!.index + 1 : 0;
        partials.push(...toToolUseBlocks(msg.tool_calls, offset));

        return {
          callId,
          source: 'hermes-post-llm-call',
          model: typeof extra.model === 'string' ? extra.model : undefined,
          startMs: nowMs,
          endMs: nowMs,
          timing: 'synthetic',
          stopReason: typeof msg.finish_reason === 'string' ? msg.finish_reason : undefined,
          blocks: partials,
          isSidechain: false,
        };
      });

      return calls.filter((_call, index) => assistantIndices[index]! > lastUserIndex);
    },
  };
}
