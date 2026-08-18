// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Turns one `ChatCall`'s content blocks into OTLP-shaped log records.
 *
 * Pure: records in, records out. The span layer owns the OTEL provider
 * and decides when to emit; `content/sink.ts` is where the two meet.
 *
 * Redundant trace/span attributes — do not delete
 * -------------------------------------------------
 * `traceId`/`spanId` are set as OTLP LogRecord's built-in binary fields
 * (that's what the interface below models), but this module ALSO copies
 * the same values into plain string attributes (`nio.trace_id` /
 * `nio.span_id`). This looks like duplication and it is tempting to trim
 * it — don't. Backends disagree on how they surface the built-in fields
 * after ingestion: some expose `span_id`, some `SpanId`, some bury both
 * inside structured/resource metadata that isn't queryable the same way
 * as a normal attribute. A plain string attribute is the one join key
 * that works identically everywhere, regardless of how a given backend
 * chose to map the OTLP binary fields. Losing this copy means some
 * backends silently lose the ability to join content records back to
 * their span.
 *
 * Processing order — redact, then truncate
 * -------------------------------------------------
 * Every block is redacted for secrets *before* it is truncated. Doing it
 * the other way around is wrong in two ways: (1) a secret that straddles
 * the truncation cut point gets sliced in half, leaving one half of a
 * live credential sitting in the emitted record — redaction never gets a
 * chance to see it as one contiguous match; (2) the truncation marker
 * text gets interleaved with content, which can itself break a pattern
 * mid-match. Redacting first guarantees the secret patterns always see
 * the original, unmodified text.
 *
 * What is NOT emitted
 * -------------------------------------------------
 * An empty body, whatever its kind — the check runs on the FINAL body,
 * since redaction and truncation can both empty one. A `text` block
 * whose call's joined reply already fit `nio.chat.reply` in full (see
 * `span-content.ts`); `thinking` is never span-carried, so it is
 * unconditional here. And `tool_use` blocks, whose arguments belong to
 * the site that emits the tool's span — the only place that can tell
 * whether that span carried the whole body, and — on the in-process
 * family — whether it will ever be sent at all (see
 * `buildToolInputRecord`).
 * This module replays history at the end of the turn and cannot see
 * whether a span was emitted, so any rule it applied would be a guess.
 * What it uniquely knew — which chat call issued which tool call —
 * rides the chat span as `nio.chat.tool_call_ids` instead.
 */

import type { ChatCall, ContentBlock } from '../conversation/types.js';
import { redactSecrets } from './redact.js';
import { truncateContent, type ContentKind, type ContentLimits } from './truncate.js';
import { buildSpanContent, chatReplyText, spanCarriesWholeContent } from './span-content.js';

/** The subset of `ContentBlock['type']` this module maps from. */
type EmittableBlockType = 'thinking' | 'text';

/** Maps a block's type to the `ContentKind` used to look up its byte limit. */
const BLOCK_TYPE_TO_KIND: Record<EmittableBlockType, ContentKind> = {
  thinking: 'thinking',
  text: 'text',
};

/**
 * `nio.content.type` values this module can produce.
 *
 * `buildContentRecords` only ever emits the first two. `tool_input` and
 * `tool_output` come from the hook that observed the tool, not from the
 * call that requested it, and are built by `buildToolInputRecord` /
 * `buildToolOutputRecord`. `user_prompt` is carried as a turn-span
 * attribute (`nio.turn.user_prompt`) and has no builder here.
 */
type EmittedContentType = 'thinking' | 'text' | 'tool_input' | 'tool_output';

const BLOCK_TYPE_TO_CONTENT_TYPE: Record<EmittableBlockType, EmittedContentType> = {
  thinking: 'thinking',
  text: 'text',
};

