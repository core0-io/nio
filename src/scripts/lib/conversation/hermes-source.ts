// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Hermes `post_llm_call` payload → ChatCall[].
 *
 * Unlike the replay sources (`claude-code-source.ts`, `codex-source.ts`),
 * Hermes is a streaming host: this module doesn't read a session file, it
 * takes the single in-memory envelope the `post_llm_call` hook received on
 * stdin and reconstructs whatever calls it can from that one snapshot.
 *
 * Field reality, from a live capture on this machine (Hermes fronting
 * gpt-5.5): `extra` carries `user_message`, `assistant_response`,
 * `conversation_history`, `model`, `platform`. The existing production
 * code (`hermesToCollectorInput` in `hook-cli.ts`) reads `user_message`
 * for the prompt path but has never read `assistant_response` or
 * `conversation_history` — that gap is what this module closes.
 *
 * `conversation_history[]` assistant entries observed carrying three
 * different reasoning-shaped keys that turned out to be one underlying
 * fact stated three ways: `codex_reasoning_items[]` is the raw API item
 * (encrypted `encrypted_content` plus a `summary[]`), and `reasoning` /
 * `reasoning_content` are the plain-text join of that same `summary[]`.
 * Prefer the plain-text field for the block's `content` (no point
 * re-deriving it) but the *fidelity* comes from which shape showed up:
 *
 *   - `codex_reasoning_items` present (or any item's `_issuer_kind`
 *     mentions "codex") → the underlying model is a Codex/OpenAI
 *     reasoning model relayed through Hermes → `fidelity: 'summary'`.
 *   - No codex marker, but the message carries raw Anthropic-shaped
 *     content blocks (`content` as an array with a `type: 'thinking'`
 *     entry) → the underlying model is Anthropic → `fidelity: 'full'`.
 *   - Neither shape present → no thinking block at all; don't fabricate
 *     one out of `reasoning`/`reasoning_content` alone without knowing
 *     which fidelity it deserves.
 *
 * This is a *provider* signal, not a Hermes signal — the same Hermes
 * deployment yields different fidelity depending on which model it is
 * fronting that request. Never special-case on `extra.platform` (that's
 * "cli" vs. other Hermes surfaces, unrelated to the LLM provider) and
 * never hard-code a fidelity by platform name — see `ThinkingFidelity`
 * in `types.ts`.
 *
 * There is no transcript-path field anywhere in this envelope; don't go
 * looking for one.
 */

import type { ChatCall, ContentBlock, ConversationSource } from './types.js';

interface RawAnthropicBlock {
  type?: string;
  thinking?: string;
  text?: string;
}

interface RawCodexReasoningItem {
  id?: string;
  _issuer_kind?: string;
  summary?: { type?: string; text?: string }[];
}

interface RawToolCallFunction {
  name?: string;
  arguments?: unknown;
}

interface RawToolCall {
  id?: string;
  function?: RawToolCallFunction;
}

interface RawHistoryMessage {
  role?: string;
  content?: string | RawAnthropicBlock[];
  finish_reason?: string;
  tool_calls?: RawToolCall[];
  reasoning?: string;
  reasoning_content?: string;
  codex_reasoning_items?: RawCodexReasoningItem[];
}

interface RawExtra {
  user_message?: string;
  assistant_response?: string;
  conversation_history?: unknown;
  model?: string;
  platform?: string;
}

interface RawPayload {
  session_id?: string;
  extra?: RawExtra;
}

type PartialBlock = Omit<ContentBlock, 'index'>;

/**
 * Presence of a non-empty `codex_reasoning_items` array is itself the
 * documented signal (see module doc). Where an item also carries
 * `_issuer_kind`, require it to mention "codex" — belt-and-suspenders
 * for the brief's "(or 条目内 _issuer_kind 含 codex)" clause — but an
 * item with no `_issuer_kind` field at all still counts, since the one
 * real capture this module is built from never had that key populated.
 */
