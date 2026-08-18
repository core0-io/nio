// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * The per-session conversation-event cap must be denominated in LLM
 * calls, not in host deliveries.
 *
 * `MAX_CONVERSATION_EVENTS` was sized against OpenClaw, where the host
 * publishes exactly one `llm_output` per LLM call and never republishes
 * it — there, 200 accumulated events IS 200 calls, and
 * `plugin-runtime.test.ts`'s `'caps accumulated events at 200 per
 * session'` pins that arithmetic. opencode's event model is nothing like
 * it: one assistant message costs one `message.updated` envelope plus
 * one `message.part.updated` per streamed chunk of every part, each
 * delivery carrying the whole thing so far. Counting those raw
 * deliveries put the effective capacity at roughly
 * `200 / chunks_per_message` calls — single digits on any real turn.
 *
 * That is not a cosmetic loss. When the cap evicts an assistant
 * message's envelope, its chat span is never built at all — the model's
 * words, its token usage and its finish reason are simply gone from the
 * trace, on exactly the long multi-step turns where they are worth most.
 *
 * ── Why this case is not vacuous ──────────────────────────────────────
 *
 * The shape is what carries the discrimination, so it is opencode's
 * real one and not OpenClaw's: {@link MESSAGES} assistant messages, each
 * streaming its text part {@link CHUNKS_PER_MESSAGE} times, with the
 * envelope republished at completion the way opencode does. That is
 * {@link MESSAGES} * (CHUNKS_PER_MESSAGE + 3) ≈ 1030 deliveries against
 * a 200-slot budget — so under the old blind-append accumulation only
 * the last two messages' envelopes survive and eight of the ten chat
 * spans are never built. Mutation-checked: reverting
 * `recordConversationEvent` to push-and-splice turns this case red on
 * the chat-span count.
 *
 * Deliberately drives the real `createNioPlugin` binding rather than
 * `createOpenCodeSource` directly: the source has always collapsed
 * snapshots by id, so calling it in isolation cannot see this bug at
 * all. The bug lives in what the runtime keeps on the way there.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-node';
import { makeInMemoryTracer } from './helpers/tracer.js';
import { trackTempDir } from './helpers/tmp-dirs.js';
import { writeCaptureOnConfig } from './helpers/capture-on.js';

/** Assistant messages (LLM calls) in the simulated turn. */
const MESSAGES = 10;
/** Snapshots of the same streaming text part per message. */
const CHUNKS_PER_MESSAGE = 100;

async function withCaptureOnHome<T>(prefix: string, fn: () => Promise<T>): Promise<T> {
  const home = trackTempDir(mkdtempSync(join(tmpdir(), prefix)));
  writeCaptureOnConfig(home);
  const previousHome = process.env['NIO_HOME'];
  process.env['NIO_HOME'] = home;
  try {
    return await fn();
  } finally {
    if (previousHome === undefined) delete process.env['NIO_HOME'];
    else process.env['NIO_HOME'] = previousHome;
  }
}

/** Guard verdict stub — this test never runs real Phase 0–6. */
function stubNioAllow(): never {
  return (() => ({
    orchestrator: {
      async evaluate() {
        return {
          decision: 'allow', risk_level: 'low', scores: { final: 0 },
          findings: [], explanation: 'test verdict', phase_stopped: 1, diagnostics: [],
        };
      },
    },
  })) as never;
}

const parentOf = (span: ReadableSpan): string | undefined =>
  (span as unknown as { parentSpanContext?: { spanId?: string } }).parentSpanContext?.spanId
  ?? (span as unknown as { parentSpanId?: string }).parentSpanId;

const named = (spans: readonly ReadableSpan[], prefix: string): ReadableSpan[] =>
  spans.filter((s) => s.name.startsWith(prefix));

