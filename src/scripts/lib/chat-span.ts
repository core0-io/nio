// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from 'node:crypto';
import type { ChatCall } from './conversation/types.js';

export interface ChatSpanNode {
  span_id: string;
  call: ChatCall;
}

/** Operational metadata and content associations only; bodies belong exclusively to Logs. */
export function chatSpanAttributes(call: ChatCall): Record<string, unknown> {
  let thinkingChars = 0;
  let textChars = 0;
  const toolCallIds: string[] = [];
  for (const block of call.blocks) {
    if (block.type === 'thinking') thinkingChars += block.content.length;
    else if (block.type === 'text') textChars += block.content.length;
    else if (block.toolUse?.id) toolCallIds.push(block.toolUse.id);
  }
  const usage = call.usage ?? {};
  return {
    'gen_ai.operation.name': 'chat',
    ...(call.model ? { 'gen_ai.request.model': call.model } : {}),
    'gen_ai.response.id': call.callId,
    ...(typeof usage.input === 'number' ? { 'gen_ai.usage.input_tokens': usage.input } : {}),
    ...(typeof usage.output === 'number' ? { 'gen_ai.usage.output_tokens': usage.output } : {}),
    ...(typeof usage.cacheRead === 'number' ? { 'gen_ai.usage.cache_read.input_tokens': usage.cacheRead } : {}),
    ...(typeof usage.cacheWrite === 'number' ? { 'gen_ai.usage.cache_creation.input_tokens': usage.cacheWrite } : {}),
    ...(typeof usage.reasoning === 'number' ? { 'gen_ai.usage.reasoning.output_tokens': usage.reasoning } : {}),
    ...(call.stopReason ? { 'gen_ai.response.finish_reasons': call.stopReason } : {}),
    ...(typeof call.timeToFirstTokenMs === 'number' ? { 'gen_ai.response.time_to_first_token_ms': call.timeToFirstTokenMs } : {}),
    'nio.content.thinking_chars': thinkingChars,
    'nio.content.text_chars': textChars,
    'nio.content.blocks': call.blocks.length,
    'nio.chat.is_sidechain': call.isSidechain,
    'nio.chat.timing': call.timing,
    'nio.content.source': 'logs',
    ...(call.source ? { 'nio.chat.source': call.source } : {}),
    ...(toolCallIds.length ? { 'nio.chat.tool_call_ids': toolCallIds } : {}),
  };
}

export function chatSpanName(call: ChatCall): string {
  return call.model ? `chat ${call.model}` : 'chat';
}

/** Chat and tool spans remain siblings; exact host tool IDs provide their association. */
export function buildChatSpanNodes(calls: ChatCall[]): ChatSpanNode[] {
  return calls.map((call) => ({ span_id: randomBytes(8).toString('hex'), call }));
}
