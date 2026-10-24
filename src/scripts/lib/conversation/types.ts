// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export type ThinkingFidelity = 'full' | 'summary' | 'unknown';
export interface ContentBlock {
  type: 'thinking' | 'text';
  /** Original source position; skipped unsupported blocks may leave gaps. */
  index: number;
  content: string;
  /** Source identity for internal snapshot/replay deduplication, not an export contract. */
  sourceId?: string;
  fidelity?: ThinkingFidelity;
}

/** One observed assistant message, not an inferred model invocation. */
export interface AssistantMessage {
  /** Real message identity where available; otherwise a stable occurrence fingerprint. */
  id: string;
  blocks: ContentBlock[];
  source?: string;
  timestampMs?: number;
  finishReason?: string;
  isSidechain?: boolean;
}
export interface ConversationSource {
  readonly name: string;
  /** Untimestamped sources return visible history; callers persistently dedupe message IDs. */
  messagesSince(sinceMs: number): AssistantMessage[];
}
export function blockOrderIsSane(message: AssistantMessage): boolean {
  return message.blocks.every((block, i) => Number.isInteger(block.index) && block.index >= 0
    && (i === 0 || block.index > message.blocks[i - 1]!.index));
}