function hasCodexMarker(msg: RawHistoryMessage): boolean {
  const items = msg.codex_reasoning_items;
  if (!Array.isArray(items) || items.length === 0) return false;
  return items.every(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      (item._issuer_kind === undefined || (typeof item._issuer_kind === 'string' && item._issuer_kind.includes('codex'))),
  );
}

/**
 * Picks a callId that survives `conversation_history` being trimmed or
 * compacted, which a long-running session eventually forces (see module
 * doc: every `post_llm_call` replays the *entire* history, so the span
 * layer's only defence against reprocessing old calls is deduplicating
 * on `callId`). `hermes-{historyIndex}` alone is not that id — once the
 * host drops leading entries, every surviving index shifts and a call
 * that was `hermes-12` yesterday is `hermes-9` today, silently defeating
 * dedup.
 *
 * Preference order: `codex_reasoning_items[0].id` (a real provider-side
 * id, e.g. `rs_0595fac6f16ca92f...`, observed on a live capture — stable
 * because it names the item, not its position) → the first tool call's
 * id (also provider-issued and position-independent) → the index-based
 * fallback, kept only for messages that carry neither.
 */
function stableCallId(msg: RawHistoryMessage, historyIndex: number): string {
  const reasoningId = msg.codex_reasoning_items?.[0]?.id;
  if (typeof reasoningId === 'string' && reasoningId.length > 0) return reasoningId;

  const toolCallId = msg.tool_calls?.[0]?.id;
  if (typeof toolCallId === 'string' && toolCallId.length > 0) return toolCallId;

  return `hermes-${historyIndex}`;
}

function reasoningText(msg: RawHistoryMessage): string | undefined {
  if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0) {
    return msg.reasoning_content;
  }
  if (typeof msg.reasoning === 'string' && msg.reasoning.length > 0) {
    return msg.reasoning;
  }
  if (Array.isArray(msg.codex_reasoning_items)) {
    const joined = msg.codex_reasoning_items
      .flatMap((item) => (Array.isArray(item?.summary) ? item.summary : []))
      .filter((s) => s && typeof s.text === 'string')
      .map((s) => s!.text as string)
      .join('\n');
    if (joined.length > 0) return joined;
  }
  return undefined;
}

/**
 * Thinking + text blocks for one assistant message, in "thought, then
 * spoke" order. Handles two disjoint shapes: Anthropic-style raw content
 * blocks (`content` as an array), and the Hermes-normalised flat fields
 * (`content` as a string plus the reasoning/-content/-items trio).
 */
function toThinkingAndText(msg: RawHistoryMessage): PartialBlock[] {
  const blocks: PartialBlock[] = [];

  if (Array.isArray(msg.content)) {
    // Anthropic-shaped: content is itself the array of typed blocks.
    for (const b of msg.content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.length > 0) {
        blocks.push({ type: 'thinking', content: b.thinking, fidelity: 'full' });
      } else if (b.type === 'text' && typeof b.text === 'string' && b.text.length > 0) {
        blocks.push({ type: 'text', content: b.text });
      }
    }
    return blocks;
  }

  if (hasCodexMarker(msg)) {
    const text = reasoningText(msg);
    if (text) blocks.push({ type: 'thinking', content: text, fidelity: 'summary' });
  }

  if (typeof msg.content === 'string' && msg.content.length > 0) {
    blocks.push({ type: 'text', content: msg.content });
  }

  return blocks;
}

function toToolUseBlocks(toolCalls: unknown, ordinalPrefix: string): PartialBlock[] {
  if (!Array.isArray(toolCalls)) return [];
  const blocks: PartialBlock[] = [];
  toolCalls.forEach((tc: RawToolCall, i) => {
    if (!tc || typeof tc !== 'object') return;
    const fn = tc.function;
    if (!fn || typeof fn.name !== 'string') return;
    const input = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {});
    blocks.push({
      type: 'tool_use',
      content: input,
      toolUse: {
        id: typeof tc.id === 'string' && tc.id.length > 0 ? tc.id : `${ordinalPrefix}-tool-${i}`,
        name: fn.name,
        input,
      },
    });
  });
  return blocks;
}

