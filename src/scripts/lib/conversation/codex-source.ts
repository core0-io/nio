// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { readJsonlTail } from './read-jsonl.js';
import type { AssistantMessage, ContentBlock, ConversationSource } from './types.js';
import { sourceFingerprint } from './shared.js';

const partSchema = z.object({ type: z.string().optional(), text: z.string().optional() }).passthrough();
const entrySchema = z.object({
  type: z.string().optional(), timestamp: z.string().optional(),
  payload: z.object({
    type: z.string().optional(), id: z.string().optional(), role: z.string().optional(),
    summary: z.array(z.unknown()).optional(), content: z.array(z.unknown()).optional(),
  }).passthrough().optional(),
}).passthrough();

/** Rollout response items expose partial output, not complete invocation boundaries.
 * Keep each real message/reasoning item identity; never attach a later message to
 * a preceding reasoning item merely because it is adjacent. Encrypted reasoning,
 * function calls/results, token counters and non-assistant input are not content.
 */
export function createCodexSource(rolloutPath: string): ConversationSource {
  return {
    name: 'codex-rollout',
    messagesSince(sinceMs: number): AssistantMessage[] {
      const messages: AssistantMessage[] = [];
      const seen = new Set<string>();
      const occurrences = new Map<string, number>();
      for (const line of readJsonlTail(rolloutPath)) {
        try {
          const parsed = entrySchema.safeParse(JSON.parse(line));
          if (!parsed.success || parsed.data.type !== 'response_item') continue;
          const entry = parsed.data;
          const item = entry.payload;
          if (!item || (item.type !== 'reasoning' && (item.type !== 'message' || item.role !== 'assistant'))) continue;
          const ms = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
          const timestampMs = Number.isFinite(ms) ? ms : 0;
          if (timestampMs < sinceMs) continue;
          const blocks: ContentBlock[] = [];
          const rawParts = item.type === 'reasoning' ? item.summary : item.content;
          for (const [index, raw] of (rawParts ?? []).entries()) {
            const part = partSchema.safeParse(raw);
            if (!part.success || typeof part.data.text !== 'string' || !part.data.text) continue;
            if (item.type === 'reasoning' && part.data.type !== 'summary_text') continue;
            if (item.type === 'message' && part.data.type !== undefined && part.data.type !== 'output_text' && part.data.type !== 'text') continue;
            blocks.push({
              type: item.type === 'reasoning' ? 'thinking' : 'text', index, content: part.data.text,
              ...(item.type === 'reasoning' ? { fidelity: 'summary' as const } : {}),
              ...(item.id ? { sourceId: `${item.id}:${index}` } : {}),
            });
          }
          if (!blocks.length) continue;
          const id = item.id || sourceFingerprint('codex', entry, occurrences);
          if (seen.has(id)) continue;
          seen.add(id);
          messages.push({ id, source: 'codex-rollout', timestampMs, blocks });
        } catch {
          // Malformed entries must not discard valid surrounding messages.
        }
      }
      return messages;
    },
  };
}
