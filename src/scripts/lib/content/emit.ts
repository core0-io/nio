// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { contentRecordSchema, type ContentPart, type ContentRecord } from '../../../schemas/content.js';
import { blockOrderIsSane, type AssistantMessage } from '../conversation/types.js';
import { redactSecrets } from './redact.js';
import { truncateContent, type ContentKind, type ContentLimits } from './truncate.js';

export type { ContentRecord, ContentRecordAttributes } from '../../../schemas/content.js';
export interface UserPromptContent {
  prompt: string;
  blocks?: { text: string; index: number; sourceId?: string }[];
  spanId: string;
  traceId: string;
  /** Known identities are accepted for callers' internal deduplication only. */
  source?: string;
  sourceId?: string;
  id?: string;
  index?: number;
}
interface ObservedPart { type: ContentKind; content: string }

/** One record per observed message; unsupported parts are intentionally omitted. */
export function buildContentRecords(message: AssistantMessage, spanId: string, traceId: string, limits: ContentLimits): ContentRecord[] {
  if (!message || typeof message.id !== 'string' || !message.id || !Array.isArray(message.blocks)
    || !message.blocks.every((block) => block && typeof block.content === 'string') || !blockOrderIsSane(message)) return [];
  const record = buildRecord(message.blocks.filter((block) => block.type === 'thinking' || block.type === 'text'),
    'assistant', spanId, traceId, limits, message.finishReason);
  return record ? [record] : [];
}

/** A submitted prompt is one observed user message, never the complete model input. */
export function buildUserPromptRecord(opts: UserPromptContent, limits: ContentLimits): ContentRecord | null {
  if (!opts || typeof opts.prompt !== 'string') return null;
  let parts: ObservedPart[];
  if (opts.blocks !== undefined) {
    if (!Array.isArray(opts.blocks) || !opts.blocks.every((block, i) => block && typeof block.text === 'string'
      && Number.isInteger(block.index) && block.index >= 0 && (i === 0 || block.index > opts.blocks![i - 1]!.index))) return null;
    parts = opts.blocks.map((block) => ({ type: 'user_prompt', content: block.text }));
  } else parts = [{ type: 'user_prompt', content: opts.prompt }];
  return buildRecord(parts, 'user', opts.spanId, opts.traceId, limits);
}

function buildRecord(observed: ObservedPart[], role: 'user' | 'assistant', spanId: string, traceId: string,
  limits: ContentLimits, finishReason?: string): ContentRecord | null {
  if (!/^[0-9a-f]{16}$/.test(spanId) || !/^[0-9a-f]{32}$/.test(traceId)) return null;
  const parts: ContentPart[] = [];
  let redactions = 0;
  let originalBytes = 0;
  let truncated = false;
  for (const part of observed) {
    if (!part.content) continue;
    const limit = limits[part.type];
    if (!Number.isFinite(limit) || limit < 0) return null;
    // Redaction sees the entire property, including credentials crossing the byte cut.
    const redacted = redactSecrets(part.content);
    const bounded = truncateContent(redacted.text, limit);
    redactions += redacted.hits;
    originalBytes += bounded.originalBytes;
    truncated ||= bounded.truncated;
    if (bounded.text) parts.push({ type: part.type === 'thinking' ? 'reasoning' : 'text', content: bounded.text });
  }
  if (!parts.length) return null;
  const auxiliary = {
    'nio.trace_id': traceId,
    'nio.span_id': spanId,
    ...(truncated ? { 'nio.content.truncated': true, 'nio.content.original_bytes': originalBytes } : {}),
    ...(redactions ? { 'nio.content.redactions': redactions } : {}),
  };
  const result = contentRecordSchema.safeParse({
    traceId, spanId,
    attributes: role === 'user'
      ? { ...auxiliary, 'gen_ai.input.messages': [{ role, parts }] }
      : { ...auxiliary, 'gen_ai.output.messages': [{ role, parts, finish_reason: finishReason ?? 'unknown' }] },
  });
  return result.success ? result.data : null;
}
