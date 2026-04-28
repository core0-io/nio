// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Stage 1 — recursive command unwrappers.
 *
 * Subsequent commits will populate this module with U1-U16 (shell -c,
 * heredoc, process substitution, eval, base64-decode, xargs/find -exec,
 * ssh, editor escape, background/scheduled, compile-and-run, …). For
 * commit 2 the implementation is intentionally a no-op pass-through so the
 * refactor introduces no behavioural change.
 */

import type { UnwrappedFragment } from './types.js';

/** Maximum unwrap depth — guard against recursion bombs. */
export const MAX_UNWRAP_DEPTH = 8;

/**
 * Recursively unwrap a Bash command into a flat list of fragments. Each
 * fragment is independently fed through Stage 2 detectors.
 *
 * Stub: returns `[{ command }]` for any non-empty input.
 */
export function unwrapCommand(command: string): UnwrappedFragment[] {
  if (!command) return [];
  return [{ command }];
}
