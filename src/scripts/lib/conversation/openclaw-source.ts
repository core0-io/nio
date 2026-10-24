// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import type { AssistantMessage, ContentBlock, ConversationSource } from './types.js';
import { fidelityForModel, sourceFingerprint } from './shared.js';


const blockSchema = z.object({
  type: z.string().optional(), id: z.string().optional(),
  text: z.string().optional(), thinking: z.string().optional(),
}).passthrough();
const assistantSchema = z.object({
  id: z.string().optional(), content: z.union([z.string(), z.array(z.unknown())]).optional(),
  reasoning: z.string().optional(), reasoning_content: z.string().optional(), stopReason: z.string().optional(),
}).passthrough();
const envelopeSchema = z.object({
  hook: z.string(),
  event: z.object({
    callId: z.string().optional(), model: z.string().optional(), provider: z.string().optional(),
    lastAssistant: assistantSchema.optional(),
  }).passthrough(),
}).passthrough();
/**
 * Capture only observed llm_output content, with no inferred invocation span.
 * Native message IDs take precedence over model-callback IDs for replay identity.
 * Aggregate assistantTexts have no message boundaries and are not captured here.
 */
export function createOpenClawSource(events: unknown[]): ConversationSource {
  return {
    name: 'openclaw-event-stream',
    messagesSince(_sinceMs: number): AssistantMessage[] {
      if (!Array.isArray(events)) return [];
      const messages = new Map<string, AssistantMessage>();
      const occurrences = new Map<string, number>();
      for (const raw of events) {
        if (!raw || typeof raw !== 'object') continue;
        try {
          const parsed = envelopeSchema.safeParse(raw);
          if (!parsed.success || parsed.data.hook !== 'llm_output') continue;
          const e = parsed.data.event;
          const assistant = e.lastAssistant;
          if (!assistant) continue;
          const id = typeof assistant.id === 'string' && assistant.id ? assistant.id
            : typeof e.callId === 'string' && e.callId ? e.callId : sourceFingerprint('openclaw', e, occurrences);
          const content = assistant.content;
          const blocks: ContentBlock[] = [];
          const fidelity = fidelityForModel(e.model, e.provider);
          const hasInlineThinking = Array.isArray(content) && content.some((rawBlock) => {
            const parsedBlock = blockSchema.safeParse(rawBlock);
            return parsedBlock.success && parsedBlock.data.type === 'thinking' && !!parsedBlock.data.thinking;
          });
          if (!hasInlineThinking) {
            const reasoning = assistant.reasoning_content || assistant.reasoning;
            if (reasoning) blocks.push({ type: 'thinking', index: 0, content: reasoning, fidelity });
          }
          const offset = blocks.length;
          if (Array.isArray(content)) {
            for (const [sourceIndex, rawBlock] of content.entries()) {
              const parsedBlock = blockSchema.safeParse(rawBlock);
              if (!parsedBlock.success) continue;
              const b = parsedBlock.data;
              const sourceId = typeof b.id === 'string' ? b.id : undefined;
              const index = offset + sourceIndex;
              if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking) {
                blocks.push({ type: 'thinking', index, sourceId, content: b.thinking, fidelity });
              } else if (b.type === 'text' && typeof b.text === 'string' && b.text) {
                blocks.push({ type: 'text', index, sourceId, content: b.text });
              }
            }
          } else if (typeof content === 'string' && content) {
            blocks.push({ type: 'text', index: offset, content });
          }
          if (blocks.length === 0) continue;
          messages.set(id, {
            id,
            source: 'openclaw-event-stream',
            finishReason: assistant.stopReason,
            blocks,
            isSidechain: false,
          });
        } catch {
          // One malformed host event must not discard other observed messages.
        }
      }
      return [...messages.values()];
    },
  };
}
