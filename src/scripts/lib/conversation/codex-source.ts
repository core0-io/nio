// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { readJsonlTail } from './read-jsonl.js';
import type { ChatCall, ContentBlock, ConversationSource } from './types.js';
import { sourceFingerprint } from './shared.js';

interface RawSummaryItem {
  type?: string;
  text?: string;
}

interface RawMessageContentItem {
  type?: string;
  text?: string;
}

interface RawReasoningPayload {
  type: 'reasoning';
  id?: string;
  summary?: RawSummaryItem[];
}

interface RawMessagePayload {
  type: 'message';
  id?: string;
  role?: string;
  content?: RawMessageContentItem[];
}

interface RawFunctionCallPayload {
  type: 'function_call';
  id?: string;
  name?: string;
  arguments?: string;
  call_id?: string;
}

interface RawFunctionCallOutputPayload {
  type: 'function_call_output';
  id?: string;
  call_id?: string;
  output?: string;
}

type RawResponseItemPayload =
  | RawReasoningPayload
  | RawMessagePayload
  | RawFunctionCallPayload
  | RawFunctionCallOutputPayload
  | { type?: string };

interface RawTokenCountInfo {
  last_token_usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cached_input_tokens?: number;
    cache_write_input_tokens?: number;
    reasoning_output_tokens?: number;
  };
}

interface RawTokenCountPayload {
  type: 'token_count';
  info?: RawTokenCountInfo;
}

interface RawTaskCompletePayload {
  type: 'task_complete';
  turn_id?: string;
  time_to_first_token_ms?: number;
}

type RawEventMsgPayload = RawTokenCountPayload | RawTaskCompletePayload | { type?: string };

interface RawTurnContextPayload {
  turn_id?: string;
  model?: string;
  effort?: string;
  summary?: string;
}

interface RawLine {
  type?: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
}

