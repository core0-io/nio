// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * The size rule that decides whether a piece of conversation content
 * rides on the SPAN or stays in the LOGS signal.
 *
 * Why a size rule at all
 * -------------------------------------------------
 * Content used to be split by KIND: every block type went to logs, and
 * the trace carried structure only. Measured live on 2026-08-06 that
 * meant an assistant reply — max 360 bytes over the whole session — could
 * only be read by joining a log stream back to its span. Reading "what
 * did the model say" required a join that the data never needed.
 *
 * Size is the property that actually matters. A span attribute is cheap
 * while it is small and expensive when it is not: backends index span
 * attributes for search, several cap a single attribute's length, and a
 * fat attribute is paid for on every trace query whether or not the
 * reader wanted the content. Logs are the opposite — cheap to hold, but
 * only reachable through a join. So: small content on the span, large
 * content in logs.
 *
 * Where the 2 KB budget comes from
 * -------------------------------------------------
 * `SPAN_CONTENT_LIMIT` is 2 KB. It is deliberately a round, conservative
 * number rather than a fitted percentile:
 *
 *  - It matches `redactAndTruncate`'s long-standing `MAX_ATTR_BYTES`, so
 *    every content-bearing span attribute nio emits obeys one budget.
 *  - It is the common conservative ceiling backends apply to a single
 *    span attribute; staying under it keeps the value intact everywhere
 *    rather than truncated differently per backend.
 *  - The observed `tool_input` p90 was 2133 bytes, so 2 KB lands right at
 *    the knee of the measured distribution — the bulk rides on the span,
 *    the tail does not.
 *
 * The measurement behind that last point is a weak input on purpose: it
 * was taken before the exporter's concurrency limit was fixed, so records
 * past the 31st export of a turn were dropped. The drop was by ARRIVAL
 * ORDER, not by size, so the shape of the distribution is unbiased — but
 * n is small (16 replies, 137 tool inputs). The budget is therefore
 * chosen from the principle above and merely CHECKED against the sample,
 * not derived from it.
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

/**
 * Max UTF-8 bytes of any single content-bearing span attribute. See the
 * module doc for why 2 KB and why it is not a fitted percentile.
 */
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
