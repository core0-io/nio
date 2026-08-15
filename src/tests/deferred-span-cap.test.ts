// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * `deferred_spans` is bounded, and going over the bound FLUSHES the
 * oldest parked spans instead of dropping them.
 *
 * ── The path under test is DORMANT in production ─────────────────────
 *
 * Since eager emission became the default (`eagerToolSpans`, see
 * `eager-tool-spans.test.ts` for the measurement that settled it),
 * nothing parks: every tool span is exported as it closes and this queue
 * is permanently empty. The first two cases therefore pass
 * `eagerToolSpans: false` explicitly to reach the parking path at all.
 *
 * The mechanism is kept, and kept under test, because `deferred_spans`
 * is still the structure `traces-state-store.ts`'s crash-salvage reads
 * and writes, and because an unbounded queue behind a flag is a latent
 * defect rather than a dead one. The third case is the one that pins
 * production behaviour.
 *
 * The in-process family used to park every closed tool span until turn
 * close so `buildSpanTree` could nest it under the chat call that issued
 * it. That queue had no ceiling, on the reasoning that a turn is
 * self-limiting and a parked span costs ~740 B. Both halves of that are
 * weaker than they look:
 *
 *  - the queue is emptied by the turn CLOSE, so a host that stops
 *    delivering `session.idle` / `agent_end` has nothing emptying it;
 *  - a parked span carries the call's arguments and its result, and
 *    `redactAndTruncate` used to cap the value at 2048 chars while still
 *    pinning the whole payload behind a V8 SlicedString. Measured on the
 *    real opencode binding with 20 KB arguments and results: 5000 parked
 *    spans held **204 MB, ~41 KB/span** — not 3.5 MB.
 *
 * Dropping the overflow would be the wrong bound. `tool_input` /
 * `tool_output` content records are emitted at PreToolUse / PostToolUse
 * carrying the parked span's id, so a dropped span leaves the backend
 * holding records that name a span it will never receive. Flushing early
 * costs only the parentage — the overflow span hangs off the turn root
 * rather than its chat call — and that loss is marked
 * (`nio.span.deferred_overflow`) rather than silent.
 *
 * ── Why this case is not vacuous ──────────────────────────────────────
 *
 * The load-bearing assertion is taken MID-TURN, before `session.idle`:
 * on the unbounded implementation nothing at all has reached the
 * exporter at that point, because every span is still parked. So the
 * assertion cannot be satisfied by anything except the queue actually
 * being drained. It is paired with a post-close count, so an
 * implementation that "bounds" the queue by dropping fails too — the
 * total has to come back to every span that was opened.
 *
 * The shape is opencode's real one (a `tool.execute.before` /
 * `tool.execute.after` pair per call, one assistant envelope with
 * non-synthetic timing so the surviving spans have a chat call to nest
 * under) and it drives `createNioPlugin`, not the runtime in isolation.
 *
 * The third case pins the production default: `eagerToolSpans: true`
 * never parks anything, so the cap is unreachable and the wire output is
 * untouched by this mechanism.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-node';
import { InProcessPluginRuntime, MAX_DEFERRED_SPANS } from '../adapters/plugin-runtime.js';
import { OpenClawAdapter } from '../adapters/openclaw.js';
import { makeInMemoryTracer } from './helpers/tracer.js';
import { trackTempDir } from './helpers/tmp-dirs.js';
import { writeCaptureOnConfig } from './helpers/capture-on.js';

/** How far past the cap this turn runs. */
const OVERFLOW = 5;
const CALLS = MAX_DEFERRED_SPANS + OVERFLOW;

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

/** Guard verdict stub — this file never runs real Phase 0–6. */
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

/**
 * Drive one opencode turn of {@link CALLS} tool calls without closing
 * it. Returns the hooks and the session id so the caller decides whether
 * `session.idle` ever arrives.
 */
