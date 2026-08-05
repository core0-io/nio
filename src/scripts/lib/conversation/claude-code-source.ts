// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Claude Code transcript → ChatCall[].
 *
 * Each `assistant` line in a Claude Code transcript is already exactly
 * one LLM call — the platform writes one JSON object per API response,
 * so there is no boundary to infer (contrast with Codex, whose flat
 * `response_item` stream needs the reasoning-entry heuristic in
 * `codex-source.ts`). This module is a straight per-line map.
 *
 * Claude models return their full reasoning trace verbatim, so every
 * `thinking` block here is `fidelity: 'full'` — never `'summary'`. That
 * is the one property this module must never get casually "simplified"
 * away, since it's the signal downstream consumers use to tell a real
 * chain-of-thought apart from a step-title summary (see
 * `ThinkingFidelity` in `types.ts`).
 */

import { readJsonlTail } from './read-jsonl.js';
import type { ChatCall, ContentBlock, ConversationSource } from './types.js';

interface RawContentBlock {
  type?: string;
  thinking?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface RawMessage {
  id?: string;
  model?: string;
  stop_reason?: string;
  usage?: RawUsage;
  content?: RawContentBlock[];
}

interface RawEntry {
  type?: string;
  timestamp?: string;
  requestId?: string;
  isSidechain?: boolean;
  message?: RawMessage;
}

type PartialBlock = Omit<ContentBlock, 'index'>;

/**
 * Maps `message.content[]` to blocks, skipping block types this layer
 * doesn't know about. Unknown types are filtered out *before* indices
 * are assigned, so `index` always stays zero-based and contiguous
 * (`blockOrderIsSane`) even if a future content-block type shows up.
 */
function toBlocks(content: RawContentBlock[] | undefined): ContentBlock[] {
  if (!Array.isArray(content)) return [];

  const partials: PartialBlock[] = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    switch (b.type) {
      case 'thinking':
        if (typeof b.thinking === 'string') {
          partials.push({ type: 'thinking', content: b.thinking, fidelity: 'full' });
        }
        break;
      case 'text':
        if (typeof b.text === 'string') {
          partials.push({ type: 'text', content: b.text });
        }
        break;
      case 'tool_use':
        if (typeof b.id === 'string' && typeof b.name === 'string') {
          const input = b.input !== undefined ? JSON.stringify(b.input) : '{}';
          partials.push({
            type: 'tool_use',
            content: input,
            toolUse: { id: b.id, name: b.name, input },
          });
        }
        break;
      default:
        // Unknown block type: drop it, don't disturb neighbouring indices.
        break;
    }
  }
  return partials.map((b, index) => ({ ...b, index }));
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
function toCall(entry: RawEntry, ordinal: number): ChatCall | null {
  if (entry.type !== 'assistant' || !entry.message) return null;
  const msg = entry.message;

  const parsedMs = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
  const ms = Number.isFinite(parsedMs) ? parsedMs : 0;

  const callId = entry.requestId || (msg.id ? `msg_${msg.id}` : `cc-${ordinal}`);

  return {
    callId,
    model: typeof msg.model === 'string' ? msg.model : undefined,
    startMs: ms,
    // Transcripts don't record a call's end time; the span layer
    // corrects this using the next call's start (or turn end).
    endMs: ms,
    usage: toUsage(msg.usage),
    stopReason: typeof msg.stop_reason === 'string' ? msg.stop_reason : undefined,
    blocks: toBlocks(msg.content),
    isSidechain: entry.isSidechain === true,
  };
}

export function createClaudeCodeSource(transcriptPath: string): ConversationSource {
  return {
    name: 'claude-code-transcript',
    callsSince(sinceMs: number): ChatCall[] {
      const lines = readJsonlTail(transcriptPath);
      const calls: ChatCall[] = [];

      lines.forEach((line, i) => {
        let entry: RawEntry;
        try {
          entry = JSON.parse(line) as RawEntry;
        } catch {
          return; // malformed line: skip, don't abort the rest of the file
        }
        // JSON.parse succeeds (and returns null) for a line that's just
        // the literal `null`, and succeeds with a non-object for a bare
        // string/number/array line too — none of those throw above, so
        // this guard is the only thing standing between a stray `null`
        // line and a TypeError on `entry.type` that would abort every
        // call still left in the file. Mirrors hermes-source.ts /
        // openclaw-source.ts's entry guards.
        if (!entry || typeof entry !== 'object') return;
        const call = toCall(entry, i);
        if (call) calls.push(call);
      });

      return calls.filter((c) => c.startMs >= sinceMs);
    },
  };
}
