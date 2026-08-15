// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * On Pi and opencode too, a tool span is a SIBLING of the chat span.
 *
 * This file used to pin the opposite. Pi and opencode are the two
 * platforms where nesting was actually achievable — Pi's `toolCall`
 * blocks carry an id and its calls are `inferred`; opencode's tool parts
 * carry `callID` and its calls are `exact`, so both of `buildSpanTree`'s
 * attribution channels exist — and it demonstrably worked. It was given
 * up anyway, because it can only be bought by holding every tool span
 * until the turn ends, and that made a long turn invisible and a
 * mid-turn crash unreconstructable. `eager-tool-spans.test.ts` carries
 * the measurement; `PluginRuntimeOptions.eagerToolSpans` carries the
 * reasoning.
 *
 * So what these cases now pin is the shape that replaced it, on the two
 * bindings that had the most to lose:
 *
 *  - the tool span hangs off the TURN ROOT, beside the chat span, not
 *    under it;
 *  - `gen_ai.tool.call.id` is still on the tool span, carrying the
 *    issuing call as data so a backend can join what the tree no longer
 *    encodes. This is the entire compensation for the flat shape, so it
 *    is asserted on every case;
 *  - the chat layer itself is UNAFFECTED — chat spans are still
 *    reconstructed from the conversation source at turn close and still
 *    hang off the turn root. Only the tool → chat edge was dropped.
 *
 * ── Why these cases are not vacuous ──────────────────────────────────
 *
 * Each states the parentage as an equality against the turn root AND an
 * inequality against the chat span, so a regression to the parked path
 * fails both ways round rather than sliding through a `!==` that any
 * shape satisfies. The chat-span assertions are what keep them honest in
 * the other direction: a run that produced no chat span at all would
 * make "the tool is not under the chat span" trivially true, so every
 * case first proves the chat span exists.
 *
 * Both cases drive the real bindings (`registerPiExtension` /
 * `createNioPlugin`) rather than calling `buildSpanTree` directly, so
 * the emission path — where the span is now sent from — is what is
 * exercised.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-node';
import { SpanStatusCode } from '@opentelemetry/api';
import { makeInMemoryTracer } from './helpers/tracer.js';
import { trackTempDir } from './helpers/tmp-dirs.js';
import { writeCaptureOnConfig } from './helpers/capture-on.js';

/**
 * Run `fn` with NIO_HOME pointed at a fresh tmpdir that has blanket
 * capture on. Same helper shape as content-wiring.test.ts's — the gate
 * itself is pinned elsewhere; without capture on every assertion here
 * would reduce to "nothing was emitted".
 */
async function withCaptureOnHome<T>(prefix: string, fn: (home: string) => Promise<T>): Promise<T> {
  const home = trackTempDir(mkdtempSync(join(tmpdir(), prefix)));
  writeCaptureOnConfig(home);
  const previousHome = process.env['NIO_HOME'];
  process.env['NIO_HOME'] = home;
  try {
    return await fn(home);
  } finally {
    if (previousHome === undefined) delete process.env['NIO_HOME'];
    else process.env['NIO_HOME'] = previousHome;
  }
}

/** Guard verdict stub — these tests never run real Phase 0–6. */
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