async function driveOpenTurn(tracer: ReturnType<typeof makeInMemoryTracer>, sessionID: string) {
  const { createNioPlugin } = await import('../adapters/opencode-plugin.js');
  const hooks = await createNioPlugin({
    nioFactory: stubNioAllow(),
    tracerProvider: tracer.provider,
    // Explicitly null, not omitted: `undefined` builds real providers
    // whose exporters outlive the test.
    meterProvider: null,
    loggerProvider: null,
    // The cap only exists on the parking path, and parking is no longer
    // the default. Without this the queue is empty at every close and
    // both cases below would assert against a mechanism that never ran.
    eagerToolSpans: false,
  })({ directory: '/tmp', worktree: '/tmp' } as never);

  await hooks.event!({
    event: { type: 'session.created', properties: { info: { id: sessionID } } },
  } as never);
  // Opens the turn, so `turn_start_ms` is stamped before the envelope
  // below — otherwise `callsSince` drops the envelope and there is no
  // chat call for anything to nest under.
  await hooks['chat.message']!(
    {}, { message: { sessionID }, parts: [{ type: 'text', text: 'run a lot of tools' }] },
  );

  const base = Date.now();
  // One assistant message, `timing: 'inferred'` (created, no completed)
  // — non-synthetic, so `buildSpanTree`'s time-window channel is live
  // and every still-parked span nests under it.
  await hooks.event!({
    event: {
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_defer_1', sessionID, role: 'assistant',
          modelID: 'oc-cap-model', providerID: 'anthropic',
          time: { created: base },
        },
      },
    },
  } as never);
  // An envelope whose parts were all discarded yields no call at all
  // (`callFrom` drops a blockless message), so the message needs one
  // piece of real model output to exist as a chat span.
  await hooks.event!({
    event: {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'prt_txt_1', type: 'text', sessionID,
          messageID: 'msg_defer_1', text: 'running the tools now',
        },
      },
    },
  } as never);

  for (let i = 0; i < CALLS; i++) {
    const callID = `dc_${i}`;
    await hooks['tool.execute.before']!(
      { tool: 'bash', sessionID, callID } as never,
      { args: { command: `echo ${i}` } } as never,
    );
    await hooks['tool.execute.after']!(
      { tool: 'bash', sessionID, callID, args: { command: `echo ${i}` } } as never,
      { title: 'bash', output: String(i), metadata: {} } as never,
    );
  }
  return hooks;
}