describe('opencode conversation-event cap counts LLM calls, not streamed snapshots', () => {
  it('keeps every chat span of a 10-call turn that streamed 100 chunks per call', async () => {
    await withCaptureOnHome('nio-oc-cap-', async () => {
      const tracer = makeInMemoryTracer();
      try {
        const { createNioPlugin } = await import('../adapters/opencode-plugin.js');
        const hooks = await createNioPlugin({
          nioFactory: stubNioAllow(),
          tracerProvider: tracer.provider,
          // Explicitly null, not omitted: `undefined` has the runtime
          // build real providers whose exporters outlive the test.
          meterProvider: null,
          loggerProvider: null,
        })({ directory: '/tmp', worktree: '/tmp' } as never);

        const sessionID = 'oc-cap-1';
        await hooks.event!({
          event: { type: 'session.created', properties: { info: { id: sessionID } } },
        } as never);
        await hooks['chat.message']!(
          {}, { message: { sessionID }, parts: [{ type: 'text', text: 'do ten things' }] },
        );

        // Every envelope must be stamped at or after turn_start_ms or
        // `callsSince` drops it before the cap is even in question.
        const base = Date.now();

        for (let i = 0; i < MESSAGES; i++) {
          const messageID = `msg_cap_${i}`;
          const callID = `call_cap_${i}`;
          const created = base + i;
          const envelope = (completed?: number) => ({
            id: messageID, sessionID, role: 'assistant',
            modelID: 'oc-cap-model', providerID: 'anthropic',
            time: { created, ...(completed !== undefined ? { completed } : {}) },
          });

          // 1. The envelope, as opencode publishes it when the message
          //    opens.
          await hooks.event!({
            event: { type: 'message.updated', properties: { info: envelope() } },
          } as never);

          // 2. The streaming text part: ONE part id, republished per
          //    chunk, each snapshot carrying the full text so far. This
          //    is the delivery stream that dwarfs everything else.
          for (let c = 0; c < CHUNKS_PER_MESSAGE; c++) {
            await hooks.event!({
              event: {
                type: 'message.part.updated',
                properties: {
                  part: {
                    id: `prt_txt_${i}`, type: 'text', sessionID, messageID,
                    text: 'w'.repeat(c + 1),
                  },
                },
              },
            } as never);
          }

          // 3. The tool part, carrying the callID that joins this
          //    message to the tool span below.
          await hooks.event!({
            event: {
              type: 'message.part.updated',
              properties: {
                part: {
                  id: `prt_tool_${i}`, type: 'tool', sessionID, messageID,
                  callID, tool: 'bash', state: { input: { command: `echo ${i}` } },
                },
              },
            },
          } as never);

          await hooks['tool.execute.before']!(
            { tool: 'bash', sessionID, callID } as never,
            { args: { command: `echo ${i}` } } as never,
          );
          await hooks['tool.execute.after']!(
            { tool: 'bash', sessionID, callID, args: { command: `echo ${i}` } } as never,
            { title: 'bash', output: String(i), metadata: {} } as never,
          );

          // 4. The envelope again at completion — opencode republishes
          //    the whole record on every change, cumulative totals
          //    included.
          await hooks.event!({
            event: { type: 'message.updated', properties: { info: envelope(created + 5) } },
          } as never);
        }

        await hooks.event!(
          { event: { type: 'session.idle', properties: { sessionID } } } as never,
        );

        const spans = tracer.finished();
        const chats = named(spans, 'chat');
        const tools = named(spans, 'execute_tool');
        const turns = named(spans, 'invoke_agent');

        assert.equal(turns.length, 1, 'sanity: exactly one turn root');
        assert.equal(
          chats.length, MESSAGES,
          `all ${MESSAGES} assistant messages must produce a chat span — a shortfall means the ` +
            'per-session cap counted streamed snapshots instead of LLM calls and evicted the ' +
            'earliest messages',
        );
        assert.equal(tools.length, MESSAGES, 'every tool call must still produce a span');

        // Each chat span is identified by the message id it was built
        // from (`gen_ai.response.id` is the ChatCall's callId). Naming
        // every id explicitly, rather than only counting the spans, is
        // what makes eviction detectable: the cap drops the OLDEST
        // events, so a count-only assertion could be satisfied by ten
        // spans rebuilt from the wrong ten messages.
        const chatCallIds = new Set(chats.map((c) => c.attributes['gen_ai.response.id']));
        const turnRootId = turns[0]!.spanContext().spanId;
        for (let i = 0; i < MESSAGES; i++) {
          assert.ok(
            chatCallIds.has(`msg_cap_${i}`),
            `no chat span was rebuilt from msg_cap_${i} — that message's envelope was evicted by ` +
              'the cap, which is exactly the silent loss this cap must not cause',
          );
          const tool = tools.find((s) => s.attributes['gen_ai.tool.call.id'] === `call_cap_${i}`);
          assert.ok(tool, `tool span for call_cap_${i} must exist`);
          // Tool spans are exported as they close, so the parent is the
          // turn root for all of them and carries no information about
          // which call issued them — `gen_ai.tool.call.id`, asserted by
          // the `find` above, is the surviving link. Pinned so a reader
          // does not mistake the flat shape here for the eviction this
          // test hunts.
          assert.equal(
            parentOf(tool!), turnRootId,
            'every tool span hangs off the turn root, not its chat call',
          );
        }
      } finally {
        await tracer.shutdown();
      }
    });
  });
});