describe('pi + opencode span hierarchy: tool spans are siblings of their chat call', () => {
  it('pi puts the tool span on the turn root and keeps the tool_use id on it', async () => {
    await withCaptureOnHome('nio-pi-hierarchy-', async (home) => {
      const tracer = makeInMemoryTracer();
      try {
        const { registerPiExtension } = await import('../adapters/pi-plugin.js');
        const handlers = new Map<string, (e: unknown, c: unknown) => Promise<unknown> | unknown>();
        registerPiExtension(
          {
            on(name: string, fn: (e: unknown, c: unknown) => Promise<unknown> | unknown) {
              handlers.set(name, fn);
            },
            registerCommand() { /* unused */ },
          } as never,
          {
            nioFactory: stubNioAllow(),
            tracerProvider: tracer.provider,
            // Explicitly null, not omitted: `undefined` has the runtime
            // build a real MeterProvider whose 1s export timer outlives
            // the test process.
            meterProvider: null,
            loggerProvider: null,
          },
        );

        const sessionFile = join(home, 'session.jsonl');
        const ctx = {
          hasUI: false,
          cwd: '/tmp',
          ui: { async confirm() { return true; }, notify() { /* no-op */ } },
          sessionManager: {
            getSessionId: () => 'pi-hierarchy-1',
            getSessionFile: () => sessionFile,
          },
        };

        await handlers.get('session_start')!({}, ctx);
        await handlers.get('input')!({ text: 'list the files' }, ctx);

        // The tool span opens HERE, so its start_ms is fixed now. The
        // transcript entry below is stamped later on purpose — see the
        // module doc: it takes the time window out of play so the
        // `tool_use` id is the only thing that can attribute this span.
        await handlers.get('tool_call')!(
          { toolName: 'bash', toolCallId: 'call_hier_1', input: { command: 'ls' } }, ctx,
        );
        await handlers.get('tool_result')!(
          { toolName: 'bash', toolCallId: 'call_hier_1', content: 'a.txt', isError: false }, ctx,
        );

        // Written after the prompt, as callsSince(turn_start_ms) requires,
        // and after the tool call, as the discriminating-power argument
        // requires. `call_hier_1` is the join key: same id on the
        // toolCall block and on the tool event above.
        writeFileSync(
          sessionFile,
          JSON.stringify({
            type: 'message',
            id: 'm2',
            parentId: null,
            timestamp: new Date(Date.now() + 5_000).toISOString(),
            message: {
              role: 'assistant',
              content: [
                { type: 'thinking', thinking: 'placeholder reasoning: I should list them' },
                { type: 'text', text: 'placeholder reply: listing the files' },
                { type: 'toolCall', id: 'call_hier_1', name: 'bash', arguments: { command: 'ls' } },
              ],
              provider: 'anthropic',
              model: 'pi-hierarchy-model',
              stopReason: 'toolUse',
              timestamp: Date.now() + 5_000,
            },
          }) + '\n',
          'utf-8',
        );

        await handlers.get('agent_end')!({}, ctx);

        const spans = tracer.finished();
        const chats = named(spans, 'chat');
        const tools = named(spans, 'execute_tool');
        const turns = named(spans, 'invoke_agent');
        assert.equal(chats.length, 1, 'the transcript entry must have produced exactly one chat span');
        assert.equal(chats[0]!.name, 'chat pi-hierarchy-model');
        assert.equal(tools.length, 1, 'the tool call must have produced exactly one tool span');
        assert.equal(turns.length, 1, 'the turn root must have been exported');

        assert.equal(
          parentOf(tools[0]!),
          turns[0]!.spanContext().spanId,
          'the tool span hangs off the turn root — it was exported at tool_result, long before ' +
            'this transcript entry was read and the chat span built',
        );
        assert.notEqual(
          parentOf(tools[0]!),
          chats[0]!.spanContext().spanId,
          'stated as an inequality too: nesting under the chat call means the span was parked ' +
            'until turn close again, and with it the whole turn\'s visibility',
        );
        assert.equal(
          tools[0]!.attributes['gen_ai.tool.call.id'],
          'call_hier_1',
          'the issuing call survives as data: the same id Pi\'s toolCall block carries, so a ' +
            'backend can still join the two',
        );
        assert.equal(
          parentOf(chats[0]!),
          turns[0]!.spanContext().spanId,
          'and the chat span itself still hangs off the turn root — the chat LAYER is unaffected, ' +
            'only the tool → chat edge was dropped',
        );
      } finally {
        await tracer.shutdown();
      }
    });
  });

  it('opencode puts both tool spans on the turn root, each keeping its callID', async () => {
    await withCaptureOnHome('nio-oc-hierarchy-', async () => {
      const tracer = makeInMemoryTracer();
      try {
        const { createNioPlugin } = await import('../adapters/opencode-plugin.js');
        const hooks = await createNioPlugin({
          nioFactory: stubNioAllow(),
          tracerProvider: tracer.provider,
          meterProvider: null,
          loggerProvider: null,
        })({ directory: '/tmp', worktree: '/tmp' } as never);

        const sessionID = 'oc-hierarchy-1';
        await hooks.event!({
          event: { type: 'session.created', properties: { info: { id: sessionID } } },
        } as never);
        await hooks['chat.message']!(
          {}, { message: { sessionID }, parts: [{ type: 'text', text: 'list the files' }] },
        );

        // The envelope has to be stamped at or after turn_start_ms
        // (callsSince drops anything earlier) and at or before the tool
        // spans open (or the time window below cannot claim the second
        // one). `Date.now()` right here satisfies both.
        const created = Date.now();
        const info = {
          id: 'msg_hier_1', sessionID, role: 'assistant',
          modelID: 'oc-hierarchy-model', providerID: 'anthropic',
          time: { created, completed: created + 10 },
        };
        await hooks.event!({
          event: { type: 'message.updated', properties: { info } },
        } as never);
        await hooks.event!({
          event: {
            type: 'message.part.updated',
            properties: {
              part: {
                id: 'prt_1', type: 'text', sessionID, messageID: 'msg_hier_1',
                text: 'placeholder reply: listing the files',
              },
            },
          },
        } as never);
        // Only the FIRST tool call gets a part, so only it can be
        // attributed by id — see the module doc.
        await hooks.event!({
          event: {
            type: 'message.part.updated',
            properties: {
              part: {
                id: 'prt_2', type: 'tool', sessionID, messageID: 'msg_hier_1',
                callID: 'call_with_part', tool: 'bash', state: { input: { command: 'ls' } },
              },
            },
          },
        } as never);

        for (const callID of ['call_with_part', 'call_without_part']) {
          await hooks['tool.execute.before']!(
            { tool: 'bash', sessionID, callID } as never,
            { args: { command: 'ls' } } as never,
          );
          await hooks['tool.execute.after']!(
            { tool: 'bash', sessionID, callID, args: { command: 'ls' } } as never,
            { title: 'ls', output: 'a.txt', metadata: {} } as never,
          );
        }

        await hooks.event!(
          { event: { type: 'session.idle', properties: { sessionID } } } as never,
        );

        const spans = tracer.finished();
        const chats = named(spans, 'chat');
        const tools = named(spans, 'execute_tool');
        const turns = named(spans, 'invoke_agent');
        assert.equal(chats.length, 1, 'the accumulated message parts must produce exactly one chat span');
        assert.equal(chats[0]!.name, 'chat oc-hierarchy-model');
        assert.equal(tools.length, 2, 'both tool calls must have produced a span');
        assert.equal(turns.length, 1, 'the turn root must have been exported');

        const chatSpanId = chats[0]!.spanContext().spanId;
        const turnSpanId = turns[0]!.spanContext().spanId;
        // One tool call has an accumulated `message.part.updated` and one
        // never got one — a real opencode state, since tool parts are
        // published asynchronously and a turn can close before a
        // snapshot does. Both are asserted so the shape cannot depend on
        // whether the conversation source happened to see the call.
        const withPart = tools.find((s) => s.attributes['gen_ai.tool.call.id'] === 'call_with_part');
        const withoutPart = tools.find((s) => s.attributes['gen_ai.tool.call.id'] === 'call_without_part');
        assert.ok(
          withPart && withoutPart,
          'both tool spans must carry their real opencode callID — that id is the whole ' +
            'compensation for no longer encoding the issuing call as a parent edge',
        );

        for (const tool of [withPart!, withoutPart!]) {
          assert.equal(
            parentOf(tool),
            turnSpanId,
            'every tool span hangs off the turn root, exported as its tool.execute.after arrived',
          );
          assert.notEqual(
            parentOf(tool),
            chatSpanId,
            'stated as an inequality too: a tool under the chat span means the parked path is back',
          );
        }
        assert.equal(
          parentOf(chats[0]!),
          turnSpanId,
          'and the chat span itself still hangs off the turn root',
        );
      } finally {
        await tracer.shutdown();
      }
    });
  });

  it('opencode still emits a RECLAIMED tool span — the tool that threw — marked as a reclaim', async () => {
    // Reclaim is not the exceptional path on opencode, it is the normal
    // path for every tool call that throws: `tool.execute.after` is
    // simply not delivered, so `session.idle` finds the span still
    // pending and force-closes it in `flushSessionTurnInner`'s reclaim
    // loop. That loop is the one part of the deferral machinery that is
    // still load-bearing under eager emission — without it a tool that
    // threw would produce no span at all.
    //
    // Not vacuous: the span asserted on here can only come from that
    // loop. No `tool.execute.after` is ever delivered below, so the
    // normal `onPostTool` emission path is never reached; delete the
    // reclaim loop and the tool-span count goes to zero.
    await withCaptureOnHome('nio-oc-reclaim-', async () => {
      const tracer = makeInMemoryTracer();
      try {
        const { createNioPlugin } = await import('../adapters/opencode-plugin.js');
        const hooks = await createNioPlugin({
          nioFactory: stubNioAllow(),
          tracerProvider: tracer.provider,
          meterProvider: null,
          loggerProvider: null,
        })({ directory: '/tmp', worktree: '/tmp' } as never);

        const sessionID = 'oc-reclaim-1';
        await hooks.event!({
          event: { type: 'session.created', properties: { info: { id: sessionID } } },
        } as never);
        await hooks['chat.message']!(
          {}, { message: { sessionID }, parts: [{ type: 'text', text: 'run the failing thing' }] },
        );

        const created = Date.now();
        await hooks.event!({
          event: {
            type: 'message.updated',
            properties: {
              info: {
                id: 'msg_reclaim_1', sessionID, role: 'assistant',
                modelID: 'oc-reclaim-model', providerID: 'anthropic',
                time: { created, completed: created + 10 },
              },
            },
          },
        } as never);
        await hooks.event!({
          event: {
            type: 'message.part.updated',
            properties: {
              part: {
                id: 'prt_r1', type: 'tool', sessionID, messageID: 'msg_reclaim_1',
                callID: 'call_that_threw', tool: 'bash', state: { input: { command: 'boom' } },
              },
            },
          },
        } as never);

        // The pre-side only. opencode does not deliver
        // `tool.execute.after` when the tool throws, so this span is
        // still pending when the turn closes.
        await hooks['tool.execute.before']!(
          { tool: 'bash', sessionID, callID: 'call_that_threw' } as never,
          { args: { command: 'boom' } } as never,
        );

        await hooks.event!(
          { event: { type: 'session.idle', properties: { sessionID } } } as never,
        );

        const spans = tracer.finished();
        const chats = named(spans, 'chat');
        const tools = named(spans, 'execute_tool');
        const turns = named(spans, 'invoke_agent');
        assert.equal(chats.length, 1, 'the accumulated parts must produce exactly one chat span');
        assert.equal(tools.length, 1, 'the pending span must have been reclaimed, not dropped');
        assert.equal(turns.length, 1, 'the turn root must have been exported');

        assert.equal(
          tools[0]!.attributes['nio.span.reclaimed'], true,
          'it must still be marked as a reclaim rather than passing for a clean close',
        );
        assert.equal(
          tools[0]!.attributes['nio.span.reclaim_reason'], 'no_post_tool_event',
          'and keep the reason — parking the span must not cost the reclaim marking',
        );
        assert.equal(
          tools[0]!.status.code, SpanStatusCode.UNSET,
          'the outcome is unknowable, so the reclaimed span must assert neither success nor error',
        );
        assert.equal(
          tools[0]!.attributes['gen_ai.tool.call.id'],
          'call_that_threw',
          'the reclaimed span keeps its callID — a failing call is the one a reviewer most wants ' +
            'to trace back to the model turn that issued it',
        );
        assert.equal(
          parentOf(tools[0]!),
          turns[0]!.spanContext().spanId,
          'and it is routed exactly like a normally-closed span: onto the turn root',
        );
        assert.notEqual(
          parentOf(tools[0]!),
          chats[0]!.spanContext().spanId,
          'stated as an inequality too, so the reclaim path cannot quietly diverge from the ' +
            'normal close path',
        );
      } finally {
        await tracer.shutdown();
      }
    });
  });
});
