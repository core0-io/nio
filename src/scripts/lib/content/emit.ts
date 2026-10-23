// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import type { ContentRecord, ContentRecordAttributes, ContentType } from '../../../schemas/content.js';
import type { ChatCall } from '../conversation/types.js';
import { redactSecrets } from './redact.js';
import { truncateContent, type ContentLimits } from './truncate.js';

export type { ContentRecord, ContentRecordAttributes } from '../../../schemas/content.js';

/** Text/reasoning belong to chat spans; tool IO is emitted only at its observing tool hook. */
export function buildContentRecords(call: ChatCall, spanId: string, traceId: string, limits: ContentLimits): ContentRecord[] {
  const records: ContentRecord[] = [];
  for (const block of call.blocks) {
    if (block.type !== 'thinking' && block.type !== 'text') continue;
    const record = buildRecord(block.type, block.content, spanId, traceId, limits, {
      'nio.content.index': block.index,
      'nio.content.source': call.source ?? 'conversation',
      'nio.content.call_id': call.callId,
      ...(block.sourceId ? { 'nio.content.source_id': block.sourceId } : {}),
      ...(block.type === 'thinking' ? { 'nio.content.fidelity': block.fidelity ?? 'unknown' } : {}),
    });
    if (record) records.push(record);
  }
  return records;
}

export interface ContentProvenance {
  source?: string;
  sourceId?: string;
  index?: number;
}

export function buildToolInputRecord(input: string, spanId: string, traceId: string, limits: ContentLimits, toolCallId?: string, provenance?: ContentProvenance): ContentRecord | null {
  return buildObservedRecord('tool_input', input, spanId, traceId, limits, toolCallId, provenance);
}

export function buildToolOutputRecord(result: string, spanId: string, traceId: string, limits: ContentLimits, toolCallId?: string, provenance?: ContentProvenance): ContentRecord | null {
  return buildObservedRecord('tool_output', result, spanId, traceId, limits, toolCallId, provenance);
}

export function buildUserPromptRecord(prompt: string, spanId: string, traceId: string, limits: ContentLimits, index = 0, provenance?: ContentProvenance): ContentRecord | null {
  return buildObservedRecord('user_prompt', prompt, spanId, traceId, limits, undefined, { ...provenance, index });
}

function buildObservedRecord(type: 'tool_input' | 'tool_output' | 'user_prompt', text: string, spanId: string, traceId: string, limits: ContentLimits, toolCallId?: string, provenance?: ContentProvenance): ContentRecord | null {
  return buildRecord(type, text, spanId, traceId, limits, {
    'nio.content.index': provenance?.index ?? 0,
    'nio.content.source': provenance?.source ?? 'host-event',
    ...(provenance?.sourceId ? { 'nio.content.source_id': provenance.sourceId } : {}),
    ...(toolCallId ? { 'gen_ai.tool.call.id': toolCallId } : {}),
  });
}

function buildRecord(type: ContentType, text: string, spanId: string, traceId: string, limits: ContentLimits, metadata: Pick<ContentRecordAttributes, 'nio.content.index' | 'nio.content.source'> & Partial<ContentRecordAttributes>): ContentRecord | null {
  if (!spanId || !traceId || text.length === 0) return null;
  // Redaction must see whole credentials, including those straddling the eventual cut.
  const redacted = redactSecrets(text);
  const { text: body, truncated, originalBytes } = truncateContent(redacted.text, limits[type]);
  if (!body) return null;
  return {
    traceId, spanId, body,
    attributes: {
      ...metadata,
      'nio.content.type': type,
      'nio.trace_id': traceId,
      'nio.span_id': spanId,
      ...(truncated ? { 'nio.content.truncated': true, 'nio.content.original_bytes': originalBytes } : {}),
      ...(redacted.hits ? { 'nio.content.redactions': redacted.hits } : {}),
    },
  };
}
