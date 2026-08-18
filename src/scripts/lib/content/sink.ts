// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * The one place the content pipeline meets a real OTEL logger provider.
 *
 * `content/emit.ts` stays pure (records in, records out) and
 * `traces-collector.ts` stays free of the logs SDK; this module joins
 * the two so the span layer can hand a chat call to the logs signal the
 * moment it has a span id for it.
 *
 * Gating: the returned sink is `undefined` whenever there is no logger
 * provider. That is not a defensive nicety — it IS the `/nio-monitor`
 * master switch. `collector-hook.ts` and `hook-cli.ts`, the entry points
 * that reach these functions, build a logger provider only for a
 * monitored session and pass `null` otherwise, so an unarmed session
 * cannot reach an emit path from here at all.
 */

import type { LoggerProvider } from '@opentelemetry/sdk-logs';
import type { ChatContentSink } from '../traces-collector.js';
import type { ContentLimits } from './truncate.js';
import { buildContentRecords, buildToolInputRecord, buildToolOutputRecord } from './emit.js';
import { emitContentRecords } from '../logs-collector.js';

/**
 * Build the sink `endTurn` calls once per chat span, or `undefined` when
 * content must not be captured (no provider — see the module doc).
 *
 * Tool arguments do NOT come through here: they are owned by the site
 * that emits the tool's span, which is the only place that can tell
 * whether the span carried the whole body, and whether it will be sent
 * at all (see `buildToolInputRecord`).
 *
 * Failures are swallowed here rather than propagated: the caller is in
 * the middle of emitting a span tree, and losing the tree because one
 * content record could not be serialised would trade a large signal for
 * a small one.
 */
export function createContentSink(
  provider: LoggerProvider | null | undefined,
  limits: ContentLimits,
): ChatContentSink | undefined {
  if (!provider) return undefined;
  return (call, spanId, traceId) => {
    try {
      emitContentRecords(
        provider,
        buildContentRecords(call, spanId, traceId, limits),
      );
    } catch {
      // Non-critical — content capture must never break span export.
    }
  };
}

/**
 * Emit one finished tool call's output, associated with the tool span id
 * minted at PreToolUse.
 *
 * No-op without a provider (unmonitored session) or without a span/trace
 * id to associate to — an unassociated content record cannot be joined
 * back to anything and is just cost.
 */
export function emitToolOutputContent(
  provider: LoggerProvider | null | undefined,
  limits: ContentLimits,
  opts: {
    result: string;
    spanId: string;
    traceId: string;
    toolCallId?: string;
  },
): void {
  if (!provider) return;
  if (!opts.spanId || !opts.traceId) return;
  if (!opts.result) return;
  try {
    // `null` when the body came out empty after redaction/truncation —
    // an empty record is not worth a log line (see `emit.ts`'s doc).
    const record = buildToolOutputRecord(opts.result, opts.spanId, opts.traceId, limits, opts.toolCallId);
    if (record) emitContentRecords(provider, [record]);
  } catch {
    // Non-critical — see createContentSink.
  }
}

/**
 * Emit one tool call's ARGUMENTS against the tool span id minted at
 * PreToolUse.
 *
 * Deliberately independent of `ConversationSource`: this is what keeps
 * tool arguments on the wire when a session has no transcript to replay.
 * WHEN a caller may reach here differs by family — the hook path only
 * when the span could not carry the whole body, the in-process path
 * unconditionally; see `buildToolInputRecord` for both rules and why
 * they differ. Same gating as `emitToolOutputContent` — no provider, no
 * ids, or nothing to say means nothing is emitted.
 */
export function emitToolInputContent(
  provider: LoggerProvider | null | undefined,
  limits: ContentLimits,
  opts: {
    input: string;
    spanId: string;
    traceId: string;
    toolCallId?: string;
  },
): void {
  if (!provider) return;
  if (!opts.spanId || !opts.traceId) return;
  if (!opts.input) return;
  try {
    // `null` when the body came out empty — see `emitToolOutputContent`.
    const record = buildToolInputRecord(opts.input, opts.spanId, opts.traceId, limits, opts.toolCallId);
    if (record) emitContentRecords(provider, [record]);
  } catch {
    // Non-critical — see createContentSink.
  }
}
