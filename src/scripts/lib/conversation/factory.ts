// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Dispatches a platform tag to its `ConversationSource` implementation.
 *
 * The four host platforms hand the collector their conversation data in
 * four different shapes — Claude Code and Codex point at a session file
 * on disk, Hermes hands over a payload envelope, OpenClaw hands over an
 * accumulated event array. Callers (collector-core) know which platform
 * they are running under but shouldn't have to know which constructor
 * that platform needs or which field of `SourceInput` it reads — this
 * is the one place that mapping lives.
 *
 * Returns `null`, never throws, when the platform is unrecognised or the
 * input it needs is missing. That is a real, expected path: it is how a
 * caller falls back to the pre-span-layer "turn → tool" shape instead of
 * attempting chat-span reconstruction with nothing to reconstruct from.
 */

import type { ConversationSource } from './types.js';
import { createClaudeCodeSource } from './claude-code-source.js';
import { createCodexSource } from './codex-source.js';
import { createHermesSource } from './hermes-source.js';
import { createOpenClawSource } from './openclaw-source.js';

export interface SourceInput {
  /** Replay platforms: path to the session file. */
  transcriptPath?: string | null;
  /** Hermes: the post_llm_call envelope. */
  payload?: unknown;
  /** OpenClaw: accumulated events. */
  events?: unknown[];
}

export function createSourceForPlatform(platform: string, input: SourceInput): ConversationSource | null {
  switch (platform) {
    case 'claude-code':
      return input.transcriptPath ? createClaudeCodeSource(input.transcriptPath) : null;
    case 'codex':
      return input.transcriptPath ? createCodexSource(input.transcriptPath) : null;
    case 'hermes':
      return input.payload !== undefined && input.payload !== null ? createHermesSource(input.payload) : null;
    case 'openclaw':
      return input.events ? createOpenClawSource(input.events) : null;
    default:
      return null;
  }
}
