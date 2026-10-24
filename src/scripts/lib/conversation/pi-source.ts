// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { readJsonlTail } from './read-jsonl.js';
import { fidelityForModel, sourceFingerprint } from './shared.js';
import type { AssistantMessage, ContentBlock, ConversationSource } from './types.js';

const blockSchema = z.object({
  type: z.string().optional(), text: z.string().optional(), thinking: z.string().optional(), id: z.string().optional(),
}).passthrough();
const entrySchema = z.object({
  type: z.string().optional(), id: z.string().optional(), timestamp: z.string().optional(),
  message: z.object({
    role: z.string().optional(), id: z.string().optional(), timestamp: z.number().finite().optional(),
    model: z.string().optional(), provider: z.string().optional(), stopReason: z.string().optional(),
    content: z.union([z.string(), z.array(z.unknown())]).optional(),
  }).passthrough().optional(),
}).passthrough();

/** One assistant entry and its observed source timestamp. */
interface PiAssistantEntry {
  msg: Record<string, unknown>;
  /** Unix ms — from `message.timestamp`, falling back to the entry's ISO stamp. */
  ts: number;
  /** The ENTRY's id (`m2`), which is where Pi puts it — not `message.id`. */
  entryId?: string;
}

function blocksFrom(content: unknown, model: unknown, provider: unknown): ContentBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', index: 0, content }] : [];
  if (!Array.isArray(content)) return [];
  const out: ContentBlock[] = [];
  for (const [index, raw] of content.entries()) {
    const parsed = blockSchema.safeParse(raw);
    if (!parsed.success) continue;
    const b = parsed.data;
    const sourceId = b.id;
    if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.length > 0) {
      out.push({
        type: 'thinking',
        index,
        content: b.thinking,
        sourceId,
        fidelity: fidelityForModel(model, provider),
      });
    } else if (b.type === 'text' && typeof b.text === 'string' && b.text.length > 0) {
      out.push({ type: 'text', index, content: b.text, sourceId });
    }
  }
  return out;
}

export function createPiSource(sessionFilePath?: string, events: unknown[] = []): ConversationSource {
  return {
    name: 'pi-session',
    messagesSince(sinceMs: number): AssistantMessage[] {
      const replay: unknown[] = sessionFilePath ? readJsonlTail(sessionFilePath).flatMap((line) => {
        try { return [JSON.parse(line) as unknown]; } catch { return []; }
      }) : [];
      const messages = new Map<string, AssistantMessage>();
      const observations = new Map<string, string>();
      const hostIds = new Map<string, string>();
      const collect = (entries: unknown[], fromEvents: boolean): void => {
        const assistants: PiAssistantEntry[] = [];
        for (const entry of entries) {
          const parsed = entrySchema.safeParse(entry);
          if (!parsed.success) continue;
          const e = parsed.data;
          if (e.type !== 'message') continue;
          const msg = e.message;
          if (!msg || typeof msg !== 'object' || msg.role !== 'assistant') continue;
          const ts =
            typeof msg.timestamp === 'number'
              ? msg.timestamp
              : Date.parse(String(e.timestamp ?? '')) || 0;
          assistants.push({
            msg,
            ts,
            entryId: typeof e.id === 'string' ? e.id : undefined,
          });
        }

        const occurrences = new Map<string, number>();
        assistants.forEach(({ msg, ts, entryId }) => {
          if (!fromEvents && ts < sinceMs) return;
          const observation = sourceFingerprint('pi', [ts, msg], occurrences);
          const messageId = typeof msg.id === 'string' && msg.id ? msg.id : undefined;
          const id = (entryId ? hostIds.get(entryId) : undefined)
            ?? (messageId ? hostIds.get(messageId) : undefined)
            ?? observations.get(observation) ?? entryId ?? messageId ?? observation;
          const blocks = blocksFrom(msg.content, msg.model, msg.provider);
          if (blocks.length === 0) return;
          observations.set(observation, id);
          if (entryId) hostIds.set(entryId, id);
          if (messageId) hostIds.set(messageId, id);
          messages.set(id, {
            id,
            source: fromEvents ? 'pi-message-events' : 'pi-session',
            timestampMs: ts,
            finishReason: typeof msg.stopReason === 'string' ? msg.stopReason : undefined,
            blocks,
            isSidechain: false,
          });
        });
      };
      collect(replay, false);
      collect(events, true);
      const result = [...messages.values()];
      const canOrderByTimestamp = result.every(message => (message.timestampMs ?? 0) > 0);
      if (canOrderByTimestamp) result.sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0));
      return result;
    },
  };
}