export interface ContentRecordAttributes {
  'nio.content.type': EmittedContentType;
  /** Position of the source block within its call; preserves block order. */
  'nio.content.index': number;
  /** Only present on records built from a `thinking` block. */
  'nio.content.fidelity'?: string;
  /** Only present when the body was truncated. */
  'nio.content.truncated'?: boolean;
  /** Only present when the body was truncated: pre-truncation UTF-8 byte length. */
  'nio.content.original_bytes'?: number;
  /** Only present when redaction replaced at least one secret. */
  'nio.content.redactions'?: number;
  /** Redundant copy of `traceId` as a plain string attribute; see module docs. */
  'nio.trace_id': string;
  /** Redundant copy of `spanId` as a plain string attribute; see module docs. */
  'nio.span_id': string;
  /** Only present on the out-of-band tool records (`tool_input` / `tool_output`). */
  'gen_ai.tool.call.id'?: string;
}

export interface ContentRecord {
  /** OTLP LogRecord built-in field: the turn-level trace this content belongs to. */
  traceId: string;
  /** OTLP LogRecord built-in field: the chat span this content belongs to. */
  spanId: string;
  /** Redacted, then truncated, body text. */
  body: string;
  attributes: ContentRecordAttributes;
}

/**
 * Build one `ContentRecord` per emittable block in `call`, in block
 * order. Blocks whose final body is empty — or whose body the span
 * already carries in full — produce no record at all (see the module
 * doc), so the result can be shorter than `call.blocks`; the surviving
 * records keep their own block index, they are not renumbered.
 *
 * `spanId` / `traceId` are supplied by the caller (the span layer),
 * which is the only place that knows the OTEL span a given `ChatCall`
 * was recorded under.
 */
export function buildContentRecords(
  call: ChatCall,
  spanId: string,
  traceId: string,
  limits: ContentLimits,
): ContentRecord[] {
  const records: ContentRecord[] = [];

  // Computed once per call, not per block: the placement decision is made
  // on the JOINED reply, so the span carries all of it or none of it.
  // Same function the span layer calls, so the two cannot disagree.
  const replyOnSpan = spanCarriesWholeContent(buildSpanContent(chatReplyText(call)));

  for (const block of call.blocks) {
    if (block.type !== 'thinking' && block.type !== 'text') {
      continue;
    }

    // Already on the span in full — see the module doc.
    if (block.type === 'text' && replyOnSpan) continue;

    const record = buildRecord(block, block.type, spanId, traceId, limits);
    if (record) records.push(record);
  }

  return records;
}

/**
 * Build the single record carrying a finished tool call's output.
 *
 * Unlike `buildContentRecords`, this is not driven by a `ChatCall`: the
 * result text comes from the PostToolUse hook payload, and `spanId` is
 * the TOOL span's id (minted at PreToolUse), not a chat span's.
 *
 * Same redact-then-truncate order as `buildContentRecords` — see the
 * module doc for why that order is load-bearing. Returns `null` when the
 * final body is empty.
 */
export function buildToolOutputRecord(
  result: string,
  spanId: string,
  traceId: string,
  limits: ContentLimits,
  toolCallId?: string
): ContentRecord | null {
  return buildOutOfBandRecord('tool_output', result, spanId, traceId, limits.tool_output, toolCallId);
}

