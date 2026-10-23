// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { readJsonlTail } from './read-jsonl.js';
import type { ChatCall, ContentBlock, ConversationSource } from './types.js';
import { sourceFingerprint } from './shared.js';

const contentBlockSchema = z.object({
  type: z.string().optional(), thinking: z.string().optional(), text: z.string().optional(),
  id: z.string().optional(), name: z.string().optional(), input: z.unknown().optional(),
}).passthrough();
const usageSchema = z.object({
  input_tokens: z.number().optional(), output_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional(), cache_read_input_tokens: z.number().optional(),
}).passthrough();
const entrySchema = z.object({
  type: z.string().optional(), uuid: z.string().optional(), timestamp: z.string().optional(),
  requestId: z.string().optional(), isSidechain: z.boolean().optional(),
  message: z.object({
    id: z.string().optional(), model: z.string().optional(), stop_reason: z.string().optional(),
    usage: usageSchema.optional(), content: z.array(contentBlockSchema).optional(),
  }).passthrough().optional(),
}).passthrough();
const recordSchema = z.record(z.unknown());
type RawEntry = z.infer<typeof entrySchema>;
type RawContentBlock = z.infer<typeof contentBlockSchema>;
type RawUsage = z.infer<typeof usageSchema>;

type PartialBlock = ContentBlock;

function toBlocks(content: RawContentBlock[] | undefined): ContentBlock[] {
  if (!Array.isArray(content)) return [];

  const partials: PartialBlock[] = [];
  for (const [index, b] of content.entries()) {
    if (!b || typeof b !== 'object') continue;
    switch (b.type) {
      case 'thinking':
        if (typeof b.thinking === 'string') {
          partials.push({ type: 'thinking', index, content: b.thinking, fidelity: 'full' });
        }
        break;
      case 'text':
        if (typeof b.text === 'string') {
          partials.push({ type: 'text', index, content: b.text });
        }
        break;
      case 'tool_use':
        if (typeof b.id === 'string' && typeof b.name === 'string') {
          const input = b.input !== undefined ? JSON.stringify(b.input) : '{}';
          partials.push({
            type: 'tool_use',
            index,
            content: input,
            toolUse: { id: b.id, name: b.name, input },
          });
        }
        break;
      default:
        break;
    }
  }
  return partials;
}

function toUsage(usage: RawUsage | undefined): ChatCall['usage'] | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const out: NonNullable<ChatCall['usage']> = {};
  if (typeof usage.input_tokens === 'number') out.input = usage.input_tokens;
  if (typeof usage.output_tokens === 'number') out.output = usage.output_tokens;
  if (typeof usage.cache_read_input_tokens === 'number') out.cacheRead = usage.cache_read_input_tokens;
  if (typeof usage.cache_creation_input_tokens === 'number') out.cacheWrite = usage.cache_creation_input_tokens;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Converts one transcript line to a call. Returns null for non-assistant lines. */
function toCall(entry: RawEntry, occurrences: Map<string, number>): ChatCall | null {
  if (entry.type !== 'assistant' || !entry.message) return null;
  const msg = entry.message;

  const parsedMs = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
  const ms = Number.isFinite(parsedMs) ? parsedMs : 0;

  const callId = entry.requestId || msg.id || sourceFingerprint('cc', entry, occurrences);

  return {
    callId,
    source: 'claude-code-transcript',
    model: typeof msg.model === 'string' ? msg.model : undefined,
    startMs: ms,
    endMs: ms,
    timing: 'synthetic',
    usage: toUsage(msg.usage),
    stopReason: typeof msg.stop_reason === 'string' ? msg.stop_reason : undefined,
    blocks: toBlocks(msg.content).map((block) => ({ ...block, ...(entry.uuid ? { sourceId: `${entry.uuid}:${block.index}` } : {}) })),
    isSidechain: entry.isSidechain === true,
  };
}

function applyTiming(calls: ChatCall[]): void {
  for (let i = 0; i < calls.length - 1; i++) {
    calls[i].endMs = calls[i + 1].startMs;
    calls[i].timing = 'inferred';
  }
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
    callsSince(sinceMs: number): ChatCall[] {
      const lines = readJsonlTail(transcriptPath);
      const calls: ChatCall[] = [];
      const occurrences = new Map<string, number>();
      const byId = new Map<string, ChatCall>();
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
        if (!entry || typeof entry !== 'object') return;
        if (entry.uuid && seenEntries.has(entry.uuid)) return;
        if (entry.uuid) seenEntries.add(entry.uuid);
        const call = toCall(entry, occurrences);
        if (!call) return;
        const prior = byId.get(call.callId);
        if (prior) {
          const offset = prior.blocks.length ? prior.blocks[prior.blocks.length - 1]!.index + 1 : 0;
          prior.blocks.push(...call.blocks.map((block) => ({ ...block, index: block.index + offset })));
          prior.usage = call.usage ? { ...prior.usage, ...call.usage } : prior.usage;
          prior.stopReason = call.stopReason ?? prior.stopReason;
        } else {
          byId.set(call.callId, call);
          calls.push(call);
        }
      });
      applyTiming(calls);

      return calls.filter((c) => c.startMs >= sinceMs);
    },
  };
}
