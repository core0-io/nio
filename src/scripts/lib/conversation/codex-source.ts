// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Codex rollout → ChatCall[].
 *
 * Codex writes a flat `response_item` / `event_msg` stream, not one
 * record per call the way Claude Code does (see `claude-code-source.ts`).
 * `turn_id` is a *turn*-level id, shared by every entry in a turn, so
 * call boundaries have to be inferred from ordering instead: each
 * `reasoning` entry marks the start of a new LLM call —
 *
 *   reasoning → function_call → reasoning → function_call → … → message(assistant)
 *
 * — with the trailing `message` (role `assistant`) closing out
 * whichever call is currently open.
 *
 * Codex's `thinking` is summary-only. `summary[].text` is a short step
 * title (~30-50 chars); the actual reasoning trace is only available
 * encrypted (`encrypted_content`, Fernet-sealed, opaque to the client)
 * and there is no plaintext `content` field to fall back to. So every
 * thinking block produced here is `fidelity: 'summary'` — never
 * `'full'` — and that must not be "simplified" back to `'full'`, since
 * it's the one signal telling a downstream consumer this is a step
 * title, not a reasoning trace (see `ThinkingFidelity` in `types.ts`).
 *
 * A `reasoning` entry with an empty `summary[]` is the normal shape at
 * `effort=medium` and below, not a malformed record — it must open a
 * call (so the following function_call/message still lands somewhere)
 * but must NOT synthesise a thinking block out of nothing.
 */

import { readJsonlTail } from './read-jsonl.js';
import type { ChatCall, ContentBlock, ConversationSource } from './types.js';

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
  // Mirrors codex-rs's TokenUsage struct. Verified against a live Codex
  // CLI session: last_token_usage carries
  // ['cache_write_input_tokens', 'cached_input_tokens', 'input_tokens',
  // 'output_tokens', 'reasoning_output_tokens', 'total_tokens'].
  // total_tokens has no home in ChatCall.usage and is dropped.
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

type PartialBlock = Omit<ContentBlock, 'index'>;

/** A call under construction. `blocks` carries no `index` until finalised. */
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

function extractText(content: RawMessageContentItem[] | undefined): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('');
}

function finaliseCall(builder: CallBuilder): ChatCall {
  return {
    callId: builder.callId,
    model: builder.model,
    startMs: builder.startMs,
    endMs: builder.endMs,
    // Codex's task_complete event carries real started_at/completed_at
    // timestamps for the turn, and function_call/function_call_output/
    // token_count entries push endMs forward as the call progresses —
    // both ends are genuinely platform-reported, unlike the other three
    // sources (see TimingFidelity in types.ts).
    timing: 'exact',
    usage: builder.usage,
    timeToFirstTokenMs: builder.timeToFirstTokenMs,
    blocks: builder.blocks.map((b, index) => ({ ...b, index })),
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

      const current = (): CallBuilder | undefined => builders[builders.length - 1];

      lines.forEach((line, ordinal) => {
        let entry: RawLine;
        try {
          entry = JSON.parse(line) as RawLine;
        } catch {
          return; // malformed line: skip, don't abort the rest of the file
        }
        // JSON.parse succeeds (and returns null) for a line that's just
        // the literal `null`, and succeeds with a non-object for a bare
        // string/number/array line too — none of those throw above, so
        // this guard is the only thing standing between a stray `null`
        // line and a TypeError on `entry.timestamp` that would abort
        // every call still left in the file. Mirrors hermes-source.ts /
        // openclaw-source.ts's entry guards.
        if (!entry || typeof entry !== 'object') return;

        const ms = toMs(entry.timestamp);

        if (entry.type === 'turn_context') {
          const payload = entry.payload as RawTurnContextPayload | undefined;
          if (payload && typeof payload.model === 'string') currentModel = payload.model;
          return;
        }

        if (entry.type === 'response_item') {
          const payload = entry.payload as RawResponseItemPayload | undefined;
          if (!payload || typeof payload !== 'object') return;

          switch (payload.type) {
            case 'reasoning': {
              const r = payload as RawReasoningPayload;
              const blocks: PartialBlock[] = Array.isArray(r.summary)
                ? r.summary
                    .filter((s) => s && s.type === 'summary_text' && typeof s.text === 'string')
                    .map((s) => ({ type: 'thinking' as const, content: s.text as string, fidelity: 'summary' as const }))
                : [];
              builders.push({
                callId: typeof r.id === 'string' && r.id.length > 0 ? r.id : `codex-${ordinal}`,
                model: currentModel,
                startMs: ms,
                endMs: ms,
                blocks,
                isSidechain: false,
              });
              break;
            }
            case 'function_call': {
              const fc = payload as RawFunctionCallPayload;
              const c = current();
              if (!c) break; // no open call to attach to; drop rather than fabricate one
              if (typeof fc.name === 'string') {
                const input = typeof fc.arguments === 'string' ? fc.arguments : '{}';
                c.blocks.push({
                  type: 'tool_use',
                  content: input,
                  toolUse: { id: typeof fc.call_id === 'string' ? fc.call_id : `codex-call-${ordinal}`, name: fc.name, input },
                });
              }
              c.endMs = ms;
              break;
            }
            case 'function_call_output': {
              // Result belongs to the tool span, not the chat content —
              // no block, but it still extends the call's time range.
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
                  callId: `codex-${ordinal}`,
                  model: currentModel,
                  startMs: ms,
                  endMs: ms,
                  blocks: [],
                  isSidechain: false,
                };
                builders.push(c);
              }
              const text = extractText(m.content);
              if (text.length > 0) c.blocks.push({ type: 'text', content: text });
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
