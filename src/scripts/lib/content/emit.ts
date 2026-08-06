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
 *   - `tool_use` blocks: suppressed per tool call, for the ids the span
 *     layer reports in `argumentsOnSpan`. It — not this module — is the
 *     only place that knows whether a tool span existed to carry them.
 *   - `thinking` and `tool_output` are never span-carried (measured p90
 *     7.7 KB / max 32 KB for results), so they are unconditional here.
 */

import type { ChatCall, ContentBlock } from '../conversation/types.js';
import { redactSecrets } from './redact.js';
import { truncateContent, type ContentKind, type ContentLimits } from './truncate.js';
import { buildSpanContent, chatReplyText, spanCarriesWholeContent } from './span-content.js';

/** The subset of `ContentBlock['type']` this module maps from. */
type EmittableBlockType = 'thinking' | 'text' | 'tool_use';

/** Maps a block's type to the `ContentKind` used to look up its byte limit. */
const BLOCK_TYPE_TO_KIND: Record<EmittableBlockType, ContentKind> = {
  thinking: 'thinking',
  text: 'text',
  tool_use: 'tool_input',
};

/**
 * `nio.content.type` values this module can produce.
 *
 * `buildContentRecords` only ever emits the first three — they are the
 * block types a `ChatCall` carries. `tool_output` has no block to come
 * from (a tool result arrives out-of-band, from the hook that observed
 * the tool finish, not from the call that requested it) and is built by
 * `buildToolOutputRecord` instead. `user_prompt` is still carried as a
 * turn-span attribute and has no builder here yet.
 *
 * `tool_input` has TWO producers, deliberately — see
 * `buildToolInputRecord`.
 */
type EmittedContentType = 'thinking' | 'text' | 'tool_input' | 'tool_output';

const BLOCK_TYPE_TO_CONTENT_TYPE: Record<EmittableBlockType, EmittedContentType> = {
  thinking: 'thinking',
  text: 'text',
  tool_use: 'tool_input',
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
  /** Only present on records built from a `tool_use` block. */
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
 * `argumentsOnSpan` holds the `tool_use` ids whose complete arguments the
 * tool span emitted alongside this call already carries. Omitting it
 * (tests, callers with no span layer) means nothing was span-carried and
 * every block is emitted, which is the pre-size-split behaviour.
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
  argumentsOnSpan?: ReadonlySet<string>
): ContentRecord[] {
  const records: ContentRecord[] = [];

  // Computed once per call, not per block: the placement decision is made
  // on the JOINED reply, so the span carries all of it or none of it.
  // Same function the span layer calls, so the two cannot disagree.
  const replyOnSpan = spanCarriesWholeContent(buildSpanContent(chatReplyText(call)));

  for (const block of call.blocks) {
    if (block.type !== 'thinking' && block.type !== 'text' && block.type !== 'tool_use') {
      continue;
    }

    // Already on the span in full — see the module doc.
    if (block.type === 'text' && replyOnSpan) continue;
    if (
      block.type === 'tool_use'
      && block.toolUse !== undefined
      && argumentsOnSpan?.has(block.toolUse.id)
    ) {
      continue;
    }

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
 * Why this exists alongside the `tool_use` block records
 * `buildContentRecords` already produces: those only exist when a
 * `ConversationSource` could be built (a readable transcript, or Hermes's
 * envelope). Without one — no `transcript_path`, an unreadable session
 * file — `endTurn` degrades to the flat `turn → tool` shape AND, before
 * this builder existed, the arguments vanished entirely: the tool span
 * had been switched from `genAiToolCallInputAttributes` to
 * `genAiToolCallIdAttributes`, leaving only the 300-char
 * `nio.tool_summary`. That made the degraded path a net loss against the
 * pre-chat-layer behaviour. This record is emitted from PostToolUse,
 * where the tool span id has been known since PreToolUse, so it needs no
 * source at all.
 *
 * The two producers are NOT deduplicated, on purpose — neither one
 * subsumes the other:
 *
 *   - The `tool_use` block covers calls that never reach PostToolUse:
 *     anything the guard denied, and interrupted calls. Dropping it would
 *     lose exactly the arguments a security reviewer most wants.
 *   - This record covers sessions with no `ConversationSource` at all,
 *     and lands on the TOOL span (next to `tool_output`) rather than on
 *     the chat span.
 *
 * They are cheap to tell apart or collapse downstream: same
 * `nio.content.type`, same `gen_ai.tool.call.id`, different `nio.span_id`
 * (chat span vs. tool span). Bounded 2x on tool arguments only — unlike
 * the per-turn replay this pipeline had to fix elsewhere, it does not
 * grow with session length.
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

  if (type === 'tool_use' && block.toolUse !== undefined) {
    attributes['gen_ai.tool.call.id'] = block.toolUse.id;
  }

  return { traceId, spanId, body, attributes };
}
