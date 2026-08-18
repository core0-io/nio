// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * The normalised shape every platform's conversation data collapses to.
 *
 * Four host platforms expose their LLM turns in four different ways —
 * Claude Code and Codex write session files, Hermes and OpenClaw emit
 * live events. Rather than teach the span layer all four dialects, each
 * platform gets a `ConversationSource` implementation that produces this
 * one structure.
 */

/**
 * How faithful a thinking block is to the model's actual reasoning.
 *
 * This is NOT a platform property, and it is NOT a provider property
 * either — it belongs to the MODEL. A provider string names the channel
 * the call went through (an aggregator, a gateway, a cloud vendor), and
 * one channel serves models that behave completely differently. See
 * `fidelityForModel` in `shared.ts` for the rules.
 *
 * Values:
 *
 * - `full` — the model returns its raw reasoning; what is captured is
 *   what the model produced. Anthropic's Claude family with extended
 *   thinking, and the open-weight reasoning families that stream their
 *   chain-of-thought verbatim.
 * - `summary` — the API deliberately withholds the raw chain-of-thought
 *   and returns a step-level summary instead.
 * - `unknown` — no rule matched the model id. NOT a synonym for
 *   `summary`: it means nio has no evidence either way, which is the
 *   honest answer for a model family released after these rules were
 *   written.
 *
 * Consumers must not treat these as interchangeable: a 40-character
 * step title and a thousand-word reasoning chain are different kinds of
 * evidence. Analyses that conflate them will read "the summary didn't
 * mention risk X" as "the model didn't consider risk X" — and an
 * `unknown` block must not be used to support that inference at all.
 */
export type ThinkingFidelity = 'full' | 'summary' | 'unknown';

/**
 * How much the start/end timestamps can be trusted.
 *
 * Only one of the four platforms reports both ends of an LLM call.
 * The span layer needs to know which numbers are real before it draws
 * a duration — a synthetic 0ms span and a measured 0ms span mean very
 * different things.
 */
export type TimingFidelity =
  /** Both ends come from the platform. */
  | 'exact'
  /** Start is real; end was derived from the next call's start. */
  | 'inferred'
  /** Timestamps were synthesised at parse time and carry no duration. */
  | 'synthetic';

export interface ContentBlock {
  type: 'thinking' | 'text' | 'tool_use';
  /** Position within this call, zero-based and contiguous. Order carries meaning. */
  index: number;
  content: string;
  /** Only meaningful when `type === 'thinking'`. */
  fidelity?: ThinkingFidelity;
  /** Only present when `type === 'tool_use'`. */
  toolUse?: { id: string; name: string; input: string };
}

/** One LLM invocation. */
export interface ChatCall {
  /** Provider-side request id where available; otherwise a synthesised ordinal. */
  callId: string;
  model?: string;
  startMs: number;
  endMs: number;
  /** How much `startMs`/`endMs` can be trusted; see `TimingFidelity`. */
  timing: TimingFidelity;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    /** Reasoning tokens billed but not visible (OpenAI reasoning models). */
    reasoning?: number;
  };
  stopReason?: string;
  /** Time to first token, when the platform reports it. Codex does; Claude Code does not. */
  timeToFirstTokenMs?: number;
  blocks: ContentBlock[];
  /** True when this call belongs to a subagent rather than the main thread. */
  isSidechain: boolean;
}

/**
 * Produces the calls that happened within one turn.
 *
 * Implementations fall into two families. Replay sources read a session
 * file the host already wrote, so they see the whole turn at once.
 * Streaming sources accumulate live events and answer from what they
 * have gathered so far.
 */
export interface ConversationSource {
  /** Stable identifier for diagnostics, e.g. 'claude-code-transcript'. */
  readonly name: string;
  /**
   * Calls that started at or after `sinceMs`. Returns an empty array
   * when nothing is available — never throws, never partially fails.
   *
   * `sinceMs` is a REAL filter only on the replay family (Claude Code,
   * Codex): those sources read a session file with genuine per-line
   * timestamps, so `callsSince` actually excludes calls that happened
   * before `sinceMs`.
   *
   * On the streaming family (Hermes, OpenClaw) it filters nothing in
   * practice, because `startMs` on those sources is synthetic (see
   * `TimingFidelity`) — Hermes stamps every call in a payload with the
   * same `Date.now()`, OpenClaw derives it from `Date.now()` plus array
   * position. Passing a real `sinceMs` to either will not trim history
   * the way it does for the replay family: expect the full visible set
   * back, every time.
   *
   * Hermes's `post_llm_call` also replays the *entire*
   * `conversation_history` on every call, not just what changed. This
   * layer is stateless and cannot deduplicate across invocations, and
   * `callsSince` cannot either, since the timestamps it would filter on
   * aren't real. Callers on a streaming source MUST deduplicate on
   * `callId` themselves — which only works if `callId` stays stable as
   * history is trimmed or compacted (see `stableCallId` in
   * `hermes-source.ts`).
   */
  callsSince(sinceMs: number): ChatCall[];
}

/**
 * Whether a call's blocks form a clean zero-based contiguous sequence.
 *
 * The span layer relies on block order to reconstruct "thought, then
 * spoke, then called a tool". A gap or a repeat means the source
 * mis-assembled the call, and the resulting trace would misrepresent
 * what the model actually did — better to detect it than to emit it.
 */
export function blockOrderIsSane(call: ChatCall): boolean {
  return call.blocks.every((b, i) => b.index === i);
}
