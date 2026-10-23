// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { readJsonlTail } from './read-jsonl.js';
import { fidelityForModel, sourceFingerprint, toUsage } from './shared.js';
import type { ChatCall, ContentBlock, ConversationSource } from './types.js';

const blockSchema = z.object({
  type: z.string().optional(), text: z.string().optional(), thinking: z.string().optional(),
  id: z.string().optional(), name: z.string().optional(), arguments: z.unknown().optional(),
}).passthrough();
const entrySchema = z.object({
  type: z.string().optional(), id: z.string().optional(), timestamp: z.string().optional(),
  message: z.object({
    role: z.string().optional(), id: z.string().optional(), timestamp: z.number().finite().optional(),
    model: z.string().optional(), provider: z.string().optional(), stopReason: z.string().optional(),
    content: z.array(z.unknown()).optional(), usage: z.record(z.unknown()).optional(),
  }).passthrough().optional(),
}).passthrough();

/** One assistant entry, flattened to what call construction needs. */
interface PiAssistantEntry {
  msg: Record<string, unknown>;
  /** Unix ms — from `message.timestamp`, falling back to the entry's ISO stamp. */
  ts: number;
  /** The ENTRY's id (`m2`), which is where Pi puts it — not `message.id`. */
  entryId?: string;
}

function blocksFrom(content: unknown, model: unknown, provider: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  const out: ContentBlock[] = [];
  for (const [index, raw] of content.entries()) {
    const parsed = blockSchema.safeParse(raw);
    if (!parsed.success) continue;
    const b = parsed.data;
    if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.length > 0) {
      out.push({
        type: 'thinking',
        index,
        content: b.thinking,
        fidelity: fidelityForModel(model, provider),
      });
    } else if (b.type === 'text' && typeof b.text === 'string' && b.text.length > 0) {
      out.push({ type: 'text', index, content: b.text });
    } else if (b.type === 'toolCall' && typeof b.id === 'string' && typeof b.name === 'string') {
      let input = '';
      try { input = JSON.stringify(b.arguments ?? {}); } catch {
        // The association is still observable when an SDK object cannot serialize.
      }
      out.push({
        type: 'tool_use',
        index,
        content: '',
        toolUse: { id: b.id, name: b.name, input },
      });
    }
  }
  return out;
}

export function createPiSource(sessionFilePath?: string, events: unknown[] = []): ConversationSource {
  return {
    name: 'pi-session',
    callsSince(sinceMs: number): ChatCall[] {
      const replay: unknown[] = sessionFilePath ? readJsonlTail(sessionFilePath).flatMap((line) => {
        try { return [JSON.parse(line) as unknown]; } catch { return []; }
      }) : [];
      const entries = replay.length > 0 ? replay : events;
      const fromEvents = entries === events;
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

      const calls: ChatCall[] = [];
      const occurrences = new Map<string, number>();
      const emitted = new Set<string>();
      assistants.forEach(({ msg, ts, entryId }, i) => {
        const callId = entryId ?? (typeof msg.id === 'string' ? msg.id : sourceFingerprint('pi', [ts, msg], occurrences));
        if ((!fromEvents && ts < sinceMs) || emitted.has(callId)) return;
        emitted.add(callId);
        const blocks = blocksFrom(msg.content, msg.model, msg.provider);
        if (blocks.length === 0) return;
        const next = assistants[i + 1];
        calls.push({
          callId,
          source: fromEvents ? 'pi-message-events' : 'pi-session',
          model: typeof msg.model === 'string' ? msg.model : undefined,
          startMs: ts,
          endMs: next ? next.ts : ts,
          timing: next ? 'inferred' : 'synthetic',
          usage: toUsage(msg.usage),
          stopReason: typeof msg.stopReason === 'string' ? msg.stopReason : undefined,
          blocks,
          isSidechain: false,
        });
      });
      return calls;
    },
  };
}
