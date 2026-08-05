// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Streaming source over opencode's accumulated message parts.
 *
 * opencode has no session file a plugin can read back, so the binding
 * accumulates `message.updated` (the assistant message envelope) and
 * `message.part.updated` (its parts) and hands the array over here.
 *
 * opencode is the only host that reports BOTH ends of an LLM call:
 * AssistantMessage carries `time.created` and `time.completed`, and
 * reasoning parts carry their own `time.start` / `time.end`. A completed
 * message therefore yields `timing: 'exact'` — every other platform is
 * 'inferred' or 'synthetic'. That is not cosmetic: `buildSpanTree` only
 * enables its time-window tool-attribution channel when
 * `timing !== 'synthetic'`, so this is what lets opencode's tool spans
 * nest under the chat span they actually belong to.
 *
 * BOTH event kinds are SNAPSHOTS, and both have to be collapsed here.
 * `message.updated` republishes the whole assistant message on every
 * change (cumulative token totals included), and `message.part.updated`
 * republishes the whole part on every change — a streaming text part is
 * re-emitted once per chunk, carrying the full text so far each time.
 * Appending either blindly compounds: the message envelope would emit
 * one call per republish (N calls, N× the tokens), and the parts would
 * emit one block per chunk, each a longer prefix of the same sentence.
 * So: a later envelope REPLACES the earlier one for its message id, and
 * a later part REPLACES the earlier one for its part id, in place, so
 * first-seen order still decides block order.
 */

import { fidelityForProvider } from './shared.js';
import type { ChatCall, ContentBlock, ConversationSource } from './types.js';

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

/**
 * Tool arguments come off live SDK objects, not off `JSON.parse`, so
 * they can hold a cycle or a BigInt — either makes `JSON.stringify`
 * throw. `callsSince` must never throw (it runs inside a host-blocking
 * hook), so an unserialisable input degrades to `{}` rather than taking
 * the whole turn's reconstruction down with it.
 */
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

/**
 * One accumulated message id → its `ChatCall`, or null when it does not
 * describe one (no assistant envelope ever arrived, it started before
 * the turn, or every part it carried was orchestration rather than model
 * output).
 */
function callFrom(id: string, acc: Accum, sinceMs: number): ChatCall | null {
  if (!acc.info) return null;
  const info = acc.info;
  const time = (info.time && typeof info.time === 'object'
    ? info.time : {}) as Record<string, unknown>;
  const startMs = typeof time.created === 'number' ? time.created : 0;
  if (startMs < sinceMs) return null;
  const completed = typeof time.completed === 'number' ? time.completed : undefined;

  const blocks: ContentBlock[] = [];
  for (const p of acc.parts) {
    if (p.type === 'reasoning' && typeof p.text === 'string' && p.text.length > 0) {
      blocks.push({
        type: 'thinking', index: blocks.length, content: p.text,
        fidelity: fidelityForProvider(info.providerID),
      });
    } else if (
      p.type === 'text' && typeof p.text === 'string' && p.text.length > 0
      && p.synthetic !== true
    ) {
      blocks.push({ type: 'text', index: blocks.length, content: p.text });
    } else if (p.type === 'tool' && typeof p.callID === 'string') {
      const state = (p.state && typeof p.state === 'object'
        ? p.state : {}) as Record<string, unknown>;
      blocks.push({
        type: 'tool_use', index: blocks.length, content: '',
        toolUse: {
          id: p.callID,
          name: typeof p.tool === 'string' ? p.tool : 'unknown',
          input: serialiseInput(state.input),
        },
      });
    }
    // step-start / step-finish / snapshot / patch / agent / retry /
    // compaction / subtask parts describe orchestration, not model
    // output, and are deliberately skipped. So is a TextPart with
    // `synthetic: true`, which is opencode's own marker for text the HOST
    // injected into the message (an interruption notice, a re-prompt, a
    // compaction stub) rather than text the model produced. A ChatCall's
    // blocks are the model's output; a synthetic part recorded as a
    // `text` block is not a lossy record, it is a wrong one — the
    // transcript would quote the harness as the assistant, and
    // `nio.content.text_chars` would count words nobody generated. Same
    // category as the orchestration parts above, so it gets the same
    // treatment.
  }
  if (blocks.length === 0) return null;

  return {
    callId: id,
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
        // Per-event, not around the whole loop: these are live SDK
        // objects (see the module doc), so a property read is a call into
        // host code — a getter or a Proxy trap can throw where
        // `JSON.parse` output never could. `serialiseInput` already
        // guards the one place that stringifies; this guards the bare
        // reads. Scoped to one event so a single hostile object costs its
        // own call and not the whole turn's reconstruction.
        try {
          const e = raw as Record<string, unknown>;
          if (e.kind === 'message') {
            const info = e.info as Record<string, unknown> | undefined;
            if (!info || typeof info !== 'object' || info.role !== 'assistant') continue;
            const id = typeof info.id === 'string' ? info.id : undefined;
            if (!id) continue;
            // message.updated is a cumulative SNAPSHOT republished on
            // every change — later envelopes replace earlier ones rather
            // than accumulating, or totals would compound.
            ensure(byId, order, id).info = info;
          } else if (e.kind === 'part') {
            const part = e.part as Record<string, unknown> | undefined;
            if (!part || typeof part !== 'object') continue;
            const mid = typeof part.messageID === 'string' ? part.messageID : undefined;
            if (!mid) continue;
            // Parts may legitimately arrive before the envelope that owns
            // them; the accumulator is created either way, and an id that
            // never receives an assistant envelope produces no call.
            const acc = ensure(byId, order, mid);
            const pid = typeof part.id === 'string' ? part.id : undefined;
            const at = pid !== undefined ? acc.partIndexById.get(pid) : undefined;
            if (at !== undefined) {
              // Same part, later snapshot: replace in place so the block
              // keeps the position it first appeared at.
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
        // Same reasoning as the accumulation loop above: everything
        // `callFrom` reads still comes off live host objects, so one
        // hostile envelope or part costs its own call and nothing else.
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
