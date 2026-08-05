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
 * This is NOT a platform property — it follows the model provider, and
 * the same platform yields different values depending on which model is
 * configured. Anthropic models return complete reasoning traces;
 * OpenAI's reasoning series does not expose raw chain-of-thought at the
 * API level and gives step-level summaries instead (measured at ~3% of
 * the underlying reasoning by volume).
 *
 * Consumers must not treat the two as interchangeable: a 40-character
 * step title and a thousand-word reasoning chain are different kinds of
 * evidence. Analyses that conflate them will read "the summary didn't
 * mention risk X" as "the model didn't consider risk X".
 */
export type ThinkingFidelity = 'full' | 'summary';

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
