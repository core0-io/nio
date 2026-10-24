// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { fidelityForModel } from './shared.js';
import type { AssistantMessage, ContentBlock, ConversationSource } from './types.js';

const infoSchema = z.object({
  id: z.string().optional(), role: z.string().optional(), modelID: z.string().optional(), providerID: z.string().optional(),
  time: z.object({ created: z.number().finite().optional() }).passthrough().optional(),
}).passthrough();
const partSchema = z.object({
  id: z.string().optional(), messageID: z.string().optional(), type: z.string().optional(),
  text: z.string().optional(), synthetic: z.boolean().optional(),
}).passthrough();
const eventSchema = z.object({
  kind: z.string().optional(), info: infoSchema.optional(), part: partSchema.optional(),
}).passthrough();

interface Accum {
  /** Latest `message.updated` envelope; undefined until one arrives. */
  info?: Record<string, unknown>;
  /** Parts in first-seen order, each holding its latest snapshot. */
  parts: Array<Record<string, unknown>>;
  /** Part id → index into `parts`, for in-place snapshot replacement. */
  partIndexById: Map<string, number>;
}


function ensure(byId: Map<string, Accum>, order: string[], id: string): Accum {
  let acc = byId.get(id);
  if (!acc) {
    acc = { parts: [], partIndexById: new Map() };
    byId.set(id, acc);
    order.push(id);
  }
  return acc;
}

function messageFrom(id: string, acc: Accum, sinceMs: number): AssistantMessage | null {
  if (!acc.info) return null;
  const info = acc.info;
  const time = (info.time && typeof info.time === 'object'
    ? info.time : {}) as Record<string, unknown>;
  const startMs = typeof time.created === 'number' ? time.created : 0;
  if (startMs < sinceMs) return null;

  const blocks: ContentBlock[] = [];
  for (const [index, p] of acc.parts.entries()) {
    const sourceId = typeof p.id === 'string' ? p.id : undefined;
    if (p.type === 'reasoning' && typeof p.text === 'string' && p.text.length > 0) {
      blocks.push({
        type: 'thinking', index, sourceId, content: p.text,
        fidelity: fidelityForModel(info.modelID, info.providerID),
      });
    } else if (
      p.type === 'text' && typeof p.text === 'string' && p.text.length > 0
      && p.synthetic !== true
    ) {
      blocks.push({ type: 'text', index, sourceId, content: p.text });
    }
  }
  if (blocks.length === 0) return null;

  return {
    id,
    source: 'opencode-events',
    timestampMs: startMs,
    blocks,
  };
}

export function createOpenCodeSource(events: unknown[]): ConversationSource {
  return {
    name: 'opencode-events',
    messagesSince(sinceMs: number): AssistantMessage[] {
      if (!Array.isArray(events)) return [];
      const byId = new Map<string, Accum>();
      const order: string[] = [];

      for (const raw of events) {
        if (!raw || typeof raw !== 'object') continue;
        try {
          const parsed = eventSchema.safeParse(raw);
          if (!parsed.success) continue;
          const e = parsed.data;
          if (e.kind === 'message') {
            const info = e.info;
            if (!info || typeof info !== 'object' || info.role !== 'assistant') continue;
            const id = typeof info.id === 'string' ? info.id : undefined;
            if (!id) continue;
            ensure(byId, order, id).info = info;
          } else if (e.kind === 'part') {
            const part = e.part;
            if (!part || typeof part !== 'object') continue;
            const mid = typeof part.messageID === 'string' ? part.messageID : undefined;
            if (!mid) continue;
            const acc = ensure(byId, order, mid);
            const pid = typeof part.id === 'string' ? part.id : undefined;
            const at = pid !== undefined ? acc.partIndexById.get(pid) : undefined;
            if (at !== undefined) {
              acc.parts[at] = part;
            } else {
              if (pid !== undefined) acc.partIndexById.set(pid, acc.parts.length);
              acc.parts.push(part);
            }
          }
        } catch {
          continue;
        }
      }

      const messages: AssistantMessage[] = [];
      for (const id of order) {
        const acc = byId.get(id);
        if (!acc) continue;
        let message: AssistantMessage | null = null;
        try {
          message = messageFrom(id, acc, sinceMs);
        } catch {
          continue;
        }
        if (message) messages.push(message);
      }
      return messages;
    },
  };
}
