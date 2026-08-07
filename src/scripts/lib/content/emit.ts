// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Turns one `ChatCall`'s content blocks into OTLP-shaped log records.
 *
 * This module produces records only — it does not send them. Emission
 * needs a real OTEL logger provider, which only exists once the span
 * layer wires a call up to its trace/span; wiring that in here would
 * force every test in this file to stand up an OTEL SDK. Keeping
 * `buildContentRecords` a pure function (`ChatCall` + ids + limits in,
 * `ContentRecord[]` out) lets the redaction/truncation/mapping logic be
 * tested in complete isolation from OTEL, and lets the span layer decide
 * *when* and *how* to emit without this module knowing anything about
 * providers.
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
 * Empty bodies are never emitted
 * -------------------------------------------------
 * A block whose body is empty *after* redaction and truncation produces
 * no record at all. This is not a micro-optimisation: measured live on
 * 2026-08-06, every `thinking` record on the wire had a zero-length body
 * (21/21), because that Claude Code session's transcript held 382
 * `thinking` blocks with `thinking: ""` and only the signature filled in.
 * Emitted as-is, each one carried `nio.content.fidelity = 'full'` and
 * read downstream as "the model reasoned, and its reasoning was blank" —
 * an assertion about the model that the data does not support. Silence is
 * the honest signal.
 *
 * The rule is per-kind-agnostic on purpose: an empty body is contentless
 * under `text`, `tool_input` and `tool_output` just as much as under
 * `thinking`. And the check has to run on the FINAL body — the input to
 * `truncateContent`, not its output, is what an earlier length check
 * would see, and redaction can rewrite the body in between.
 *
 * Content the SPAN already carries is not repeated here
 * -------------------------------------------------
 * Small content lives on the span, large content lives here — see
 * `span-content.ts` for the rule and the measurements behind it. This
 * module is the second half of that decision: whatever the span carried
 * in full, it does NOT emit, so no body is ever on the wire twice.
 *
 *   - `text` blocks: suppressed when the call's joined reply fit
 *     `nio.chat.reply` in full. A reply too big for the budget is kept
 *     here at full per-kind fidelity, and the span's copy is flagged
 *     `nio.content.truncated`.
 *   - `thinking` is never span-carried (measured p90 7.7 KB), so it is
 *     unconditional here.
 *
 * Why `tool_use` blocks produce NOTHING here
 * -------------------------------------------------
 * They used to, and that was the one place a body could reach the wire
 * three times: `gen_ai.tool.call.arguments` on the tool span, the
 * out-of-band `tool_input` record the tool's own post-side event emits,
 * and a third copy from this module. The suppression that was supposed
 * to prevent it (`argumentsOnSpan`, an id set derived from
 * `state.deferred_spans`) went permanently inert when tool spans became
 * eager — `deferred_spans` is always empty now — so every tool call in
 * a session with a conversation source shipped its arguments three
 * times.
 *
 * The fix is structural rather than another suppression flag. A tool
 * call's arguments are owned by the SITE THAT EMITS ITS SPAN, which is
 * the only place that knows, from the one `SpanContent` value it is
 * holding, whether the span carried the whole body or a truncated
 * preview — and can emit the full-fidelity `tool_input` record in the
 * same breath when it could not (`buildToolInputRecord`). That decision
 * is local, needs no cross-event state, and cannot disagree with itself.
 *
 * This module runs at the END of the turn, from replayed history. It
 * cannot see whether a span was emitted, so any rule it applied would be
 * a guess. What it uniquely knew — which chat call issued which tool
 * call — is not a body at all, and now rides the chat span as
 * `nio.chat.tool_call_ids` (see `chat-span.ts`), where it costs a few
 * dozen bytes instead of a duplicate of the arguments and needs no log
 * join to read.
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
 * `buildContentRecords` only ever emits the first two — they are the
 * block types a `ChatCall` carries that no span owns. `tool_input` and
 * `tool_output` both come from the hook that observed the tool, not from
 * the call that requested it, and are built by `buildToolInputRecord` /
 * `buildToolOutputRecord`. `user_prompt` is still carried as a turn-span
 * attribute and has no builder here yet.
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
 * `tool_use` blocks produce no record here at all — the tool's own span
 * site owns its arguments; see the module doc.
 *
 * Pure function: no IO, no OTEL provider, no global state. `spanId` /
 * `traceId` are supplied by the caller (the span layer), which is the
 * only place that knows the OTEL span a given `ChatCall` was recorded
 * under.
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
 * the TOOL span's id (pre-allocated at PreToolUse), not a chat span's.
 * That is what lets this go out as the tool finishes rather than waiting
 * for the turn to close — the tool span carrying the same id is emitted
 * later, and the two join on the backend regardless of arrival order.
 *
 * Same pure-function contract, and the same redact-then-truncate order,
 * as `buildContentRecords`; see the module docs for why that order is
 * load-bearing. Returns `null` when the final body is empty — same rule,
 * same reason, as the block path.
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
 * This is the ONLY producer of `tool_input` records, and it is the LOG
 * side of the size rule rather than a second copy of it. The contract
 * every caller must honour:
 *
 *   **Emit this only when the tool span you are emitting could not carry
 *   the whole body** — i.e. `!spanCarriesWholeContent(spanArgs)` for the
 *   very `SpanContent` you just put on the span as
 *   `gen_ai.tool.call.arguments`. Same value, same statement, so the two
 *   signals cannot disagree about who owns the bytes.
 *
 * Callers, all of which are span-emitting sites:
 *
 *   - `collector-core.ts` PostToolUse — the hook family's normal path.
 *   - `guard-hook.ts` / `hook-cli.ts` block path — a denied call's span
 *     is emitted synchronously there and its post-side event never
 *     fires, so that site owns its arguments too.
 *   - `plugin-runtime.ts` PreToolUse — the in-process family emits this
 *     unconditionally, deliberately: the params are only in hand at the
 *     pre side, and the record is designed to OUTLIVE a span that a
 *     mid-turn crash or disarm may never send (see `emitToolContent`).
 *     That family therefore keeps a bounded second copy of small
 *     arguments; the hook family does not.
 *
 * It needs no `ConversationSource`, which is what keeps arguments on the
 * wire for a session with no readable transcript — the regression this
 * builder was originally added to fix. It lands on the TOOL span, next
 * to `tool_output`; which chat call issued that tool is carried by the
 * chat span's `nio.chat.tool_call_ids`, not by a second content record.
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
 * `buildRecord`; see the module docs for why that order is load-bearing.
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
