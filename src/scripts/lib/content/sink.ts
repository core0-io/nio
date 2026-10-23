// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import type { LoggerProvider } from '@opentelemetry/sdk-logs';
import type { ChatCall } from '../conversation/types.js';
import type { ContentRecord } from '../../../schemas/content.js';
import type { ContentLimits } from './truncate.js';
import { buildContentRecords, buildToolInputRecord, buildToolOutputRecord, buildUserPromptRecord, type ContentProvenance } from './emit.js';
import { emitContentRecords } from '../logs-collector.js';

export type ChatContentSink = (call: ChatCall, spanId: string, traceId: string) => void;

/** No provider means no content capture; caller owns consent and endpoint gating. */
export function createContentSink(provider: LoggerProvider | null | undefined, limits: ContentLimits): ChatContentSink | undefined {
  if (!provider) return undefined;
  return (call, spanId, traceId) => {
    try {
      emitContentRecords(provider, buildContentRecords(call, spanId, traceId, limits));
    } catch {
      // Content export must not interrupt the host or its operational span export.
    }
  };
}

type Association = ContentProvenance & { spanId: string; traceId: string; toolCallId?: string };

export function emitToolInputContent(provider: LoggerProvider | null | undefined, limits: ContentLimits, opts: Association & { input: string }): void {
  if (!provider || !opts.spanId || !opts.traceId || !opts.input) return;
  try {
    emitRecord(provider, buildToolInputRecord(opts.input, opts.spanId, opts.traceId, limits, opts.toolCallId, opts));
  } catch {
    // Best-effort telemetry must not break tool execution.
  }
}

export function emitToolOutputContent(provider: LoggerProvider | null | undefined, limits: ContentLimits, opts: Association & { result: string }): void {
  if (!provider || !opts.spanId || !opts.traceId || !opts.result) return;
  try {
    emitRecord(provider, buildToolOutputRecord(opts.result, opts.spanId, opts.traceId, limits, opts.toolCallId, opts));
  } catch {
    // Best-effort telemetry must not break tool execution.
  }
}

export function emitUserPromptContent(provider: LoggerProvider | null | undefined, limits: ContentLimits, opts: Omit<Association, 'toolCallId'> & { prompt: string }): void {
  if (!provider || !opts.spanId || !opts.traceId || !opts.prompt) return;
  try {
    emitRecord(provider, buildUserPromptRecord(opts.prompt, opts.spanId, opts.traceId, limits, opts.index ?? 0, opts));
  } catch {
    // Best-effort telemetry must not break prompt submission.
  }
}

function emitRecord(provider: LoggerProvider, record: ContentRecord | null): void {
  if (record) emitContentRecords(provider, [record]);
}