/**
 * How many trailing assistant messages `callsSince` is allowed to return.
 *
 * Why a cap at all: Hermes fires `post_llm_call` (→ our `Stop`) once per
 * *LLM call*, not once per user turn, and every one of those envelopes
 * replays the ENTIRE `conversation_history`. Returning one `ChatCall` per
 * historical assistant message therefore re-emits every earlier call at
 * every subsequent turn — N(N+1)/2 chat spans and content records for N
 * calls (30 calls → 465 chat spans, 100 → 5050), each under a fresh span
 * id in a fresh trace, so no backend dedups them. Unbounded quadratic
 * growth in both span count and egress bytes.
 *
 * Why 2 and not 1: a tool call is *issued* by one LLM call and *executes*
 * during the next one, so at `endTurn` the deferred tool spans belong to
 * either the current call or the one immediately before it. Two entries
 * is exactly the window `buildSpanTree` needs to attribute every tool
 * span in flight (Hermes calls are `timing: 'synthetic'`, so attribution
 * runs purely off `tool_use` ids — an id that fell out of this window
 * would leave its tool span orphaned onto the turn root).
 *
 * Why not 0/dedup-by-id instead: the callIds available here are only
 * partly provider-issued (`stableCallId` falls back to a position-derived
 * `hermes-{i}` for messages carrying neither a reasoning-item id nor a
 * tool-call id), so an id-only dedup drifts when history is trimmed.
 */
const TAIL_CALL_WINDOW = 2;

export function createHermesSource(payload: unknown): ConversationSource {
  return {
    name: 'hermes-post-llm-call',
    callsSince(sinceMs: number): ChatCall[] {
      if (!payload || typeof payload !== 'object') return [];
      const raw = payload as RawPayload;
      const extra = raw.extra;
      if (!extra || typeof extra !== 'object') return [];

      const history = extra.conversation_history;
      if (!Array.isArray(history)) return [];

      const nowMs = Date.now();
      const allAssistantIndices: number[] = [];
      history.forEach((entry, i) => {
        if (entry && typeof entry === 'object' && (entry as RawHistoryMessage).role === 'assistant') {
          allAssistantIndices.push(i);
        }
      });

      // Only the tail — see TAIL_CALL_WINDOW. `slice(-n)` on a shorter
      // array yields the whole array, so a history with one (or zero)
      // assistant message needs no special-casing here.
      const assistantIndices = allAssistantIndices.slice(-TAIL_CALL_WINDOW);

      const calls: ChatCall[] = assistantIndices.map((historyIndex, ordinal) => {
        const msg = history[historyIndex] as RawHistoryMessage;
        const callId = stableCallId(msg, historyIndex);
        const isLast = ordinal === assistantIndices.length - 1;

        const partials: PartialBlock[] = [...toThinkingAndText(msg)];

        if (isLast && typeof extra.assistant_response === 'string' && extra.assistant_response.length > 0) {
          const alreadyPresent = partials.some(
            (b) => b.type === 'text' && b.content === extra.assistant_response,
          );
          if (!alreadyPresent) {
            partials.push({ type: 'text', content: extra.assistant_response });
          }
        }

        partials.push(...toToolUseBlocks(msg.tool_calls, callId));

        return {
          callId,
          model: typeof extra.model === 'string' ? extra.model : undefined,
          startMs: nowMs,
          endMs: nowMs,
          // Every call in one post_llm_call payload shares the same
          // Date.now() snapshot — there is no per-call timestamp anywhere
          // in the envelope, so this carries no real duration information
          // (see TimingFidelity in types.ts).
          timing: 'synthetic',
          stopReason: typeof msg.finish_reason === 'string' ? msg.finish_reason : undefined,
          blocks: partials.map((b, index) => ({ ...b, index })),
          isSidechain: false,
        };
      });

      return calls.filter((c) => c.startMs >= sinceMs);
    },
  };
}
