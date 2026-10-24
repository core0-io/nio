// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { readJsonlTail } from './read-jsonl.js';
import type { AssistantMessage, ContentBlock, ConversationSource } from './types.js';
import { sourceFingerprint } from './shared.js';

const contentBlockSchema = z.object({
  type: z.string().optional(), thinking: z.string().optional(), text: z.string().optional(),
  id: z.string().optional(),
}).passthrough();
const entrySchema = z.object({
  type: z.string().optional(), uuid: z.string().optional(), timestamp: z.string().optional(),
  isSidechain: z.boolean().optional(),
  message: z.object({
    id: z.string().optional(), stop_reason: z.string().optional(),
    content: z.array(z.unknown()).optional(),
  }).passthrough().optional(),
}).passthrough();
const recordSchema = z.record(z.unknown());
type RawEntry = z.infer<typeof entrySchema>;

function toBlocks(content: unknown[] | undefined): ContentBlock[] {
  if (!Array.isArray(content)) return [];

  const partials: ContentBlock[] = [];
  for (const [index, raw] of content.entries()) {
    const parsed = contentBlockSchema.safeParse(raw);
    if (!parsed.success) continue;
    const b = parsed.data;
    switch (b.type) {
      case 'thinking':
        if (typeof b.thinking === 'string') {
          partials.push({ type: 'thinking', index, sourceId: b.id, content: b.thinking, fidelity: 'full' });
        }
        break;
      case 'text':
        if (typeof b.text === 'string') {
          partials.push({ type: 'text', index, sourceId: b.id, content: b.text });
        }
        break;
      default:
        break;
    }
  }
  return partials;
}


/** Converts one transcript message, without inventing model-call boundaries. */
function toMessage(entry: RawEntry, occurrences: Map<string, number>): AssistantMessage | null {
  // Child content has no existing child-turn routing here; never attach it to the parent.
  if (entry.type !== 'assistant' || !entry.message || entry.isSidechain === true) return null;
  const msg = entry.message;

  const parsedMs = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
  const ms = Number.isFinite(parsedMs) ? parsedMs : 0;

  const id = msg.id || entry.uuid || sourceFingerprint('cc', entry, occurrences);

  return {
    id,
    source: 'claude-code-transcript',
    timestampMs: ms,
    finishReason: typeof msg.stop_reason === 'string' ? msg.stop_reason : undefined,
    blocks: toBlocks(msg.content).map((block) => ({ ...block, ...(!block.sourceId && entry.uuid ? { sourceId: `${entry.uuid}:${block.index}` } : {}) })),
  };
}


export interface UserPrompt {
  text: string;
  id: string;
  blocks?: { text: string; index: number; sourceId?: string }[];
}

function userMessageContent(content: unknown): Pick<UserPrompt, 'text' | 'blocks'> {
  if (typeof content === 'string') return { text: content };
  if (!Array.isArray(content)) return { text: '' };
  const blocks: NonNullable<UserPrompt['blocks']> = [];
  for (const [index, raw] of content.entries()) {
    const parsed = recordSchema.safeParse(raw);
    if (!parsed.success) continue;
    const block = parsed.data;
    if ((block.type === 'text' || block.type === 'input_text') && typeof block.text === 'string') {
      blocks.push({ text: block.text, index, ...(typeof block.id === 'string' && block.id ? { sourceId: block.id } : {}) });
    }
  }
  return { text: blocks.map((block) => block.text).join('\n'), blocks };
}

/** Reads actual user input, excluding tool results, injected context and subagent messages. */
export function lastUserPromptSince(transcriptPath: string, sinceMs: number): UserPrompt | null {
  let latest: (UserPrompt & { ms: number }) | null = null;
  const occurrences = new Map<string, number>();
  for (const line of readJsonlTail(transcriptPath)) {
    try {
      const parsed = recordSchema.safeParse(JSON.parse(line));
      if (!parsed.success) continue;
      const entry = parsed.data;
      if (entry.isSidechain === true || entry.isMeta === true) continue;
      const payloadResult = recordSchema.safeParse(entry.payload);
      const messageResult = recordSchema.safeParse(entry.message);
      const payload = payloadResult.success ? payloadResult.data : undefined;
      const msg = messageResult.success ? messageResult.data : undefined;
      let content: Pick<UserPrompt, 'text' | 'blocks'> = { text: '' };
      if (entry.type === 'user' && msg) content = userMessageContent(msg.content);
      else if (entry.type === 'event_msg' && payload?.type === 'user_message') {
        content = { text: typeof payload.message === 'string' ? payload.message : '' };
      } else if (entry.type === 'response_item' && payload?.type === 'message' && payload.role === 'user') {
        content = userMessageContent(payload.content);
      }
      const { text, blocks } = content;
      if (!text.trim()) continue;
      const ms = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
      if (!Number.isFinite(ms)) continue;
      const hostId = [entry.uuid, entry.prompt_id, entry.id, msg?.id, payload?.id, payload?.prompt_id]
        .find((id): id is string => typeof id === 'string' && id.length > 0);
      const id = hostId ?? sourceFingerprint('prompt', [entry.timestamp, text], occurrences);
      if (ms >= sinceMs && (!latest || ms >= latest.ms)) latest = { ms, text, id, ...(blocks ? { blocks } : {}) };
    } catch {
      // Ignore malformed lines while retaining surrounding user input.
    }
  }
  return latest ? { text: latest.text, id: latest.id, ...(latest.blocks ? { blocks: latest.blocks } : {}) } : null;
}

export function createClaudeCodeSource(transcriptPath: string): ConversationSource {
  return {
    name: 'claude-code-transcript',
    messagesSince(sinceMs: number): AssistantMessage[] {
      const lines = readJsonlTail(transcriptPath);
      const messages: AssistantMessage[] = [];
      const occurrences = new Map<string, number>();
      const byId = new Map<string, AssistantMessage>();
      const seenEntries = new Set<string>();

      lines.forEach((line) => {
        let entry: RawEntry;
        try {
          const parsed = entrySchema.safeParse(JSON.parse(line));
          if (!parsed.success) return;
          entry = parsed.data;
        } catch {
          return; // malformed line: skip, don't abort the rest of the file
        }
        if (!entry || typeof entry !== 'object' || entry.isSidechain === true) return;
        if (entry.uuid && seenEntries.has(entry.uuid)) return;
        if (entry.uuid) seenEntries.add(entry.uuid);
        const message = toMessage(entry, occurrences);
        if (!message) return;
        const prior = byId.get(message.id);
        if (prior) {
          const offset = prior.blocks.length ? prior.blocks[prior.blocks.length - 1]!.index + 1 : 0;
          prior.blocks.push(...message.blocks.map((block) => ({ ...block, index: block.index + offset })));
          prior.finishReason = message.finishReason ?? prior.finishReason;
        } else {
          byId.set(message.id, message);
          messages.push(message);
        }
      });
      return messages.filter((message) => (message.timestampMs ?? 0) >= sinceMs);
    },
  };
}
