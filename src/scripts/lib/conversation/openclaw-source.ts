// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import type { ChatCall, ContentBlock, ConversationSource } from './types.js';
import { fidelityForModel, sourceFingerprint, toUsage } from './shared.js';


const blockSchema = z.object({
  type: z.string().optional(), id: z.string().optional(), name: z.string().optional(),
  text: z.string().optional(), thinking: z.string().optional(), input: z.unknown().optional(), arguments: z.unknown().optional(),
}).passthrough();
const assistantSchema = z.object({
  id: z.string().optional(), content: z.array(z.unknown()).optional(),
  reasoning: z.string().optional(), reasoning_content: z.string().optional(), usage: z.record(z.unknown()).optional(),
}).passthrough();
const envelopeSchema = z.object({
  hook: z.string(),
  event: z.object({
    callId: z.string().optional(), model: z.string().optional(), provider: z.string().optional(),
    content: z.array(z.unknown()).optional(), lastAssistant: assistantSchema.optional(),
    reasoning: z.string().optional(), reasoning_content: z.string().optional(),
    assistantTexts: z.array(z.unknown()).optional(), durationMs: z.number().finite().optional(),
    usage: z.record(z.unknown()).optional(), outcome: z.string().optional(),
  }).passthrough(),
}).passthrough();
/**
 * Only content exposed on an llm_output event is attributable to that call.
 * Standalone reasoning/messages without exact call IDs cannot establish a link.
 * assistantTexts/usage are optional host supplements; missing content is not invented.
 */
export function createOpenClawSource(events: unknown[]): ConversationSource {
  return {
    name: 'openclaw-event-stream',
    callsSince(_sinceMs: number): ChatCall[] {
      if (!Array.isArray(events)) return [];
      const calls = new Map<string, ChatCall>();
      const occurrences = new Map<string, number>();
      const now = Date.now();
      for (const raw of events) {
        if (!raw || typeof raw !== 'object') continue;
        try {
          const parsed = envelopeSchema.safeParse(raw);
          if (!parsed.success || parsed.data.hook !== 'llm_output') continue;
          const e = parsed.data.event;
          const assistant = e.lastAssistant ?? {};
          const callId = typeof e.callId === 'string' && e.callId ? e.callId
            : typeof assistant.id === 'string' && assistant.id ? assistant.id : sourceFingerprint('openclaw', e, occurrences);
          const content = Array.isArray(assistant.content) ? assistant.content : e.content;
          const blocks: ContentBlock[] = [];
          const fidelity = fidelityForModel(e.model, e.provider);
          if (Array.isArray(content)) {
            for (const [index, rawBlock] of content.entries()) {
              const parsedBlock = blockSchema.safeParse(rawBlock);
              if (!parsedBlock.success) continue;
              const b = parsedBlock.data;
              const sourceId = typeof b.id === 'string' ? b.id : undefined;
              if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking) {
                blocks.push({ type: 'thinking', index, sourceId, content: b.thinking, fidelity });
              } else if (b.type === 'text' && typeof b.text === 'string' && b.text) {
                blocks.push({ type: 'text', index, sourceId, content: b.text });
              } else if ((b.type === 'tool_use' || b.type === 'toolCall') && typeof b.id === 'string' && typeof b.name === 'string') {
                const input = JSON.stringify(b.input ?? b.arguments ?? {});
                blocks.push({ type: 'tool_use', index, sourceId, content: input, toolUse: { id: b.id, name: b.name, input } });
              }
            }
          } else {
            const reasoning = typeof assistant.reasoning_content === 'string' ? assistant.reasoning_content
              : typeof assistant.reasoning === 'string' ? assistant.reasoning
              : typeof e.reasoning_content === 'string' ? e.reasoning_content : e.reasoning;
            if (typeof reasoning === 'string' && reasoning) blocks.push({ type: 'thinking', index: 0, content: reasoning, fidelity });
            const offset = blocks.length;
            if (Array.isArray(e.assistantTexts)) {
              e.assistantTexts.forEach((text, index) => {
                if (typeof text === 'string' && text) blocks.push({ type: 'text', index: offset + index, content: text });
              });
            }
          }
          const duration = typeof e.durationMs === 'number' ? Math.max(0, e.durationMs) : 0;
          calls.set(callId, {
            callId,
            source: 'openclaw-event-stream',
            model: typeof e.model === 'string' ? e.model : undefined,
            startMs: now,
            endMs: now + duration,
            timing: 'synthetic',
            usage: toUsage(e.usage ?? assistant.usage),
            stopReason: typeof e.outcome === 'string' ? e.outcome : undefined,
            blocks,
            isSidechain: false,
          });
        } catch {
          // One malformed host event must not discard other observed calls.
        }
      }
      return [...calls.values()];
    },
  };
}
