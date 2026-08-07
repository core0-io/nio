// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Replay source over Pi's session JSONL.
 *
 * Pi persists every session to `~/.pi/agent/sessions/`, organised by
 * working directory, in a tree-structured JSONL (format version 3). An
 * extension gets the active file from `ctx.sessionManager.getSessionFile()`,
 * which returns null for an ephemeral session — the binding treats that as
 * "no source", the same degradation any platform without a transcript gets.
 *
 * Only `type: "message"` entries with `message.role === "assistant"`
 * produce calls. Other entry types (model_change, thinking_level_change,
 * compaction, branch_summary, custom, label, session_info) are skipped:
 * they describe the session, not an LLM invocation.
 *
 * Content blocks are exactly four shapes — `text`, `image`, `thinking`
 * (field `thinking`, not `text`), and `toolCall` (fields `id`, `name`,
 * `arguments`). Verified against the installed
 * `@earendil-works/pi-coding-agent` 0.83.0 `docs/session-format.md`.
 */

import { readJsonlTail } from './read-jsonl.js';
import { fidelityForModel, toUsage } from './shared.js';
import type { ChatCall, ContentBlock, ConversationSource } from './types.js';

interface PiContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

/** One assistant entry, flattened to what call construction needs. */
interface PiAssistantEntry {
  msg: Record<string, unknown>;
  /** Unix ms — from `message.timestamp`, falling back to the entry's ISO stamp. */
  ts: number;
  /** The ENTRY's id (`m2`), which is where Pi puts it — not `message.id`. */
  entryId?: string;
}

function blocksFrom(content: unknown, model: unknown, provider: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  const out: ContentBlock[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const b = raw as PiContentBlock;
    if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.length > 0) {
      out.push({
        type: 'thinking',
        index: out.length,
        content: b.thinking,
        fidelity: fidelityForModel(model, provider),
      });
    } else if (b.type === 'text' && typeof b.text === 'string' && b.text.length > 0) {
      out.push({ type: 'text', index: out.length, content: b.text });
    } else if (b.type === 'toolCall' && typeof b.id === 'string' && typeof b.name === 'string') {
      out.push({
        type: 'tool_use',
        index: out.length,
        content: '',
        toolUse: { id: b.id, name: b.name, input: JSON.stringify(b.arguments ?? {}) },
      });
    }
    // `image` blocks carry base64 payloads and no reasoning or action
    // signal; deliberately dropped rather than inflating content records.
  }
  return out;
}

export function createPiSource(sessionFilePath: string): ConversationSource {
  return {
    name: 'pi-session',
    callsSince(sinceMs: number): ChatCall[] {
      const lines = readJsonlTail(sessionFilePath);
      const assistants: PiAssistantEntry[] = [];
      for (const line of lines) {
        let entry: unknown;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        // JSON.parse('null') returns null WITHOUT throwing — the catch
        // above does not cover it, and the property reads below would
        // then throw and abort the whole loop. Same for `[1,2,3]`,
        // `"str"` and `42`, which parse to non-record values.
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        if (e.type !== 'message') continue;
        const msg = e.message as Record<string, unknown> | undefined;
        if (!msg || typeof msg !== 'object' || msg.role !== 'assistant') continue;
        const ts =
          typeof msg.timestamp === 'number'
            ? msg.timestamp
            : Date.parse(String(e.timestamp ?? '')) || 0;
        assistants.push({
          msg,
          ts,
          entryId: typeof e.id === 'string' ? e.id : undefined,
        });
      }

      const calls: ChatCall[] = [];
      assistants.forEach(({ msg, ts, entryId }, i) => {
        if (ts < sinceMs) return;
        const blocks = blocksFrom(msg.content, msg.model, msg.provider);
        if (blocks.length === 0) return;
        // End is the next assistant message's start when there is one.
        // Both ends are never reported by Pi, so this is 'inferred'.
        const next = assistants[i + 1];
        calls.push({
          callId: entryId ?? (typeof msg.id === 'string' ? msg.id : `pi-${i}`),
          model: typeof msg.model === 'string' ? msg.model : undefined,
          startMs: ts,
          endMs: next ? next.ts : ts,
          timing: 'inferred',
          usage: toUsage(msg.usage),
          stopReason: typeof msg.stopReason === 'string' ? msg.stopReason : undefined,
          blocks,
          isSidechain: false,
        });
      });
      return calls;
    },
  };
}
