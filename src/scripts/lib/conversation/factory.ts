// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import type { ConversationSource } from './types.js';
import { createClaudeCodeSource } from './claude-code-source.js';
import { createCodexSource } from './codex-source.js';
import { createHermesSource } from './hermes-source.js';
import { createOpenClawSource } from './openclaw-source.js';
import { createPiSource } from './pi-source.js';
import { createOpenCodeSource } from './opencode-source.js';

export interface SourceInput {
  /** Replay platforms (Claude Code, Codex, Pi): path to the session file. */
  transcriptPath?: string | null;
  /** Hermes: the post_llm_call envelope. */
  payload?: unknown;
  /** Streaming platforms (OpenClaw, opencode): accumulated events. */
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
    case 'pi':
      return input.transcriptPath || input.events ? createPiSource(input.transcriptPath ?? undefined, input.events) : null;
    case 'openclaw':
      return input.events ? createOpenClawSource(input.events) : null;
    case 'opencode':
      return input.events ? createOpenCodeSource(input.events) : null;
    default:
      return null;
  }
}
