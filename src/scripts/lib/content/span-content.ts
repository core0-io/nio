// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * The size rule that decides whether a piece of conversation content
 * rides on the SPAN or stays in the LOGS signal.
 *
 * A span attribute is cheap while it is small and expensive when it is
 * not: backends index span attributes for search, several cap a single
 * attribute's length, and a fat attribute is paid for on every trace
 * query whether or not the reader wanted the content. Logs are the
 * opposite — cheap to hold, but only reachable through a join. So: small
 * content on the span, large content in logs.
 *
 * `SPAN_CONTENT_LIMIT` is 2 KB, a round conservative number rather than
 * a fitted percentile. It matches `redactAndTruncate`'s `MAX_ATTR_BYTES`
 * so every content-bearing span attribute nio emits obeys one budget,
 * and it stays under the ceiling backends commonly apply to a single
 * attribute, so the value is not truncated differently per backend.
 *
 * Redact before truncate — same order, same reason, as `emit.ts`
 * -------------------------------------------------
 * `buildSpanContent` runs `redactSecrets` first and `truncateContent`
 * second. A secret straddling the cut point would otherwise be sliced in
 * half, and the redactor — which matches contiguous text — would never
 * see it, leaving half a live credential on the span. This is the single
 * pipeline both the span side and the log side use; there is no second
 * implementation to keep in step.
 *
 * One body, one owner
 * -------------------------------------------------
 * `spanCarriesWholeContent` is what keeps the two signals from shipping
 * the same bytes twice. When the span copy is COMPLETE (not truncated)
 * the span is authoritative and the log record is suppressed. When the
 * body was too big, the span keeps a truncated preview marked with
 * `nio.content.truncated` and the LOG record — full-fidelity, up to the
 * configured per-kind limit — remains authoritative. A consumer's rule is
 * therefore simple and local: if the span attribute is present and
 * `nio.content.truncated` is absent, the span has all of it; otherwise
 * join the logs.
 */

import type { ChatCall } from '../conversation/types.js';
import { redactSecrets } from './redact.js';
import { truncateContent } from './truncate.js';

/** Max UTF-8 bytes of any single content-bearing span attribute. */
export const SPAN_CONTENT_LIMIT = 2048;

export interface SpanContent {
  /** Redacted, then truncated, body — safe to put on a span attribute. */
  text: string;
  /** True when the body did not fit the budget; the logs copy is authoritative. */
  truncated: boolean;
  /** UTF-8 byte length of the body before truncation. */
  originalBytes: number;
  /** How many secrets redaction replaced. */
  redactions: number;
}

/**
 * Prepare `raw` for a span attribute: redact, then truncate to `limit`
 * UTF-8 bytes. Returns `null` when there is nothing left to carry — the
 * same "empty bodies are never emitted" rule the log side applies, for
 * the same reason (an empty attribute asserts the model said something
 * blank, which is not what happened).
 *
 * Pure: no IO, no OTEL, no config lookup.
 */
export function buildSpanContent(
  raw: string,
  limit: number = SPAN_CONTENT_LIMIT,
): SpanContent | null {
  if (!raw) return null;

  // Redact first — see the module doc; this order is load-bearing.
  const { text: redacted, hits } = redactSecrets(raw);
  const { text, truncated, originalBytes } = truncateContent(redacted, limit);

  if (text.length === 0) return null;

  return { text, truncated, originalBytes, redactions: hits };
}

/**
 * True when the span attribute holds the WHOLE body, so the logs signal
 * must not repeat it. False for a missing body (nothing to own) and for a
 * truncated one (logs keep the full copy).
 */
export function spanCarriesWholeContent(content: SpanContent | null): boolean {
  return content !== null && !content.truncated;
}

/**
 * The assistant's spoken reply for one call: every `text` block joined in
 * block order.
 *
 * Joined rather than emitted per block because a span has ONE
 * `nio.chat.reply` attribute; a call that speaks in two blocks said one
 * thing in two pieces. The placement decision is made on the joined
 * string, so the span carries the entire reply or none of it — never a
 * split where one paragraph is on the span and the next is only in logs.
 */
export function chatReplyText(call: ChatCall): string {
  return call.blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.content)
    .join('\n');
}

/**
 * The `nio.content.*` provenance attributes that accompany a span-carried
 * body. Deliberately the same key names the log records use, so one
 * vocabulary covers both signals.
 */
export function spanContentAttributes(content: SpanContent): Record<string, unknown> {
  return {
    ...(content.truncated
      ? { 'nio.content.truncated': true, 'nio.content.original_bytes': content.originalBytes }
      : {}),
    ...(content.redactions > 0 ? { 'nio.content.redactions': content.redactions } : {}),
  };
}
