// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export type ThinkingFidelity = 'full' | 'summary' | 'unknown';

export type TimingFidelity =
  /** Both ends come from the platform. */
  | 'exact'
  /** Start is real; end was derived from the next call's start. */
  | 'inferred'
  /** Timestamps were synthesised at parse time and carry no duration. */
  | 'synthetic';

export interface ContentBlock {
  type: 'thinking' | 'text' | 'tool_use';
  /** Original source position; skipped unsupported blocks may leave gaps. */
  index: number;
  content: string;
  sourceId?: string;
  /** Only meaningful when `type === 'thinking'`. */
  fidelity?: ThinkingFidelity;
  /** Only present when `type === 'tool_use'`. */
  toolUse?: { id: string; name: string; input: string };
}

/** One LLM invocation. */
export interface ChatCall {
  /** Provider-side identity where available; otherwise a stable source fingerprint. */
  callId: string;
  source?: string;
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

export interface ConversationSource {
  /** Stable identifier for diagnostics, e.g. 'claude-code-transcript'. */
  readonly name: string;
  /** Synthetic-timestamp sources return visible history; callers persistently dedupe callId. */
  callsSince(sinceMs: number): ChatCall[];
}

export function blockOrderIsSane(call: ChatCall): boolean {
  return call.blocks.every((b, i) => Number.isInteger(b.index) && b.index >= 0 && (i === 0 || b.index > call.blocks[i - 1]!.index));
}
