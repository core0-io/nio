// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Helpers shared by more than one ConversationSource.
 *
 * These started out private to openclaw-source.ts. Pi and opencode need
 * the same two decisions — how much to trust a thinking block, and how to
 * read a usage record defensively — so they live here rather than being
 * copied three times.
 */

import type { ChatCall, ThinkingFidelity } from './types.js';

/**
 * Thinking fidelity follows the MODEL PROVIDER, not the platform.
 *
 * Anthropic models return complete reasoning traces. OpenAI's reasoning
 * series does not expose raw chain-of-thought and gives step summaries
 * instead (~3% of the underlying reasoning by volume). The same host
 * platform therefore yields different fidelity depending on which model
 * is configured — never hard-code a fidelity by platform name.
 */
export function fidelityForProvider(provider: unknown): ThinkingFidelity {
  return typeof provider === 'string' && provider.toLowerCase().includes('anthropic')
    ? 'full'
    : 'summary';
}

/** Read a usage record defensively; undefined when nothing usable is present. */
export function toUsage(raw: unknown): NonNullable<ChatCall['usage']> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const out: NonNullable<ChatCall['usage']> = {};
  if (typeof u.input === 'number') out.input = u.input;
  if (typeof u.output === 'number') out.output = u.output;
  if (typeof u.cacheRead === 'number') out.cacheRead = u.cacheRead;
  if (typeof u.cacheWrite === 'number') out.cacheWrite = u.cacheWrite;
  return Object.keys(out).length > 0 ? out : undefined;
}
