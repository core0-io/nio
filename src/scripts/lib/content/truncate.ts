// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export type ContentKind = 'thinking' | 'text' | 'user_prompt';
export type ContentLimits = Record<ContentKind, number>;
export const DEFAULT_CONTENT_LIMITS: ContentLimits = {
  thinking: 65536,
  text: 65536,
  user_prompt: 32768,
};
export interface TruncateResult {
  text: string;
  truncated: boolean;
  /** UTF-8 bytes after redaction, before truncation. */
  originalBytes: number;
}
const MARKER = '…[truncated]';

/** Zero means unlimited; positive limits include the marker and are never exceeded. */
export function truncateContent(text: string, limit: number): TruncateResult {
  const originalBytes = Buffer.byteLength(text, 'utf8');
  if (limit === 0 || originalBytes <= limit) return { text, truncated: false, originalBytes };
  const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  const marker = cap < 3 ? '.'.repeat(cap) : utf8Prefix(MARKER, cap);
  const budget = cap - Buffer.byteLength(marker, 'utf8');
  return { text: utf8Prefix(text, budget) + marker, truncated: true, originalBytes };
}

function utf8Prefix(text: string, budget: number): string {
  let bytes = 0;
  let end = 0;
  for (const ch of text) {
    bytes += Buffer.byteLength(ch, 'utf8');
    if (bytes > budget) break;
    end += ch.length;
  }
  return text.slice(0, end);
}