describe('deferred tool spans are capped, and the overflow is flushed rather than dropped', () => {
  it('drains the oldest parked spans mid-turn and marks the parentage it cost them', async () => {
    await withCaptureOnHome('nio-defer-cap-', async () => {
      const tracer = makeInMemoryTracer();
      try {
        await driveOpenTurn(tracer, 'oc-defer-cap-1');

        // ── MID-TURN. Nothing has closed the turn. On an unbounded
        // queue this list is empty: every span is still parked.
        // `overflowDeferredSpans` is synchronous and deliberately does
        // not flush — the spans it emits ride the batch processor's own
        // schedule. So drain the queue before counting, or this reads
        // zero for a reason that has nothing to do with the cap.
        const midTurn = named(await tracer.flushed(), 'execute_tool');
        assert.equal(
          midTurn.length, OVERFLOW,
          `${CALLS} tool calls against a ${MAX_DEFERRED_SPANS}-span cap must have flushed exactly ` +
            `${OVERFLOW} spans before the turn closed — an empty list here means the queue is ` +
            'still unbounded and a turn whose close never arrives grows without limit',
        );
        assert.deepEqual(
          midTurn.map((s) => s.attributes['gen_ai.tool.call.id']),
          Array.from({ length: OVERFLOW }, (_, i) => `dc_${i}`),
          'the OLDEST parked spans are the ones flushed, in order',
        );
        for (const span of midTurn) {
          assert.equal(
            span.attributes['nio.span.deferred_overflow'], true,
            'a span that lost its chat-call parentage to the cap must say so — silent flattening ' +
              'is indistinguishable from a platform that was never attributable',
          );
          assert.equal(span.attributes['nio.span.deferred_cap'], MAX_DEFERRED_SPANS);
          assert.equal(
            parentOf(span), span.spanContext().traceId.slice(0, 16),
            'an early-flushed span hangs off the turn root — there is no chat span yet to nest under',
          );
        }

      } finally {
        await tracer.shutdown();
      }
    });
  });

  // Separate case, not a continuation of the one above: a bound that
  // DROPPED its overflow would already have failed the mid-turn count,
  // so the "nothing was lost" property would never be reached and would
  // survive untested. Here it is the first thing asserted.
  it('loses nothing at turn close, and leaves the in-budget spans their real parent', async () => {
    await withCaptureOnHome('nio-defer-cap-close-', async () => {
      const tracer = makeInMemoryTracer();
      try {
        const sessionID = 'oc-defer-cap-2';
        const hooks = await driveOpenTurn(tracer, sessionID);

        await hooks.event!(
          { event: { type: 'session.idle', properties: { sessionID } } } as never,
        );

        const spans = tracer.finished();
        const tools = named(spans, 'execute_tool');
        const chats = named(spans, 'chat');
        const turns = named(spans, 'invoke_agent');

        assert.equal(turns.length, 1, 'sanity: exactly one turn root');
        assert.equal(chats.length, 1, 'sanity: exactly one chat call to attribute against');
        assert.equal(
          tools.length, CALLS,
          'every tool call must still produce exactly one span — a bound that DROPS the overflow ' +
            'would strand the tool_input/tool_output records already emitted under those span ids',
        );
        assert.equal(
          new Set(tools.map((s) => s.spanContext().spanId)).size, CALLS,
          'and no span may be emitted twice',
        );

        const chatSpanId = chats[0]!.spanContext().spanId;
        const nested = tools.filter((s) => parentOf(s) === chatSpanId);
        assert.equal(
          nested.length, MAX_DEFERRED_SPANS,
          'the spans that stayed within budget keep their real parentage — the cap must not cost ' +
            'attribution for calls it never touched',
        );
        for (const span of nested) {
          assert.equal(
            span.attributes['nio.span.deferred_overflow'], undefined,
            'only spans the cap actually evicted may carry the marker',
          );
        }
      } finally {
        await tracer.shutdown();
      }
    });
  });

  it('never engages under the production default (eager export leaves the queue empty)', async () => {
    await withCaptureOnHome('nio-defer-cap-eager-', async () => {
      const tracer = makeInMemoryTracer();
      try {
        // `eagerToolSpans: true` is the runtime default and what
        // openclaw-plugin.ts states explicitly. Under it
        // `recordPostToolUse` drains the queue on every close, so it can
        // never reach the cap however long the turn is.
        const rt = new InProcessPluginRuntime({
          platform: 'openclaw',
          adapter: new OpenClawAdapter(),
          nioFactory: stubNioAllow(),
          tracerProvider: tracer.provider,
          meterProvider: null,
          loggerProvider: null,
          eagerToolSpans: true,
        });

        const sessionId = 'ocl-defer-cap-1';
        for (let i = 0; i < CALLS; i++) {
          const key = `ocl_${i}`;
          await rt.onPreTool(
            sessionId, key, 'exec', { command: `echo ${i}` },
            { toolName: 'exec', params: { command: `echo ${i}` }, sessionKey: sessionId },
            { toolCallId: key },
          );
          await rt.onPostTool(sessionId, key, 'exec', { result: String(i), error: null });
        }

        const tools = named(tracer.finished(), 'execute_tool');
        assert.equal(
          tools.length, CALLS,
          'the eager path exports every span as it closes, cap or no cap',
        );
        assert.equal(
          tools.filter((s) => s.attributes['nio.span.deferred_overflow'] !== undefined).length, 0,
          'no span may acquire the overflow marker under the default: the queue is empty at every ' +
            'close, so the cap is unreachable and the wire output is byte-for-byte what it was',
        );
        await rt.onTurnEnd(sessionId);
      } finally {
        await tracer.shutdown();
      }
    });
  });
});