const textPartSchema = z.object({ type: z.string().optional(), text: z.string().optional() }).passthrough();
const entrySchema = z.object({
  type: z.string().optional(), timestamp: z.string().optional(),
  payload: z.object({
    type: z.string().optional(), id: z.string().optional(), role: z.string().optional(),
    model: z.string().optional(), name: z.string().optional(), arguments: z.string().optional(),
    call_id: z.string().optional(), summary: z.array(textPartSchema).optional(),
    content: z.array(textPartSchema).optional(), time_to_first_token_ms: z.number().optional(),
    info: z.object({
      last_token_usage: z.object({
        input_tokens: z.number().optional(), output_tokens: z.number().optional(),
        cached_input_tokens: z.number().optional(), cache_write_input_tokens: z.number().optional(),
        reasoning_output_tokens: z.number().optional(),
      }).passthrough().optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();

type PartialBlock = ContentBlock;

/** A call under construction; summary boundaries are exposed, not raw encrypted reasoning. */
interface CallBuilder {
  callId: string;
  model?: string;
  startMs: number;
  endMs: number;
  usage?: NonNullable<ChatCall['usage']>;
  timeToFirstTokenMs?: number;
  blocks: PartialBlock[];
  isSidechain: boolean;
}

function toMs(timestamp: string | undefined): number {
  const parsed = timestamp ? Date.parse(timestamp) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function finaliseCall(builder: CallBuilder): ChatCall {
  return {
    callId: builder.callId,
    source: 'codex-rollout',
    model: builder.model,
    startMs: builder.startMs,
    endMs: builder.endMs,
    timing: 'exact',
    usage: builder.usage,
    timeToFirstTokenMs: builder.timeToFirstTokenMs,
    blocks: builder.blocks,
    isSidechain: builder.isSidechain,
  };
}

export function createCodexSource(rolloutPath: string): ConversationSource {
  return {
    name: 'codex-rollout',
    callsSince(sinceMs: number): ChatCall[] {
      const lines = readJsonlTail(rolloutPath);
      const builders: CallBuilder[] = [];
      let currentModel: string | undefined;
      const occurrences = new Map<string, number>();
      let active: CallBuilder | undefined;

      const current = (): CallBuilder | undefined => active;

      lines.forEach((line) => {
        let entry: RawLine;
        try {
          const parsed = entrySchema.safeParse(JSON.parse(line));
          if (!parsed.success) return;
          entry = parsed.data;
        } catch {
          return; // malformed line: skip, don't abort the rest of the file
        }
        if (!entry || typeof entry !== 'object') return;

        const ms = toMs(entry.timestamp);

        if (entry.type === 'turn_context') {
          const payload = entry.payload as RawTurnContextPayload | undefined;
          if (payload && typeof payload.model === 'string') currentModel = payload.model;
          active = undefined;
          return;
        }

        if (entry.type === 'response_item') {
          const payload = entry.payload as RawResponseItemPayload | undefined;
          if (!payload || typeof payload !== 'object') return;

          switch (payload.type) {
            case 'reasoning': {
              const r = payload as RawReasoningPayload;
              const blocks: PartialBlock[] = Array.isArray(r.summary)
                ? r.summary.flatMap((s, index) => s && s.type === 'summary_text' && typeof s.text === 'string'
                    ? [{ type: 'thinking' as const, index, content: s.text, fidelity: 'summary' as const, ...(r.id ? { sourceId: `${r.id}:${index}` } : {}) }]
                    : [])
                : [];
              builders.push({
                callId: typeof r.id === 'string' && r.id.length > 0 ? r.id : sourceFingerprint('codex', entry, occurrences),
                model: currentModel,
                startMs: ms,
                endMs: ms,
                blocks,
                isSidechain: false,
              });
              active = builders[builders.length - 1];
              break;
            }
            case 'function_call': {
              const fc = payload as RawFunctionCallPayload;
              const c = current();
              if (!c) break; // no open call to attach to; drop rather than fabricate one
              if (typeof fc.name === 'string' && typeof fc.call_id === 'string' && fc.call_id) {
                const input = typeof fc.arguments === 'string' ? fc.arguments : '{}';
                c.blocks.push({
                  type: 'tool_use',
                  index: c.blocks.length ? c.blocks[c.blocks.length - 1]!.index + 1 : 0,
                  ...(fc.id ? { sourceId: fc.id } : {}),
                  content: input,
                  toolUse: { id: fc.call_id, name: fc.name, input },
                });
              }
              c.endMs = ms;
              break;
            }
            case 'function_call_output': {
              const c = current();
              if (c) c.endMs = ms;
              break;
            }
            case 'message': {
              const m = payload as RawMessagePayload;
              if (m.role !== 'assistant') break; // user / developer input, not output
              let c = current();
              if (!c) {
                c = {
                  callId: m.id || sourceFingerprint('codex', entry, occurrences),
                  model: currentModel,
                  startMs: ms,
                  endMs: ms,
                  blocks: [],
                  isSidechain: false,
                };
                builders.push(c);
                active = c;
              }
              const offset = c.blocks.length ? c.blocks[c.blocks.length - 1]!.index + 1 : 0;
              if (Array.isArray(m.content)) {
                m.content.forEach((part, index) => {
                  if (part && typeof part.text === 'string' && part.text.length > 0) {
                    c!.blocks.push({ type: 'text', index: offset + index, content: part.text, ...(m.id ? { sourceId: `${m.id}:${index}` } : {}) });
                  }
                });
              }
              c.endMs = ms;
              break;
            }
            default:
              break;
          }
          return;
        }

        if (entry.type === 'event_msg') {
          const payload = entry.payload as RawEventMsgPayload | undefined;
          if (!payload || typeof payload !== 'object') return;

          switch (payload.type) {
            case 'token_count': {
              const tc = payload as RawTokenCountPayload;
              const usage = tc.info?.last_token_usage;
              const c = current();
              if (c) {
                if (usage) {
                  const mapped: NonNullable<ChatCall['usage']> = { ...c.usage };
                  if (typeof usage.input_tokens === 'number') mapped.input = usage.input_tokens;
                  if (typeof usage.output_tokens === 'number') mapped.output = usage.output_tokens;
                  if (typeof usage.cached_input_tokens === 'number') mapped.cacheRead = usage.cached_input_tokens;
                  if (typeof usage.cache_write_input_tokens === 'number') mapped.cacheWrite = usage.cache_write_input_tokens;
                  if (typeof usage.reasoning_output_tokens === 'number') mapped.reasoning = usage.reasoning_output_tokens;
                  c.usage = mapped;
                }
                c.endMs = ms;
              }
              break;
            }
            case 'task_complete': {
              const t = payload as RawTaskCompletePayload;
              const c = current();
              if (c) {
                if (typeof t.time_to_first_token_ms === 'number') {
                  c.timeToFirstTokenMs = t.time_to_first_token_ms;
                }
                c.endMs = ms;
              }
              break;
            }
            default:
              break;
          }
        }
      });

      return builders.map(finaliseCall).filter((c) => c.startMs >= sinceMs);
    },
  };
}
