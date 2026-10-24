// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import type { LoggerProvider } from '@opentelemetry/sdk-logs';
import type { AssistantMessage } from '../conversation/types.js';
import type { ContentLimits } from './truncate.js';
import { buildContentRecords, buildUserPromptRecord, type UserPromptContent } from './emit.js';
import { emitContentRecords } from '../logs-collector.js';

export type { UserPromptContent } from './emit.js';

/** No provider means no capture; callers own consent, endpoint gating and replay identity. */
export function emitAssistantContent(provider: LoggerProvider | null | undefined, limits: ContentLimits,
  message: AssistantMessage, spanId: string, traceId: string): void {
  if (!provider) return;
  try {
    emitContentRecords(provider, buildContentRecords(message, spanId, traceId, limits));
  } catch {
    // Best-effort telemetry must not interrupt the host or operational span export.
  }
}

export function emitUserPromptContent(provider: LoggerProvider | null | undefined, limits: ContentLimits, opts: UserPromptContent): void {
  if (!provider) return;
  try {
    const record = buildUserPromptRecord(opts, limits);
    if (record) emitContentRecords(provider, [record]);
  } catch {
    // Best-effort telemetry must not interrupt prompt submission.
  }
}
