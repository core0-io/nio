// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Assembles the turn's span tree: which tool call belongs under which
 * LLM call.
 *
 * A trace of `turn → tool` shows what the agent did but not why: the
 * reasoning between two tool calls is invisible, and two tools that the
 * model decided on in one breath look identical to two tools it decided
 * on after re-reading a result. The `chat` layer this module builds
 * restores that: one span per LLM call, carrying the model, its usage,
 * its finish reason and its words.
 *
 * It does NOT normally decide a tool span's parent any more. Attribution
 * is only knowable once the turn is over and the conversation source has
 * produced its `ChatCall[]`, and buying it meant parking every finished
 * tool span until then — which made a long turn invisible and a mid-turn
 * crash unreconstructable. Tool spans are now exported as they finish and
 * hang off the turn root, joined to their chat call by
 * `gen_ai.tool.call.id` rather than by parentage. `buildSpanTree` still
 * runs, and still attributes whatever a turn boundary finds in
 * `deferred_spans` — which is nothing at all unless
 * `PluginRuntimeOptions.eagerToolSpans` was set to `false`.
 *
 * Pure by design — `ChatCall[]` + `DeferredSpan[]` in, a tree out. No
 * OTEL, no IO, no clock. The emitting side (traces-collector) walks the
 * tree and does nothing but create spans from it.
 */

import { randomBytes } from 'node:crypto';
import type { ChatCall } from './conversation/types.js';
import type { DeferredSpan } from './traces-state-store.js';
import { buildSpanContent, chatReplyText, spanContentAttributes } from './content/span-content.js';

export interface ChatSpanNode {
  /** Span id minted for this chat call; the parent id of its tool spans. */
  span_id: string;
  call: ChatCall;
  tools: DeferredSpan[];
}

export interface SpanTree {
  chats: ChatSpanNode[];
  /** Tool spans that could not be attributed to any chat call. */
  orphans: DeferredSpan[];
}

/**
 * Attribute set for a `chat` span, per the OTel GenAI conventions plus
 * nio's content/timing extensions.
 *
 * `nio.chat.timing` is not optional decoration: `endMs - startMs` is a
 * real measurement on one platform and a fabricated 0 on others (see
 * `TimingFidelity`). A consumer that cannot tell the two apart will read
 * synthetic zeros as "the model answered instantly".
 *
 * `nio.chat.reply` carries what the model actually SAID, when it fits the
 * span budget (see `content/span-content.ts`). Measured live, assistant
 * replies topped out at 360 bytes — small enough that forcing a log join
 * to read them bought nothing. When a reply does NOT fit, the attribute
 * holds a truncated preview marked `nio.content.truncated` and the
 * `text` content records stay authoritative.
 */
export function chatSpanAttributes(call: ChatCall): Record<string, unknown> {
  let thinkingChars = 0;
  let textChars = 0;
  for (const block of call.blocks) {
    if (block.type === 'thinking') thinkingChars += block.content.length;
    else if (block.type === 'text') textChars += block.content.length;
  }

  const usage = call.usage ?? {};
  // Redact-then-truncate happens inside buildSpanContent; `null` means
  // the call said nothing, and no empty attribute is invented for it.
  const reply = buildSpanContent(chatReplyText(call));
  return {
    'gen_ai.operation.name': 'chat',
    ...(call.model ? { 'gen_ai.request.model': call.model } : {}),
    'gen_ai.response.id': call.callId,
    ...(typeof usage.input === 'number' ? { 'gen_ai.usage.input_tokens': usage.input } : {}),
    ...(typeof usage.output === 'number' ? { 'gen_ai.usage.output_tokens': usage.output } : {}),
    ...(typeof usage.cacheRead === 'number'
      ? { 'gen_ai.usage.cache_read.input_tokens': usage.cacheRead }
      : {}),
    ...(typeof usage.cacheWrite === 'number'
      ? { 'gen_ai.usage.cache_creation.input_tokens': usage.cacheWrite }
      : {}),
    ...(call.stopReason ? { 'gen_ai.response.finish_reasons': call.stopReason } : {}),
    'nio.content.thinking_chars': thinkingChars,
    'nio.content.text_chars': textChars,
    'nio.content.blocks': call.blocks.length,
    'nio.chat.is_sidechain': call.isSidechain,
    'nio.chat.timing': call.timing,
    ...(reply ? { 'nio.chat.reply': reply.text, ...spanContentAttributes(reply) } : {}),
  };
}

/** Span name for a chat call. */
export function chatSpanName(call: ChatCall): string {
  return call.model ? `chat ${call.model}` : 'chat';
}

function randomSpanId(): string {
  return randomBytes(8).toString('hex');
}

/**
 * Join finished tool spans onto the chat calls that issued them.
 *
 * Attribution, in priority order:
 *
 *  1. `tool_use_id` exact match against a `tool_use` block's id. This is
 *     the main path and the only one that is actually evidence.
 *  2. Time containment — `start_ms` inside `[call.startMs, next.startMs)`.
 *     Enabled ONLY when the candidate call's `timing` is not
 *     `'synthetic'`. Three of the four platforms fabricate their
 *     timestamps (Claude Code collapses endMs onto startMs, Hermes gives
 *     every call in a payload one `Date.now()`, OpenClaw adds the array
 *     index to `Date.now()`); interval arithmetic on fabricated numbers
 *     produces a tree that looks structured and is noise.
 *  3. Orphan — no guessing. The span hangs off the turn, exactly as it
 *     did before this layer existed.
 *
 * A `tool_use_id` repeated across several calls (malformed source data)
 * binds to the first call that declares it, and its span is placed once.
 */
export function buildSpanTree(calls: ChatCall[], deferred: DeferredSpan[]): SpanTree {
  const chats: ChatSpanNode[] = calls.map((call) => ({
    span_id: randomSpanId(),
    call,
    tools: [],
  }));

  // tool_use id → index of the FIRST call that declared it. Later
  // repeats are ignored so a duplicated id cannot place one span twice.
  const byToolUseId = new Map<string, number>();
  calls.forEach((call, i) => {
    for (const block of call.blocks) {
      if (block.type !== 'tool_use') continue;
      const id = block.toolUse?.id;
      if (!id) continue;
      if (!byToolUseId.has(id)) byToolUseId.set(id, i);
    }
  });

  const orphans: DeferredSpan[] = [];

  for (const span of deferred) {
    const byId = span.tool_use_id !== undefined ? byToolUseId.get(span.tool_use_id) : undefined;
    if (byId !== undefined) {
      chats[byId]!.tools.push(span);
      continue;
    }

    const byTime = findCallByTime(calls, span.start_ms);
    if (byTime !== null) {
      chats[byTime]!.tools.push(span);
      continue;
    }

    orphans.push(span);
  }

  return { chats, orphans };
}

/**
 * Index of the call whose `[startMs, nextStartMs)` window contains
 * `startMs`, or null when no trustworthy window does.
 */
function findCallByTime(calls: ChatCall[], startMs: number): number | null {
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!;
    // Synthetic timestamps carry no ordering information worth using.
    if (call.timing === 'synthetic') continue;
    if (startMs < call.startMs) continue;
    const next = calls[i + 1];
    if (next === undefined || startMs < next.startMs) return i;
  }
  return null;
}
