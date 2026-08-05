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
 */

import type { ChatCall, ContentBlock } from '../conversation/types.js';
import { redactSecrets } from './redact.js';
import { truncateContent, type ContentKind, type ContentLimits } from './truncate.js';

/** The subset of `ContentBlock['type']` this module maps from. */
type EmittableBlockType = 'thinking' | 'text' | 'tool_use';

/** Maps a block's type to the `ContentKind` used to look up its byte limit. */
const BLOCK_TYPE_TO_KIND: Record<EmittableBlockType, ContentKind> = {
  thinking: 'thinking',
  text: 'text',
  tool_use: 'tool_input',
};

/**
 * `nio.content.type` values this module can produce. `user_prompt` and
 * `tool_output` are valid `ContentKind`s but are populated by other call
 * sites in the span layer (a user prompt isn't a `ChatCall` block; a tool
 * result arrives out-of-band from the tool-use block that requested it) —
 * `buildContentRecords` never emits either.
 */
type EmittedContentType = 'thinking' | 'text' | 'tool_input';

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
 * Build one `ContentRecord` per emittable block in `call`, in block order.
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
  limits: ContentLimits
): ContentRecord[] {
  const records: ContentRecord[] = [];

  for (const block of call.blocks) {
    if (block.type !== 'thinking' && block.type !== 'text' && block.type !== 'tool_use') {
      continue;
    }

    records.push(buildRecord(block, block.type, spanId, traceId, limits));
  }

  return records;
}

function buildRecord(
  block: ContentBlock,
  type: EmittableBlockType,
  spanId: string,
  traceId: string,
  limits: ContentLimits
): ContentRecord {
  const kind = BLOCK_TYPE_TO_KIND[type];
  const limit = limits[kind];

  // Redact first, then truncate — see module docs for why the order is
  // load-bearing (a secret straddling the cut point must never be split).
  const { text: redacted, hits } = redactSecrets(block.content);
  const { text: body, truncated, originalBytes } = truncateContent(redacted, limit);

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
