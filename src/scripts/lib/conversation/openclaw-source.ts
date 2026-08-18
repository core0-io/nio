// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * OpenClaw event stream → ChatCall[].
 *
 * ⚠️ UNVERIFIED — built from OpenClaw's published documentation only.
 * Unlike `hermes-source.ts` this module has no live capture behind it.
 * Treat every field name and event shape below as a best-effort reading
 * of the docs, not a verified contract, until someone checks it against
 * a real gateway.
 *
 * What the docs actually commit to:
 *
 *   - `llm_output`'s field table is metadata-only: `runId`, `callId`,
 *     `provider`, `model`, `outcome`, `durationMs`,
 *     `upstreamRequestIdHash`, `contextTokenBudget`. No content field.
 *   - Reasoning is sent as an independent chat message carrying a
 *     "Thinking" prefix (or `<think>…</think>`), gated by
 *     `/reasoning on|off|stream` — not part of `llm_output` at all.
 *   - The existing `openclaw-plugin.ts` reads `assistantTexts` and
 *     `usage` off the `llm_output` event, but neither appears in the
 *     documented field table — they may be real-but-undocumented, or
 *     they may be an artifact of whatever pre-release build that code
 *     was tested against. Either way, this module treats them as
 *     optional supplements: present → richer output, absent → the call
 *     is still valid, just thinner. Never throw or warn on their
 *     absence, and never let their disappearance affect the documented
 *     fields' output.
 *
 * Because thinking arrives as a separate message ahead of the
 * `llm_output` that closes the call, this module buffers a "pending
 * thinking text" across events and attaches it to the next `llm_output`
 * it sees — mirroring how `codex-source.ts` treats a `reasoning` entry
 * as opening a call that a later entry closes.
 *
 * Fidelity is judged from `llm_output.model`, with `llm_output.provider`
 * as the fallback when the model id decides nothing — see
 * `fidelityForModel` in `shared.ts`. It is deliberately NOT judged from
 * the provider first: a provider string names the channel a call went
 * through, and one channel serves models with completely different
 * reasoning contracts. An unrecognised model reports `'unknown'` rather
 * than being defaulted either way.
 *
 * KNOWN GAP — this module never emits a `tool_use` block, and it is the
 * only one of the six sources that doesn't. The other five reconstruct
 * it from data the platform hands them directly (Claude Code's
 * `content[]`, Codex's `function_call`, Hermes's `tool_calls`, Pi's
 * `toolCall` block, opencode's `tool` part); OpenClaw's equivalent data
 * — `before_tool_call` / `after_tool_call` — lives in
 * `openclaw-plugin.ts`, not in anything
 * this module reads, and reattaching it here would require correlating
 * those events back to the right chat call (by `runId`/`callId`) on a
 * platform this module has never seen live. Left out deliberately
 * rather than implemented wrong and undetectably so — see
 * `conversation-cross-source.test.ts`'s dedicated guard test, which
 * pins this absence so it can't regress into a silent mismatch against
 * the other sources.
 */

import type { ChatCall, ContentBlock, ConversationSource } from './types.js';
import { fidelityForModel, toUsage } from './shared.js';

interface RawLlmOutputEvent {
  runId?: string;
  callId?: string;
  provider?: string;
  model?: string;
  outcome?: string;
  durationMs?: number;
  // Documented but unused here: upstreamRequestIdHash, contextTokenBudget
  // have no home in ChatCall's shape.

  // Undocumented — see module doc. Read defensively, never required.
  assistantTexts?: unknown;
  usage?: unknown;
}

interface RawEnvelope {
  hook?: unknown;
  event?: unknown;
}

type PartialBlock = Omit<ContentBlock, 'index'>;

interface CallBuilder {
  callId: string;
  model?: string;
  startMs: number;
  endMs: number;
  usage?: NonNullable<ChatCall['usage']>;
  stopReason?: string;
  blocks: PartialBlock[];
  isSidechain: boolean;
}

// startMs is synthesised from array position (see the `baseMs` comment
// below), not a platform timestamp — even where durationMs is real,
// startMs + durationMs inherits that synthetic origin. See
// TimingFidelity in types.ts.
const TIMING = 'synthetic' as const;

/** message_sending / before_message_write don't document a body field name; check the plausible candidates. */
function extractMessageText(evt: Record<string, unknown>): string | undefined {
  for (const key of ['body', 'text', 'content', 'message'] as const) {
    const v = evt[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function isThinkingText(text: string): boolean {
  return /^\s*Thinking\b/.test(text) || /<think>[\s\S]*<\/think>/.test(text);
}

function toAssistantTextBlock(raw: unknown): PartialBlock | undefined {
  if (!Array.isArray(raw)) return undefined;
  const joined = raw.filter((t): t is string => typeof t === 'string' && t.length > 0).join('\n');
  return joined.length > 0 ? { type: 'text', content: joined } : undefined;
}

export function createOpenClawSource(events: unknown[]): ConversationSource {
  return {
    name: 'openclaw-event-stream',
    callsSince(sinceMs: number): ChatCall[] {
      if (!Array.isArray(events)) return [];

      const builders: CallBuilder[] = [];
      const current = (): CallBuilder | undefined => builders[builders.length - 1];
      // No event in this stream carries a real wall-clock timestamp per
      // the documented fields, so absolute time is synthesised from
      // array position relative to one shared reference point — good
      // enough to preserve relative ordering for `callsSince`, without
      // pretending to a precision the source doesn't have.
      const baseMs = Date.now();
      let pendingThinking: string | undefined;

      events.forEach((raw, index) => {
        if (!raw || typeof raw !== 'object') return; // malformed entry: skip, don't abort the rest
        const { hook, event: evt } = raw as RawEnvelope;
        if (typeof hook !== 'string' || !evt || typeof evt !== 'object') return;

        if (hook === 'llm_output') {
          const e = evt as RawLlmOutputEvent;
          const startMs = baseMs + index;
          const durationMs = typeof e.durationMs === 'number' ? e.durationMs : 0;
          const callId =
            (typeof e.callId === 'string' && e.callId.length > 0 && e.callId) ||
            (typeof e.runId === 'string' && e.runId.length > 0 && e.runId) ||
            `openclaw-${index}`;

          const blocks: PartialBlock[] = [];
          if (pendingThinking) {
            blocks.push({ type: 'thinking', content: pendingThinking, fidelity: fidelityForModel(e.model, e.provider) });
            pendingThinking = undefined;
          }
          const assistantTextBlock = toAssistantTextBlock(e.assistantTexts);
          if (assistantTextBlock) blocks.push(assistantTextBlock);

          builders.push({
            callId,
            model: typeof e.model === 'string' ? e.model : undefined,
            startMs,
            endMs: startMs + durationMs,
            usage: toUsage(e.usage),
            stopReason: typeof e.outcome === 'string' ? e.outcome : undefined,
            blocks,
            isSidechain: false,
          });
          return;
        }

        if (hook === 'before_message_write' || hook === 'message_sending') {
          const text = extractMessageText(evt as Record<string, unknown>);
          if (!text) return;

          if (isThinkingText(text)) {
            // Opens (or replaces) the reasoning pending for whichever
            // call's `llm_output` closes next — mirrors a Codex
            // `reasoning` entry opening a call boundary.
            pendingThinking = text;
            return;
          }

          const c = current();
          if (!c) return; // no call to attach an orphan reply to; drop rather than fabricate one
          const alreadyPresent = c.blocks.some((b) => b.type === 'text' && b.content === text);
          if (!alreadyPresent) c.blocks.push({ type: 'text', content: text });
          c.endMs = Math.max(c.endMs, baseMs + index);
        }
      });

      return builders
        .map((b) => ({
          callId: b.callId,
          model: b.model,
          startMs: b.startMs,
          endMs: b.endMs,
          timing: TIMING,
          usage: b.usage,
          stopReason: b.stopReason,
          blocks: b.blocks.map((blk, i) => ({ ...blk, index: i })),
          isSidechain: b.isSidechain,
        }))
        .filter((c) => c.startMs >= sinceMs);
    },
  };
}