/**
 * Build the record carrying a tool call's ARGUMENTS, from the hook
 * payload rather than from a `ChatCall`.
 *
 * This is the ONLY producer of `tool_input` records. Both callers are
 * span-emitting sites — which is the point: only such a site holds the
 * `SpanContent` the size rule is stated against — but they apply
 * DIFFERENT rules, and the difference is deliberate:
 *
 *   - `collector-core.ts` PostToolUse (the hook family) emits this only
 *     when the span could not carry the whole body, i.e.
 *     `!spanCarriesWholeContent(spanArgs)` for the very `SpanContent` it
 *     just put on the span as `gen_ai.tool.call.arguments`. Same value,
 *     same statement, so the two signals cannot disagree about who owns
 *     the bytes. There, one body has exactly one owner.
 *   - `plugin-runtime.ts` PreToolUse (the in-process family) emits this
 *     UNCONDITIONALLY. The params are only in hand at the pre side, and
 *     the record is designed to OUTLIVE a span that a mid-turn crash or
 *     disarm may never send (see `emitToolContent`). So that family
 *     keeps a bounded second copy of small arguments — the span
 *     attribute AND the record — where the hook family keeps one. A call
 *     the guard denies contributes its arguments there for the same
 *     reason: its post side never fires.
 *
 * Whichever rule applies, this needs no `ConversationSource`, which is
 * what keeps arguments on the wire for a session with no readable
 * transcript. It lands on the TOOL span, next to `tool_output`; which
 * chat call issued that tool is carried by the chat span's
 * `nio.chat.tool_call_ids`, not by a second content record.
 */
export function buildToolInputRecord(
  input: string,
  spanId: string,
  traceId: string,
  limits: ContentLimits,
  toolCallId?: string
): ContentRecord | null {
  return buildOutOfBandRecord('tool_input', input, spanId, traceId, limits.tool_input, toolCallId);
}

/**
 * Shared body for the two builders that are driven by a hook payload
 * instead of a `ChatCall` block. Same redact-then-truncate order as
 * `buildRecord`; see the module doc for why that order is load-bearing.
 */
function buildOutOfBandRecord(
  type: 'tool_input' | 'tool_output',
  text: string,
  spanId: string,
  traceId: string,
  limit: number,
  toolCallId?: string
): ContentRecord | null {
  const { text: redacted, hits } = redactSecrets(text);
  const { text: body, truncated, originalBytes } = truncateContent(redacted, limit);

  // Nothing left to say — see the module doc.
  if (body.length === 0) return null;

  const attributes: ContentRecordAttributes = {
    'nio.content.type': type,
    // A tool call has exactly one argument payload and produces exactly
    // one result; there is no block sequence to preserve, so the index is
    // a constant 0 rather than a fabricated ordinal.
    'nio.content.index': 0,
    'nio.trace_id': traceId,
    'nio.span_id': spanId,
  };

  if (truncated) {
    attributes['nio.content.truncated'] = true;
    attributes['nio.content.original_bytes'] = originalBytes;
  }

  if (hits > 0) {
    attributes['nio.content.redactions'] = hits;
  }

  if (toolCallId) {
    attributes['gen_ai.tool.call.id'] = toolCallId;
  }

  return { traceId, spanId, body, attributes };
}

function buildRecord(
  block: ContentBlock,
  type: EmittableBlockType,
  spanId: string,
  traceId: string,
  limits: ContentLimits
): ContentRecord | null {
  const kind = BLOCK_TYPE_TO_KIND[type];
  const limit = limits[kind];

  // Redact first, then truncate — see module docs for why the order is
  // load-bearing (a secret straddling the cut point must never be split).
  const { text: redacted, hits } = redactSecrets(block.content);
  const { text: body, truncated, originalBytes } = truncateContent(redacted, limit);

  // Nothing left to say — see the module doc. Checked here, after both
  // steps, so a body that redaction or truncation emptied is caught too.
  if (body.length === 0) return null;

  const attributes: ContentRecordAttributes = {
    'nio.content.type': BLOCK_TYPE_TO_CONTENT_TYPE[type],
    'nio.content.index': block.index,
    'nio.trace_id': traceId,
    'nio.span_id': spanId,
  };

  if (type === 'thinking' && block.fidelity !== undefined) {
    attributes['nio.content.fidelity'] = block.fidelity;
  }

  if (truncated) {
    attributes['nio.content.truncated'] = true;
    attributes['nio.content.original_bytes'] = originalBytes;
  }

  if (hits > 0) {
    attributes['nio.content.redactions'] = hits;
  }

  return { traceId, spanId, body, attributes };
}
