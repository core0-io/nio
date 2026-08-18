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
    // Transcripts don't record a call's end time. `applyTiming` below
    // corrects every call but the last using the next call's start;
    // this default (equal to startMs, synthetic) only survives for the
    // final call in the batch, which has no successor to borrow from.
    endMs: ms,
    timing: 'synthetic',
    usage: toUsage(msg.usage),
    stopReason: typeof msg.stop_reason === 'string' ? msg.stop_reason : undefined,
    blocks: toBlocks(msg.content),
    isSidechain: entry.isSidechain === true,
  };
}

/**
 * Derives an end time for every call but the last from its successor's
 * start — the one piece of real information a per-line transcript can
 * offer about how long a call ran, since Claude Code never records a
 * call's actual completion time (see module doc). The last call in the
 * batch has no successor to borrow from, so it keeps `endMs === startMs`
 * and `timing: 'synthetic'` from `toCall`.
 */
function applyTiming(calls: ChatCall[]): void {
  for (let i = 0; i < calls.length - 1; i++) {
    calls[i].endMs = calls[i + 1].startMs;
    calls[i].timing = 'inferred';
  }
}

interface RawUserEntry {
  type?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  message?: { role?: string; content?: unknown };
}

/**
 * Flattens a `user` message's content to plain text.
 *
 * Content is either a bare string (how Claude Code stores a typed
 * prompt — 19 of 19 real prompts in the transcripts sampled) or a block
 * array. Only `text` blocks contribute: the overwhelming majority of
 * `type: 'user'` lines in a transcript are tool RESULTS (154 of 187
 * sampled), which carry `tool_result` blocks and must flatten to the
 * empty string so `lastUserMessageSince` skips them.
 */
function userMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    const block = b as { type?: string; text?: string };
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * The most recent user message at or after `sinceMs`.
 *
 * Claude Code's UserPromptSubmit payload carries `prompt_id`, not the
 * prompt text (verified against a live session: the payload has
 * session_id / prompt_id / transcript_path / cwd / permission_mode /
 * effort / hook_event_name). The text only exists in the transcript, so
 * the turn attribute has to come from there.
 *
 * Three classes of `type: 'user'` line are NOT the user talking and are
 * skipped, all three observed live:
 *   - tool results (they flatten to '' — see `userMessageText`),
 *   - `isMeta` lines, which the host writes for its own injected context
 *     and which DO carry a text block (13 of 187 sampled lines),
 *   - `isSidechain` lines, which belong to a sub-agent's conversation,
 *     not the user's (the same flag `toCall` already tracks).
 *
 * Returns null rather than throwing for every failure mode: this runs
 * inside a host-blocking hook.
 */
export function lastUserMessageSince(transcriptPath: string, sinceMs: number): string | null {
  let latest: { ms: number; text: string } | null = null;

  for (const line of readJsonlTail(transcriptPath)) {
    let entry: RawUserEntry;
    try {
      entry = JSON.parse(line) as RawUserEntry;
    } catch {
      continue; // malformed line: skip, don't abort the rest of the file
    }
    // Same guard, for the same reason, as callsSince below: `JSON.parse`
    // returns null (or a number, or an array) WITHOUT throwing for a
    // line that is bare `null` / `42` / `[1,2,3]`, so the catch above
    // never sees it and the property read on the next line is what
    // actually throws. This exact shape has crashed this repo once.
    if (!entry || typeof entry !== 'object') continue;
    if (entry.type !== 'user') continue;
    if (entry.isSidechain === true || entry.isMeta === true) continue;

    const msg = entry.message;
    if (!msg || typeof msg !== 'object') continue;

    const ms = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isFinite(ms) || ms < sinceMs) continue;

    const text = userMessageText(msg.content).trim();
    if (text.length === 0) continue;

    // `>=` so that, among lines sharing a timestamp, the one later in
    // the file wins — transcript order is the tie-breaker.
    if (!latest || ms >= latest.ms) latest = { ms, text };
  }

  return latest ? latest.text : null;
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

      // Must run over the full batch, in transcript order, before the
      // sinceMs filter below — inference borrows each call's endMs from
      // its successor's startMs, so trimming the array first would starve
      // the last surviving call of a successor it actually has.
      applyTiming(calls);

      return calls.filter((c) => c.startMs >= sinceMs);
    },
  };
}
