// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Per-kind byte truncation for captured conversation content.
 *
 * `redactAndTruncate` (traces-collector.ts) caps span *attribute*
 * payloads by `string.length` — a character count. That is wrong for
 * UTF-8 content: CJK / emoji-heavy text runs ~3 bytes per character, so
 * a character-based cap lets the wire payload reach roughly 3x the
 * intended byte budget, and it can slice a multi-byte character in half.
 *
 * This module truncates by actual UTF-8 **byte** length and always backs
 * the cut point off to a complete character boundary — the output is
 * guaranteed to round-trip through UTF-8 encode/decode unchanged.
 *
 * Why a byte cap exists at all: unbounded content violates real limits
 * downstream — OTLP gRPC's default 4 MB per-message ceiling fails the
 * *entire* export rather than the oversized field, the hook process
 * blocks its host while it serialises a giant payload, and backends
 * apply their own per-log length limits.
 *
 * The `0` escape hatch (see `truncateContent`) exists for operators who
 * want a given content kind fully captured regardless of size and accept
 * the tradeoffs above.
 */

export type ContentKind = 'thinking' | 'text' | 'user_prompt' | 'tool_input' | 'tool_output';

export interface ContentLimits {
  thinking: number;
  text: number;
  user_prompt: number;
  tool_input: number;
  tool_output: number;
}

/** Byte limits applied when `collector.content_limits` is unset in config. */
export const DEFAULT_CONTENT_LIMITS: ContentLimits = {
  thinking: 65536, // 64 KB
  text: 65536, // 64 KB
  user_prompt: 32768, // 32 KB
  tool_input: 16384, // 16 KB
  tool_output: 32768, // 32 KB
};

export interface TruncateResult {
  text: string;
  truncated: boolean;
  /** Byte length (UTF-8) of the *original*, pre-truncation text. */
  originalBytes: number;
}

// Matches the suffix `redactAndTruncate` appends, so both code paths
// read the same way in exported content.
const TRUNCATION_MARKER = '…[truncated]';

/**
 * Truncate `text` to at most `limit` UTF-8 bytes, cutting only on whole
 * character boundaries. Pure: no IO, no caching, no global state.
 *
 * @param text - the text to (possibly) truncate.
 * @param limit - max UTF-8 byte length of the returned `text`, inclusive
 *   of the truncation marker. `0` disables truncation entirely (escape
 *   hatch) — the input is returned unchanged no matter how long it is.
 */
export function truncateContent(text: string, limit: number): TruncateResult {
  const originalBytes = Buffer.byteLength(text, 'utf-8');

  if (limit === 0 || originalBytes <= limit) {
    return { text, truncated: false, originalBytes };
  }

  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf-8');
  // The marker counts against the same budget as the kept text — without
  // this, appending it after a full-limit slice would always push the
  // final result past `limit`.
  const budget = Math.max(0, limit - markerBytes);

  // Walk the string by Unicode code point (safe for surrogate pairs too,
  // not just multi-byte UTF-8 sequences) accumulating UTF-8 byte length,
  // and stop before the next character would exceed the budget. This
  // guarantees the cut point always falls on a complete character —
  // never mid-sequence — without needing to probe a raw byte buffer for
  // a valid boundary after the fact.
  let kept = '';
  let bytesUsed = 0;
  for (const ch of text) {
    const chBytes = Buffer.byteLength(ch, 'utf-8');
    if (bytesUsed + chBytes > budget) break;
    kept += ch;
    bytesUsed += chBytes;
  }

  return { text: kept + TRUNCATION_MARKER, truncated: true, originalBytes };
}
