// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { fidelityForModel } from './shared.js';
import type { ChatCall, ContentBlock, ConversationSource } from './types.js';

const infoSchema = z.object({
  id: z.string().optional(), role: z.string().optional(), modelID: z.string().optional(), providerID: z.string().optional(),
  time: z.object({ created: z.number().finite().optional(), completed: z.number().finite().optional() }).passthrough().optional(),
  tokens: z.object({
    input: z.number().optional(), output: z.number().optional(), reasoning: z.number().optional(),
    cache: z.object({ read: z.number().optional(), write: z.number().optional() }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();
const partSchema = z.object({
  id: z.string().optional(), messageID: z.string().optional(), type: z.string().optional(),
  text: z.string().optional(), synthetic: z.boolean().optional(), callID: z.string().optional(),
  tool: z.string().optional(), state: z.object({ input: z.unknown().optional() }).passthrough().optional(),
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

/** opencode nests cache counts and adds a reasoning count, so `toUsage` does not fit. */
function usageFrom(tokens: unknown): ChatCall['usage'] {
  if (!tokens || typeof tokens !== 'object') return undefined;
  const t = tokens as Record<string, unknown>;
  const cache = (t.cache && typeof t.cache === 'object' ? t.cache : {}) as Record<string, unknown>;
  const out: NonNullable<ChatCall['usage']> = {};
  if (typeof t.input === 'number') out.input = t.input;
  if (typeof t.output === 'number') out.output = t.output;
  if (typeof cache.read === 'number') out.cacheRead = cache.read;
  if (typeof cache.write === 'number') out.cacheWrite = cache.write;
  if (typeof t.reasoning === 'number') out.reasoning = t.reasoning;
  return Object.keys(out).length > 0 ? out : undefined;
}

function serialiseInput(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}) ?? '{}';
  } catch {
    return '{}';
  }
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

function callFrom(id: string, acc: Accum, sinceMs: number): ChatCall | null {
  if (!acc.info) return null;
  const info = acc.info;
  const time = (info.time && typeof info.time === 'object'
    ? info.time : {}) as Record<string, unknown>;
  const startMs = typeof time.created === 'number' ? time.created : 0;
  if (startMs < sinceMs) return null;
  const completed = typeof time.completed === 'number' ? time.completed : undefined;

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
    } else if (p.type === 'tool' && typeof p.callID === 'string') {
      const state = (p.state && typeof p.state === 'object'
        ? p.state : {}) as Record<string, unknown>;
      blocks.push({
        type: 'tool_use', index, sourceId, content: '',
        toolUse: {
          id: p.callID,
          name: typeof p.tool === 'string' ? p.tool : 'unknown',
          input: serialiseInput(state.input),
        },
      });
    }
  }
  if (blocks.length === 0) return null;

  return {
    callId: id,
    source: 'opencode-events',
    model: typeof info.modelID === 'string' ? info.modelID : undefined,
    startMs,
    endMs: completed ?? startMs,
    timing: completed !== undefined ? 'exact' : 'inferred',
    usage: usageFrom(info.tokens),
    blocks,
    isSidechain: false,
  };
}

export function createOpenCodeSource(events: unknown[]): ConversationSource {
  return {
    name: 'opencode-events',
    callsSince(sinceMs: number): ChatCall[] {
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

      const calls: ChatCall[] = [];
      for (const id of order) {
        const acc = byId.get(id);
        if (!acc) continue;
        let call: ChatCall | null = null;
        try {
          call = callFrom(id, acc, sinceMs);
        } catch {
          continue;
        }
        if (call) calls.push(call);
      }
      return calls;
    },
  };
}
