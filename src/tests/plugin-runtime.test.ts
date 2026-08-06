// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InProcessPluginRuntime, type PreToolResult } from '../adapters/plugin-runtime.js';
import { OpenClawAdapter } from '../adapters/openclaw.js';
import { ensureTurn } from '../scripts/lib/traces-collector.js';
import { makeInMemoryTracer } from './helpers/tracer.js';
import { trackTempDir } from './helpers/tmp-dirs.js';
import { writeCaptureOnConfig } from './helpers/capture-on.js';
import { SpanStatusCode } from '@opentelemetry/api';

// This file is about span/metric/audit WIRING, not about the per-session
// monitor gate — which is off by default and would otherwise reduce
// every assertion below to "nothing was emitted". Capture is therefore
// turned on process-wide for this file, the same way an operator does
// it, before any test body runs. The gate itself is pinned by
// plugin-runtime-monitor.test.ts and monitor-openclaw*.test.ts.
//
// Runs at module scope (after imports, before any test) so the fresh
// home is in place before the first `loadConfig()` — config reads are
// cached per resolved path, so a later switch would be ignored.
{
  const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-plugin-runtime-tests-')));
  writeCaptureOnConfig(home);
  process.env.NIO_HOME = home;
}

describe('InProcessPluginRuntime', () => {
  function makeRuntime() {
    return new InProcessPluginRuntime({
      platform: 'test-platform',
      adapter: new OpenClawAdapter(),
    });
  }

  it('exposes the configured platform tag', () => {
    assert.equal(makeRuntime().platform, 'test-platform');
  });

  it('lazily builds one orchestrator and reuses it', () => {
    const rt = makeRuntime();
    assert.equal(rt.orchestrator, rt.orchestrator);
  });

  it('onSessionStart clears any prior state for that session id', async () => {
    const rt = makeRuntime();
    rt._setSessionStateForTests('s1', ensureTurn(null, 's1'));
    assert.equal(rt.hasSessionState('s1'), true);
    rt.onSessionStart('s1');
    assert.equal(rt.hasSessionState('s1'), false);
  });

  it('onSessionEnd flushes and clears existing session state', async () => {
    const rt = makeRuntime();
    rt._setSessionStateForTests('s1', ensureTurn(null, 's1'));
    assert.equal(rt.hasSessionState('s1'), true);
    await rt.onSessionEnd('s1');
    assert.equal(rt.hasSessionState('s1'), false);
  });

  it('onTurnEnd flushes and clears existing session state', async () => {
    const rt = makeRuntime();
    rt._setSessionStateForTests('s1', ensureTurn(null, 's1'));
    assert.equal(rt.hasSessionState('s1'), true);
    await rt.onTurnEnd('s1');
    assert.equal(rt.hasSessionState('s1'), false);
  });

  it('onTurnEnd is idempotent', async () => {
    const rt = makeRuntime();
    rt._setSessionStateForTests('s1', ensureTurn(null, 's1'));
    assert.equal(rt.hasSessionState('s1'), true);
    await rt.onTurnEnd('s1');
    assert.equal(rt.hasSessionState('s1'), false);
    await rt.onTurnEnd('s1');
    assert.equal(rt.hasSessionState('s1'), false);
  });
});

describe('InProcessPluginRuntime tool path', () => {
  /** Stub engine whose verdict the test controls. */
  function runtimeWithVerdict(
    verdict: 'allow' | 'deny' | 'confirm',
    confirmAction?: 'allow' | 'deny' | 'ask',
  ) {
    return new InProcessPluginRuntime({
      platform: 'test-platform',
      adapter: new OpenClawAdapter(),
      ...(confirmAction ? { confirmAction } : {}),
      nioFactory: () => ({
        orchestrator: {
          async evaluate() {
            return {
              decision: verdict,
              risk_level: verdict === 'allow' ? 'low' : 'high',
              scores: { final: verdict === 'allow' ? 0 : 0.9 },
              findings: verdict === 'allow' ? [] : [{ rule_id: 'TEST_RULE' }],
              explanation: 'test verdict',
              phase_stopped: 2,
              diagnostics: [],
            };
          },
        },
      }) as never,
    });
  }

  it('allows and reports decision "allow"', async () => {
    const rt = runtimeWithVerdict('allow');
    const r = await rt.onPreTool('s1', 'call-1', 'exec', { command: 'ls' }, {
      toolName: 'exec', params: { command: 'ls' },
    });
    assert.equal(r.block, false);
    assert.equal(r.decision, 'allow');
  });

  it('blocks and reports decision "deny" with a reason', async () => {
    const rt = runtimeWithVerdict('deny');
    const r = await rt.onPreTool('s1', 'call-1', 'exec', { command: 'rm -rf /' }, {
      toolName: 'exec', params: { command: 'rm -rf /' },
    });
    assert.equal(r.block, true);
    assert.equal(r.decision, 'deny');
    assert.ok(r.reason && r.reason.length > 0);
  });

  it('folds confirm to confirm_denied when confirm_action is deny', async () => {
    const rt = runtimeWithVerdict('confirm', 'deny');
    const r = await rt.onPreTool('s1', 'call-1', 'exec', { command: 'curl x' }, {
      toolName: 'exec', params: { command: 'curl x' },
    });
    assert.equal(r.block, true);
    assert.equal(r.decision, 'confirm_denied');
  });

  it('resolveConfirm maps a user "no" to confirm_denied', async () => {
    const rt = runtimeWithVerdict('confirm');
    const r = await rt.resolveConfirm('s1', 'call-1', 'ask', 'needs confirmation', false);
    assert.equal(r.block, true);
    assert.equal(r.decision, 'confirm_denied');
  });

  it('resolveConfirm maps a user "yes" to confirm_allowed', async () => {
    const rt = runtimeWithVerdict('confirm');
    const r = await rt.resolveConfirm('s1', 'call-1', 'ask', 'needs confirmation', true);
    assert.equal(r.block, false);
    assert.equal(r.decision, 'confirm_allowed');
  });

  it('onPostTool is a no-op when no pre-span was recorded', async () => {
    const rt = runtimeWithVerdict('allow');
    await rt.onPostTool('s-unknown', 'call-x', 'exec', { result: 'ok' });
    assert.equal(rt.hasSessionState('s-unknown'), false);
  });
});

// The tests above run with both OTEL providers null (the harness pins
// NIO_HOME to an empty tmpdir, so collector.endpoint is unset). That
// leaves the span wiring — park guard attrs, drain them exactly once,
// emit an orphan span when a call is blocked — completely unexercised.
// These tests inject an in-memory tracer so that wiring can actually
// fail. `makeInMemoryTracer` is the repo's existing helper, already used
// by src/tests/traces-collector.test.ts.
describe('InProcessPluginRuntime span wiring', () => {
  function runtimeWithTracer(
    verdict: 'allow' | 'deny' | 'confirm',
    tracer: ReturnType<typeof makeInMemoryTracer>,
    confirmAction?: 'allow' | 'deny' | 'ask',
  ) {
    return new InProcessPluginRuntime({
      platform: 'test-platform',
      adapter: new OpenClawAdapter(),
      tracerProvider: tracer.provider,
      meterProvider: null,
      ...(confirmAction ? { confirmAction } : {}),
      nioFactory: () => ({
        orchestrator: {
          async evaluate() {
            return {
              decision: verdict,
              risk_level: verdict === 'allow' ? 'low' : 'high',
              scores: { final: verdict === 'allow' ? 0 : 0.9 },
              findings: verdict === 'allow' ? [] : [{ rule_id: 'TEST_RULE' }],
              explanation: 'test verdict',
              phase_stopped: 2,
              diagnostics: [],
            };
          },
        },
      }) as never,
    });
  }

  const preEvent = (command: string) => ({
    toolName: 'exec', params: { command },
  });

  it('allow path emits one tool span carrying the guard attrs', async () => {
    const tracer = makeInMemoryTracer();
    try {
      const rt = runtimeWithTracer('allow', tracer);
      await rt.onPreTool('s1', 'call-1', 'exec', { command: 'ls' }, preEvent('ls'));
      assert.equal(tracer.finished().length, 0, 'no span before the post side');

      // An allowed tool's span is PARKED at the post side, not emitted:
      // which chat call issued it is only knowable once the turn's
      // conversation has been reconstructed. `eagerToolSpans` (OpenClaw)
      // is the opt-out; the default runtime waits. Contrast the deny path
      // below, which must not wait for a turn that may never end.
      await rt.onPostTool('s1', 'call-1', 'exec', { result: 'ok' });
      assert.equal(
        tracer.finished().length, 0,
        'the allow-path span is deferred for attribution, not exported at the post side',
      );

      await rt.onTurnEnd('s1');
      const spans = tracer.finished().filter((s) => s.name.startsWith('execute_tool'));
      assert.equal(spans.length, 1);
      assert.equal(spans[0]!.attributes['nio.guard.decision'], 'allow');
      assert.equal(typeof spans[0]!.attributes['nio.guard.eval_ms'], 'number');
    } finally {
      await tracer.shutdown();
    }
  });

  it('deny path emits the orphan span immediately and drains attrs once', async () => {
    const tracer = makeInMemoryTracer();
    try {
      const rt = runtimeWithTracer('deny', tracer);
      const r = await rt.onPreTool(
        's1', 'call-1', 'exec', { command: 'rm -rf /' }, preEvent('rm -rf /'),
      );
      assert.equal(r.block, true);

      // The platform's post-side event never fires for a blocked call, so
      // onPreTool must have emitted the span itself.
      const afterBlock = tracer.finished();
      assert.equal(afterBlock.length, 1, 'orphan span emitted on the block path');
      assert.equal(afterBlock[0]!.attributes['nio.guard.decision'], 'deny');

      // A defensive post call must not emit a second span for the same key.
      await rt.onPostTool('s1', 'call-1', 'exec', { result: 'never ran' });
      assert.equal(tracer.finished().length, 1, 'guard attrs drained exactly once');
    } finally {
      await tracer.shutdown();
    }
  });

  it('resolveConfirm("no") closes the span and keeps the earlier guard attrs', async () => {
    const tracer = makeInMemoryTracer();
    try {
      const rt = runtimeWithTracer('confirm', tracer, 'ask');
      const r = await rt.onPreTool(
        's1', 'call-1', 'exec', { command: 'curl x' }, preEvent('curl x'),
      );
      assert.equal(r.decision, 'ask');
      assert.equal(r.block, false);
      assert.equal(tracer.finished().length, 0, 'nothing emitted while awaiting the user');

      const resolved = await rt.resolveConfirm('s1', 'call-1', 'ask', r.reason, false);
      assert.equal(resolved.block, true);

      const spans = tracer.finished();
      assert.equal(spans.length, 1);
      assert.equal(spans[0]!.attributes['nio.guard.decision'], 'confirm_denied');
      // The merge must preserve what onPreTool parked, not replace it.
      assert.equal(typeof spans[0]!.attributes['nio.guard.eval_ms'], 'number');
    } finally {
      await tracer.shutdown();
    }
  });

  // A1. `flushSessionTurn` reclaims any span the host never closed. On
  // opencode that is the normal path for EVERY failing tool call:
  // `tool.execute.after` does not fire when a tool throws, so
  // `session.idle` → onTurnEnd is what closes the span. It used to call
  // recordPostToolUse with `{}` attrs and `error: null`, which threw
  // away the parked guard attribution and left the span
  // indistinguishable from one closed on a successful return.
  it('reclaimed span carries the guard attrs parked for it', async () => {
    const tracer = makeInMemoryTracer();
    try {
      const rt = runtimeWithTracer('allow', tracer);
      await rt.onPreTool('s1', 'call-1', 'exec', { command: 'ls' }, preEvent('ls'));
      // No onPostTool — the tool "threw" and opencode skipped the
      // after-hook. The turn flush has to reclaim the span.
      await rt.onTurnEnd('s1');

      const toolSpans = tracer.finished().filter(s => s.name.startsWith('execute_tool'));
      assert.equal(toolSpans.length, 1, 'the pending span is reclaimed at turn flush');
      const attrs = toolSpans[0]!.attributes;
      assert.equal(attrs['nio.guard.decision'], 'allow');
      assert.equal(attrs['nio.guard.risk_level'], 'low');
      assert.equal(typeof attrs['nio.guard.risk_score'], 'number');
      assert.equal(typeof attrs['nio.guard.eval_ms'], 'number');
    } finally {
      await tracer.shutdown();
    }
  });

  it('reclaimed span is tagged reclaimed and asserts no outcome', async () => {
    const tracer = makeInMemoryTracer();
    try {
      const rt = runtimeWithTracer('allow', tracer);
      await rt.onPreTool('s1', 'call-1', 'exec', { command: 'ls' }, preEvent('ls'));
      await rt.onTurnEnd('s1');

      const toolSpans = tracer.finished().filter(s => s.name.startsWith('execute_tool'));
      assert.equal(toolSpans.length, 1);
      const span = toolSpans[0]!;
      // Explicitly marked as reclaimed, so a consumer can tell it apart
      // from a span closed on a real tool return.
      assert.equal(span.attributes['nio.span.reclaimed'], true);
      assert.equal(span.attributes['nio.span.reclaim_reason'], 'no_post_tool_event');
      // ...and no claim is made about the outcome in either direction:
      // not ERROR (the tool may well have succeeded) and no result
      // payload (nothing delivered one).
      assert.notEqual(span.status.code, SpanStatusCode.ERROR);
      assert.equal(span.attributes['gen_ai.tool.call.result'], undefined);
    } finally {
      await tracer.shutdown();
    }
  });

  it('a normally closed span is NOT tagged reclaimed', async () => {
    const tracer = makeInMemoryTracer();
    try {
      const rt = runtimeWithTracer('allow', tracer);
      await rt.onPreTool('s1', 'call-1', 'exec', { command: 'ls' }, preEvent('ls'));
      await rt.onPostTool('s1', 'call-1', 'exec', { result: 'ok' });
      await rt.onTurnEnd('s1');

      const toolSpans = tracer.finished().filter(s => s.name.startsWith('execute_tool'));
      assert.equal(toolSpans.length, 1, 'exactly one tool span, closed by the post side');
      assert.equal(toolSpans[0]!.attributes['nio.span.reclaimed'], undefined);
    } finally {
      await tracer.shutdown();
    }
  });
});

// Fix round 1 (C1, Critical): a reviewer reproduced that a deny becomes
// an allow when the span-close call fails. `onPreTool`'s block path
// awaited `closeSpan` (→ provider.getTracer / recordPostToolUse /
// forceFlush) unguarded; if any of it threw, `onPreTool` itself
// rejected. Every binding's catch treats "not my deliberate block
// error" as "fail open" — so the underlying deny was silently lost and
// the tool ran. Fixed by adding `safeCloseSpan` (catches internally)
// and using it on both already-decided paths: onPreTool's block branch
// and resolveConfirm's "user said no" branch. This is shared-runtime
// code, so it protects Pi and OpenClaw too, not just opencode.
describe('InProcessPluginRuntime — a decided block survives a telemetry failure (C1)', () => {
  function runtimeWithExplodingTracer(verdict: 'deny' | 'confirm', confirmAction?: 'allow' | 'deny' | 'ask') {
    const explodingProvider = {
      getTracer() { throw new Error('boom: getTracer throws'); },
      async forceFlush() {},
      async shutdown() {},
    };
    const rt = new InProcessPluginRuntime({
      platform: 'test-platform',
      adapter: new OpenClawAdapter(),
      tracerProvider: explodingProvider as never,
      meterProvider: null,
      ...(confirmAction ? { confirmAction } : {}),
      nioFactory: () => ({
        orchestrator: {
          async evaluate() {
            return {
              decision: verdict,
              risk_level: 'high',
              scores: { final: 0.9 },
              findings: [{ rule_id: 'TEST_RULE' }],
              explanation: 'test verdict',
              phase_stopped: 2,
              diagnostics: [],
            };
          },
        },
      }) as never,
    });
    return rt;
  }

  it('onPreTool still returns { block: true } when closing the orphan span throws', async () => {
    const rt = runtimeWithExplodingTracer('deny');
    // BEFORE the fix this rejected instead of resolving — the reviewer's
    // repro: "handler resolved [without a deny], opencode will run
    // rm -rf /". Awaiting it directly here means a regression shows up
    // as a rejected test, not a silently-swallowed pass.
    const r = await rt.onPreTool(
      's1', 'call-1', 'exec', { command: 'rm -rf /' },
      { toolName: 'exec', params: { command: 'rm -rf /' } },
    );
    assert.equal(r.block, true);
    assert.equal(r.decision, 'deny');
  });

  it('resolveConfirm still returns { block: true } for a "no" when closing the span throws', async () => {
    const rt = runtimeWithExplodingTracer('confirm', 'ask');
    const pre = await rt.onPreTool(
      's1', 'call-1', 'exec', { command: 'curl x' },
      { toolName: 'exec', params: { command: 'curl x' } },
    );
    assert.equal(pre.decision, 'ask');
    assert.equal(pre.block, false);

    const resolved = await rt.resolveConfirm('s1', 'call-1', 'ask', pre.reason, false);
    assert.equal(resolved.block, true);
    assert.equal(resolved.decision, 'confirm_denied');
  });
});

describe('InProcessPluginRuntime auxiliary signals', () => {
  // Tracing explicitly OFF. Do not rely on the harness's empty NIO_HOME
  // producing a null provider — state that implicitly is how Task 2's
  // span wiring went uncovered.
  function makeRuntime() {
    return new InProcessPluginRuntime({
      platform: 'test-platform',
      adapter: new OpenClawAdapter(),
      tracerProvider: null,
      meterProvider: null,
    });
  }

  it('onUserPrompt does not create state when tracing is off', () => {
    // Prompt capture is a tracing-only concern and must short-circuit.
    const rt = makeRuntime();
    rt.onUserPrompt('s2', 'hello');
    assert.equal(rt.hasSessionState('s2'), false);
  });

  it('onLlmUsage always accumulates, even with tracing off', () => {
    // Unlike prompt capture, usage accumulation feeds metrics as well as
    // spans, so it creates turn state unconditionally.
    const rt = makeRuntime();
    rt.onLlmUsage('s2', { input: 10 });
    assert.equal(rt.hasSessionState('s2'), true);
  });

  it('onLlmUsage tolerates an empty usage object', () => {
    const rt = makeRuntime();
    rt.onLlmUsage('s2', {});
    assert.equal(rt.hasSessionState('s2'), true);
  });

  it('onUserBash writes an audit row without throwing', () => {
    const rt = makeRuntime();
    rt.onUserBash('s2', 'ls -la', '/tmp');
  });

  it('onSubagentStart/End are safe when no state exists', async () => {
    const rt = makeRuntime();
    await rt.onSubagentStart('s3', 'task-1');
    await rt.onSubagentEnd('s3', 'task-1');
  });

  it('dispatchCommand routes an empty arg string to the config handler', async () => {
    const rt = makeRuntime();
    const out = await rt.dispatchCommand('');
    assert.equal(typeof out, 'string');
    assert.ok(out.length > 0);
  });
});

// Same lesson as Task 2: with a null provider none of the turn-state
// plumbing runs. These drive a real in-memory tracer so the prompt /
// reply / usage attributes and the sub-agent span can actually fail.
describe('InProcessPluginRuntime auxiliary signals — span wiring', () => {
  function tracedRuntime(tracer: ReturnType<typeof makeInMemoryTracer>) {
    return new InProcessPluginRuntime({
      platform: 'test-platform',
      adapter: new OpenClawAdapter(),
      tracerProvider: tracer.provider,
      meterProvider: null,
    });
  }

  it('carries prompt, reply, and token usage onto the turn root span', async () => {
    const tracer = makeInMemoryTracer();
    try {
      const rt = tracedRuntime(tracer);
      rt.onUserPrompt('s1', 'why is the build red?');
      rt.onAssistantReply('s1', 'a lint rule changed');
      rt.onLlmUsage('s1', { input: 120, output: 45, cacheRead: 30, cacheWrite: 10 });
      rt.onLlmUsage('s1', { input: 80 });   // must accumulate, not overwrite

      await rt.onTurnEnd('s1');

      const spans = tracer.finished();
      assert.equal(spans.length, 1, 'exactly one turn root span');
      const attrs = spans[0]!.attributes;
      assert.equal(attrs['nio.turn.user_prompt'], 'why is the build red?');
      assert.equal(attrs['nio.turn.assistant_reply'], 'a lint rule changed');
      assert.equal(attrs['gen_ai.usage.input_tokens'], 200);   // 120 + 80
      assert.equal(attrs['gen_ai.usage.output_tokens'], 45);
      assert.equal(attrs['gen_ai.usage.cache_read.input_tokens'], 30);
      assert.equal(attrs['gen_ai.usage.cache_creation.input_tokens'], 10);
      assert.equal(rt.hasSessionState('s1'), false, 'state dropped after the flush');
    } finally {
      await tracer.shutdown();
    }
  });

  it('emits a sub-agent span between onSubagentStart and onSubagentEnd', async () => {
    const tracer = makeInMemoryTracer();
    try {
      const rt = tracedRuntime(tracer);
      await rt.onSubagentStart('s1', 'task-1');
      assert.equal(tracer.finished().length, 0, 'nothing emitted while the sub-agent runs');

      await rt.onSubagentEnd('s1', 'task-1');
      assert.equal(tracer.finished().length, 1, 'sub-agent span emitted on end');
    } finally {
      await tracer.shutdown();
    }
  });
});

// ── The accumulated conversation events are PER TURN ──────────────────
//
// `recordConversationEvent` is the only conversation source the streaming
// platforms have (OpenClaw, opencode): there is no session file to read
// back, so the events themselves ARE the conversation. That makes their
// lifetime load-bearing — anything still in the map when the next turn
// closes is replayed as THAT turn's chat spans, with no timestamp
// backstop to catch it (`openclaw-source.ts` synthesises `startMs` from
// `Date.now()` at read time, so `callsSince`'s filter is always true).
//
// The platform tag matters here: `createSourceForPlatform` only builds an
// event source for a real platform name, so these use 'openclaw' rather
// than the 'test-platform' tag the suites above use.
describe('InProcessPluginRuntime conversation-event lifecycle', () => {
  /**
   * An `llm_output` envelope in the shape OpenClaw's docs actually
   * commit to: metadata only, NO `usage` and NO `assistantTexts`. That
   * matters — openclaw-plugin.ts calls `onLlmUsage` only when `usage`
   * is present and `onAssistantReply` only when `assistantTexts` is
   * non-empty, so an event of this shape creates no turn state at all.
   */
  function llmOutput(callId: string) {
    return {
      hook: 'llm_output',
      event: {
        runId: 'run-1', callId, provider: 'anthropic', model: 'claude-x',
        outcome: 'success', durationMs: 5,
      },
    };
  }

  function openClawRuntime(tracer: ReturnType<typeof makeInMemoryTracer>) {
    return new InProcessPluginRuntime({
      platform: 'openclaw',
      adapter: new OpenClawAdapter(),
      tracerProvider: tracer.provider,
      meterProvider: null,
      loggerProvider: null,
    });
  }

  const chatSpans = (tracer: ReturnType<typeof makeInMemoryTracer>) =>
    tracer.finished().filter(s => s.name.startsWith('chat'));

  it('a turn that ended with no state still drops its events (C1)', async () => {
    // The `!state` early return in `flushSessionTurn` used to be the one
    // exit that kept `conversationEvents` — and it is a routinely-taken
    // production path, not a theoretical one: a turn made only of
    // documented-shape `llm_output` events never reaches `onLlmUsage` /
    // `onAssistantReply`, so `agent_end` finds no turn state. Turn 2
    // then replayed turn 1's events as its own chat spans.
    const tracer = makeInMemoryTracer();
    try {
      const rt = openClawRuntime(tracer);

      rt.recordConversationEvent('s1', llmOutput('t1-a'));
      rt.recordConversationEvent('s1', llmOutput('t1-b'));
      rt.recordConversationEvent('s1', llmOutput('t1-c'));
      await rt.onTurnEnd('s1');
      assert.equal(
        tracer.finished().length, 0,
        'sanity: a turn with no state exports nothing, so turn 1 contributes no span of its own',
      );

      // Turn 2 DOES have state (a user prompt), so it reaches the export
      // path and reconstructs chat spans from whatever is in the map.
      rt.onUserPrompt('s1', 'second turn');
      rt.recordConversationEvent('s1', llmOutput('t2-a'));
      await rt.onTurnEnd('s1');

      assert.equal(
        chatSpans(tracer).length, 1,
        'turn 2 must produce exactly its own chat span — turn 1\'s three events were dropped at ITS boundary',
      );
    } finally {
      await tracer.shutdown();
    }
  });

  it('a recycled session id does not replay the previous session\'s events (I2)', async () => {
    // The other clearing site: `onSessionStart`. No turn boundary runs
    // between the two sessions here, so this pins that delete alone.
    const tracer = makeInMemoryTracer();
    try {
      const rt = openClawRuntime(tracer);

      rt.recordConversationEvent('s-recycled', llmOutput('old-a'));
      rt.recordConversationEvent('s-recycled', llmOutput('old-b'));
      rt.recordConversationEvent('s-recycled', llmOutput('old-c'));

      // Same id, brand new session.
      rt.onSessionStart('s-recycled');
      rt.onUserPrompt('s-recycled', 'fresh session');
      rt.recordConversationEvent('s-recycled', llmOutput('new-a'));
      await rt.onTurnEnd('s-recycled');

      assert.equal(
        chatSpans(tracer).length, 1,
        'a new session under a reused id must not inherit the old session\'s calls',
      );
    } finally {
      await tracer.shutdown();
    }
  });

  it('caps accumulated events at 200 per session, dropping the oldest (M7)', async () => {
    // The cap is what stops a long-running host's per-session array from
    // growing without bound. Nothing pinned the number, so it could be
    // raised (leak restored) or lowered (chat spans silently lost)
    // without a single test noticing.
    const tracer = makeInMemoryTracer();
    try {
      const rt = openClawRuntime(tracer);
      for (let i = 0; i < 250; i++) rt.recordConversationEvent('s-cap', llmOutput(`c-${i}`));
      rt.onUserPrompt('s-cap', 'go');
      await rt.onTurnEnd('s-cap');

      assert.equal(
        chatSpans(tracer).length, 200,
        'exactly the last 200 events survive the cap',
      );
    } finally {
      await tracer.shutdown();
    }
  });

  /**
   * A tracer provider that builds every chat span normally and then
   * throws when the TURN ROOT is started — i.e. the export path blowing
   * up after part of the tree already exists.
   *
   * Why not a rejecting `forceFlush` (what this helper used to be): the
   * flush is deliberately no longer a throw vector. `traces-collector`'s
   * `flushSpans` swallows it, and the runtime's trailing flush catches
   * it, because `BatchSpanProcessor.forceFlush()` REJECTS on a failed
   * export where `SimpleSpanProcessor`'s resolved — so after the
   * processor swap an unreachable collector would have started throwing
   * out of every turn boundary. Telemetry must not do that. The exit
   * this test exists for is still reachable, just through a different
   * door: anything raised while the tree is being built (a provider
   * whose tracer rejects a span, an SDK that throws on a bad attribute)
   * still propagates out of `endTurn`, and the `finally` is what has to
   * clear the turn's events.
   *
   * A plain delegating object rather than a subclass or a Proxy: the
   * runtime and traces-collector only ever call `getTracer` and
   * `forceFlush` on it, and wrapping the real NodeTracerProvider by
   * inheritance risks tripping over its own internals rather than
   * testing ours.
   */
  function brokenFlushProvider(
    provider: ReturnType<typeof makeInMemoryTracer>['provider'],
  ): ReturnType<typeof makeInMemoryTracer>['provider'] {
    return {
      getTracer: (...args: Parameters<typeof provider.getTracer>) => {
        const tracer = provider.getTracer(...args);
        return new Proxy(tracer, {
          get(target, prop, receiver) {
            if (prop !== 'startSpan') return Reflect.get(target, prop, receiver);
            return (name: string, ...rest: unknown[]) => {
              // The turn root, emitted last, after every chat span.
              if (name.startsWith('invoke_agent')) throw new Error('OTLP exporter down');
              return (target.startSpan as (...a: unknown[]) => unknown)(name, ...rest);
            };
          },
        });
      },
      forceFlush: () => provider.forceFlush(),
      shutdown: () => provider.shutdown(),
      register: () => provider.register(),
    } as unknown as ReturnType<typeof makeInMemoryTracer>['provider'];
  }

  /**
   * The counterpart: a provider whose FLUSH rejects. This is what the
   * live OTLP path now does on any failed export — `BatchSpanProcessor`
   * replaced `SimpleSpanProcessor` so a turn bigger than the exporter's
   * 30-in-flight cap stops losing its root, and Batch's `forceFlush()`
   * rejects where Simple's resolved. It must not surface at the host.
   */
  function rejectingFlushProvider(
    provider: ReturnType<typeof makeInMemoryTracer>['provider'],
  ): ReturnType<typeof makeInMemoryTracer>['provider'] {
    return {
      getTracer: (...args: Parameters<typeof provider.getTracer>) => provider.getTracer(...args),
      forceFlush: async () => { throw new Error('OTLP exporter down'); },
      shutdown: () => provider.shutdown(),
      register: () => provider.register(),
    } as unknown as ReturnType<typeof makeInMemoryTracer>['provider'];
  }

  it('a rejecting flush does not surface at the turn boundary', async () => {
    // Two guards stand between the exporter and the host, and this pins
    // both: `traces-collector`'s `flushSpans` (inside `endTurn`) and the
    // `.catch()` on the runtime's trailing `tracerProvider.forceFlush()`.
    // Drop either one and an unreachable collector starts throwing out
    // of every turn boundary, which every binding's outer catch then
    // swallows — a silently broken host on a telemetry fault.
    const tracer = makeInMemoryTracer();
    try {
      const rt = new InProcessPluginRuntime({
        platform: 'openclaw',
        adapter: new OpenClawAdapter(),
        tracerProvider: rejectingFlushProvider(tracer.provider),
        meterProvider: null,
        loggerProvider: null,
      });

      rt.onUserPrompt('s-flush', 'turn one');
      rt.recordConversationEvent('s-flush', llmOutput('t1-a'));
      await assert.doesNotReject(
        () => rt.onTurnEnd('s-flush'),
        'a failed export must never propagate into the host',
      );
      assert.equal(
        chatSpans(tracer).length, 1,
        'sanity: the turn still built its chat span — the flush is the only thing that failed',
      );
    } finally {
      await tracer.shutdown();
    }
  });

  it('drops the turn\'s events even when the export path THROWS (C1-throwing-exit)', async () => {
    // The third exit `flushSessionTurn`'s try/finally exists for, and the
    // only one the two cases above cannot reach. It is not hypothetical:
    // `endTurn` and `recordPostToolUse` drive an OTEL SDK that can raise
    // mid-tree, and every binding's outer catch swallows the rejection —
    // so a broken exporter would leave the turn's events in the map to
    // be replayed by the NEXT turn as its own chat spans, the exact bug
    // the clearing exists to prevent, now with no error visible anywhere
    // to explain it.
    const tracer = makeInMemoryTracer();
    try {
      const rt = new InProcessPluginRuntime({
        platform: 'openclaw',
        adapter: new OpenClawAdapter(),
        tracerProvider: brokenFlushProvider(tracer.provider),
        meterProvider: null,
        loggerProvider: null,
      });

      rt.onUserPrompt('s-throw', 'turn one');
      rt.recordConversationEvent('s-throw', llmOutput('t1-a'));
      rt.recordConversationEvent('s-throw', llmOutput('t1-b'));
      await assert.rejects(
        () => rt.onTurnEnd('s-throw'),
        /OTLP exporter down/,
        'sanity: the export path really did throw, so the finally is what runs',
      );
      assert.equal(
        chatSpans(tracer).length, 2,
        'sanity: turn 1 built both of its chat spans before the export blew up',
      );

      rt.onUserPrompt('s-throw', 'turn two');
      rt.recordConversationEvent('s-throw', llmOutput('t2-a'));
      await assert.rejects(() => rt.onTurnEnd('s-throw'), /OTLP exporter down/);

      assert.equal(
        chatSpans(tracer).length, 3,
        'turn 2 must contribute exactly ONE new chat span — five means turn 1\'s two events ' +
          'survived its throwing exit and were replayed as turn 2\'s own calls',
      );
    } finally {
      await tracer.shutdown();
    }
  });
});

// ── The transcript path is PER SESSION, not per turn ──────────────────
//
// The mirror image of the block above. `conversationEvents` is dropped at
// every turn boundary; `transcriptPaths` deliberately survives it, because
// the replay platforms (Pi) re-read the same session file on every turn
// scoped by `callsSince(turn_start_ms)`. That makes `onSessionEnd` the
// only turn-independent place the path stops being ours — and the only
// thing standing between a torn-down session and a later turn under the
// same id replaying its file.
describe('InProcessPluginRuntime transcript-path lifecycle', () => {
  const chatSpans = (tracer: ReturnType<typeof makeInMemoryTracer>) =>
    tracer.finished().filter(s => s.name.startsWith('chat'));

  it('onSessionEnd stops the session file being ours to replay (M1)', async () => {
    const tracer = makeInMemoryTracer();
    try {
      const rt = new InProcessPluginRuntime({
        platform: 'pi',
        adapter: new OpenClawAdapter(),
        tracerProvider: tracer.provider,
        meterProvider: null,
        loggerProvider: null,
      });

      const dir = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-transcript-life-')));
      const sessionFile = join(dir, 'session.jsonl');
      // Stamped in the future so `callsSince(turn_start_ms)` accepts it
      // on BOTH turns — otherwise turn 2 would drop the entry on the
      // timestamp alone and the assertion would hold for the wrong
      // reason, i.e. pass even with the delete removed.
      const future = Date.now() + 60_000;
      writeFileSync(
        sessionFile,
        JSON.stringify({
          type: 'message', id: 'm1', parentId: null,
          timestamp: new Date(future).toISOString(),
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'placeholder reply' }],
            provider: 'anthropic', model: 'pi-transcript-model',
            stopReason: 'endTurn', timestamp: future,
          },
        }) + '\n',
        'utf-8',
      );

      rt.setTranscriptPath('s-file', sessionFile);
      rt.onUserPrompt('s-file', 'first turn');
      await rt.onSessionEnd('s-file');
      assert.equal(
        chatSpans(tracer).length, 1,
        'sanity: the session file really was readable and really did produce a chat span',
      );

      // Same id, no `session_start` in between — a host that recycles ids
      // without re-announcing them, which is exactly the case
      // onSessionStart\'s own delete cannot cover.
      rt.onUserPrompt('s-file', 'turn after teardown');
      await rt.onTurnEnd('s-file');

      assert.equal(
        chatSpans(tracer).length, 1,
        'no new chat span: the ended session\'s transcript must no longer be ours to replay',
      );
    } finally {
      await tracer.shutdown();
    }
  });
});

describe('registerPiExtension', () => {
  /** Minimal stand-in for Pi's ExtensionAPI. */
  function fakePi() {
    const handlers = new Map<string, (e: unknown, ctx: unknown) => Promise<unknown>>();
    const commands: string[] = [];
    return {
      handlers,
      commands,
      on(name: string, fn: (e: unknown, ctx: unknown) => Promise<unknown>) {
        handlers.set(name, fn);
      },
      registerCommand(name: string) { commands.push(name); },
      registerTool() { /* unused */ },
    };
  }

  function fakeCtx(hasUI: boolean, confirmAnswer = true) {
    return {
      hasUI,
      cwd: '/tmp',
      ui: {
        async confirm() { return confirmAnswer; },
        notify() { /* no-op */ },
      },
      sessionManager: { getSessionId: () => 'pi-session-1' },
    };
  }

  it('subscribes to every event Nio needs', async () => {
    const { registerPiExtension } = await import('../adapters/pi-plugin.js');
    const pi = fakePi();
    registerPiExtension(pi as never);
    for (const name of [
      'tool_call', 'tool_result', 'input', 'session_start', 'session_shutdown',
      'agent_end', 'message_end', 'user_bash', 'resources_discover',
    ]) {
      assert.ok(pi.handlers.has(name), `missing handler: ${name}`);
    }
  });

  it('registers the /nio command', async () => {
    const { registerPiExtension } = await import('../adapters/pi-plugin.js');
    const pi = fakePi();
    registerPiExtension(pi as never);
    assert.ok(pi.commands.includes('nio'));
  });

  it('tool_call fails open when the handler throws internally', async () => {
    const { registerPiExtension } = await import('../adapters/pi-plugin.js');
    const pi = fakePi();
    registerPiExtension(pi as never);
    const handler = pi.handlers.get('tool_call')!;
    // A ctx with no sessionManager makes the internal session-id lookup throw.
    const out = await handler({ toolName: 'bash', input: { command: 'ls' } }, null);
    assert.equal(out, undefined);
  });

  it('user_bash never blocks AND never consults the guard', async () => {
    // Asserting only "returns undefined" would pass for a binding that ran
    // Phase 0-6 and threw the verdict away. Prove the orchestrator was
    // never consulted.
    const { registerPiExtension } = await import('../adapters/pi-plugin.js');
    let evaluated = false;
    const pi = fakePi();
    registerPiExtension(pi as never, {
      tracerProvider: null,
      meterProvider: null,
      nioFactory: () => ({
        orchestrator: {
          async evaluate() {
            evaluated = true;
            return {
              decision: 'deny', risk_level: 'high', scores: { final: 1 },
              findings: [], explanation: 'x', phase_stopped: 1, diagnostics: [],
            };
          },
        },
      }) as never,
    });
    const out = await pi.handlers.get('user_bash')!(
      { command: 'rm -rf /', cwd: '/tmp' }, fakeCtx(true),
    );
    assert.equal(out, undefined);
    assert.equal(evaluated, false, 'user_bash must not run Phase 0-6');
  });

  it('a refusal survives a telemetry failure', async () => {
    // The blanket catch must not convert a human "no" into an allow. Inject
    // a tracer provider whose getTracer throws, so resolveConfirm blows up
    // AFTER the user has already declined.
    const { registerPiExtension } = await import('../adapters/pi-plugin.js');
    const explodingProvider = {
      getTracer() { throw new Error('boom'); },
      async forceFlush() {},
      async shutdown() {},
    };
    const pi = fakePi();
    registerPiExtension(pi as never, {
      confirmAction: 'ask',
      tracerProvider: explodingProvider as never,
      meterProvider: null,
      nioFactory: () => ({
        orchestrator: {
          async evaluate() {
            return {
              decision: 'confirm', risk_level: 'high', scores: { final: 0.9 },
              findings: [{ rule_id: 'TEST_RULE' }], explanation: 'risky',
              phase_stopped: 2, diagnostics: [],
            };
          },
        },
      }) as never,
    });
    const out = await pi.handlers.get('tool_call')!(
      { toolName: 'bash', toolCallId: 'c1', input: { command: 'rm -rf /' } },
      fakeCtx(true, false),   // hasUI true, user answers "no"
    ) as { block?: boolean };
    assert.equal(out?.block, true, 'a refused action must stay blocked');
  });
});

// The four tests above only prove the handlers exist and don't throw —
// none of them actually drives a real deny/confirm verdict through, so
// none can catch the platform-specific bugs the brief calls out by name
// (reason vs blockReason, a skipped/ignored confirm answer, hasUI=false
// prompting anyway, a fabricated toolCallId). These tests inject a
// controlled orchestrator verdict (and, where needed, an in-memory
// tracer) so those specific regressions actually turn a test red.
describe('registerPiExtension — block path and confirm dialog', () => {
  function fakePi() {
    const handlers = new Map<string, (e: unknown, ctx: unknown) => Promise<unknown>>();
    const commands: string[] = [];
    return {
      handlers,
      commands,
      on(name: string, fn: (e: unknown, ctx: unknown) => Promise<unknown>) {
        handlers.set(name, fn);
      },
      registerCommand(name: string) { commands.push(name); },
      registerTool() { /* unused */ },
    };
  }

  /** ctx.ui.confirm as a spy: records whether/how it was called. */
  function fakeCtx(hasUI: boolean, confirmAnswer: boolean) {
    const confirmCalls: Array<{ title: string; message: string; timeout?: number }> = [];
    return {
      confirmCalls,
      ctx: {
        hasUI,
        cwd: '/tmp',
        ui: {
          async confirm(title: string, message: string, opts?: { timeout?: number }) {
            confirmCalls.push({ title, message, timeout: opts?.timeout });
            return confirmAnswer;
          },
          notify() { /* no-op */ },
        },
        sessionManager: { getSessionId: () => 'pi-session-1' },
      },
    };
  }

  function stubNioVerdict(verdict: 'allow' | 'deny' | 'confirm') {
    return () => ({
      orchestrator: {
        async evaluate() {
          return {
            decision: verdict,
            risk_level: verdict === 'allow' ? 'low' : 'high',
            scores: { final: verdict === 'allow' ? 0 : 0.9 },
            findings: verdict === 'allow' ? [] : [{ rule_id: 'TEST_RULE' }],
            explanation: 'test verdict',
            phase_stopped: 2,
            diagnostics: [],
          };
        },
      },
    }) as never;
  }

  /** Isolate NIO_HOME to a fresh tmpdir for the duration of `fn`, then
   *  restore whatever isolate-nio-home.js had already pinned it to.
   *  Never touches the real `~/.nio`. */
  async function withIsolatedNioHome<T>(
    fn: () => Promise<T>,
    configYaml?: string,
  ): Promise<T> {
    const had = Object.hasOwn(process.env, 'NIO_HOME');
    const prev = process.env.NIO_HOME;
    const nioHome = mkdtempSync(join(tmpdir(), 'nio-pi-plugin-test-'));
    process.env.NIO_HOME = nioHome;
    // Capture on, for the same reason the module-scope block above does
    // it: this helper's fresh home would otherwise start with the gate
    // closed and every span assertion inside `fn` would vacuously pass.
    writeCaptureOnConfig(nioHome, configYaml);
    try {
      return await fn();
    } finally {
      // Restore an originally-unset variable by DELETING it — assigning
      // `undefined` back stores the literal string "undefined", which
      // makes nioDir() write into a relative `undefined/` directory.
      if (had) process.env.NIO_HOME = prev;
      else delete process.env.NIO_HOME;
    }
  }

  it('blocks with { block, reason } — NOT { blockReason }', async () => {
    // Pi reads `reason`. Silently renaming this key (e.g. copy-pasting
    // OpenClaw's `blockReason`) would disable blocking on this platform
    // while every existing assertion above kept passing, so pin it.
    const { registerPiExtension } = await import('../adapters/pi-plugin.js');
    const pi = fakePi();
    registerPiExtension(pi as never, { nioFactory: stubNioVerdict('deny') });
    const { ctx } = fakeCtx(true, true);
    const out = await pi.handlers.get('tool_call')!(
      { toolName: 'bash', toolCallId: 'c1', input: { command: 'rm -rf /' } }, ctx,
    ) as { block?: boolean; reason?: string; blockReason?: string };

    assert.equal(out.block, true);
    assert.equal(typeof out.reason, 'string');
    assert.ok(out.reason!.length > 0);
    assert.equal(out.blockReason, undefined, 'must not switch to the OpenClaw-style `blockReason` key');
  });

  it('a "no" answer through ctx.ui.confirm blocks the call', async () => {
    await withIsolatedNioHome(async () => {
      const { registerPiExtension } = await import('../adapters/pi-plugin.js');
      const pi = fakePi();
      registerPiExtension(pi as never, { nioFactory: stubNioVerdict('confirm') });
      const { ctx, confirmCalls } = fakeCtx(true, false);
      const out = await pi.handlers.get('tool_call')!(
        { toolName: 'bash', toolCallId: 'c1', input: { command: 'curl x' } }, ctx,
      ) as { block?: boolean; reason?: string };

      assert.equal(confirmCalls.length, 1, 'ctx.ui.confirm must actually be invoked');
      assert.equal(out.block, true);
      assert.equal(typeof out.reason, 'string');
    }, 'guard:\n  confirm_action: ask\n');
  });

  it('a "yes" answer through ctx.ui.confirm allows the call', async () => {
    await withIsolatedNioHome(async () => {
      const { registerPiExtension } = await import('../adapters/pi-plugin.js');
      const pi = fakePi();
      registerPiExtension(pi as never, { nioFactory: stubNioVerdict('confirm') });
      const { ctx, confirmCalls } = fakeCtx(true, true);
      const out = await pi.handlers.get('tool_call')!(
        { toolName: 'bash', toolCallId: 'c1', input: { command: 'curl x' } }, ctx,
      );

      assert.equal(confirmCalls.length, 1, 'ctx.ui.confirm must actually be invoked');
      assert.equal(out, undefined, 'a "yes" answer must not block');
    }, 'guard:\n  confirm_action: ask\n');
  });

  it('always passes a timeout to ctx.ui.confirm so it can never hang', async () => {
    await withIsolatedNioHome(async () => {
      const { registerPiExtension } = await import('../adapters/pi-plugin.js');
      const pi = fakePi();
      registerPiExtension(pi as never, { nioFactory: stubNioVerdict('confirm') });
      const { ctx, confirmCalls } = fakeCtx(true, true);
      await pi.handlers.get('tool_call')!(
        { toolName: 'bash', toolCallId: 'c1', input: { command: 'curl x' } }, ctx,
      );
      assert.equal(confirmCalls.length, 1);
      assert.equal(typeof confirmCalls[0]!.timeout, 'number');
      assert.ok(confirmCalls[0]!.timeout! > 0);
    }, 'guard:\n  confirm_action: ask\n');
  });

  it('ctx.hasUI === false never calls ctx.ui.confirm and folds instead of hanging', async () => {
    await withIsolatedNioHome(async () => {
      const { registerPiExtension } = await import('../adapters/pi-plugin.js');
      const pi = fakePi();
      registerPiExtension(pi as never, { nioFactory: stubNioVerdict('confirm') });
      // hasUI: false — print/json mode. If the answer were true here it
      // would prove the implementation prompted anyway.
      const { ctx, confirmCalls } = fakeCtx(false, true);
      const out = await pi.handlers.get('tool_call')!(
        { toolName: 'bash', toolCallId: 'c1', input: { command: 'curl x' } }, ctx,
      );

      assert.equal(confirmCalls.length, 0, 'no UI channel — must not attempt to prompt');
      // Falls back to the same two-state semantics every other platform
      // uses (folds "ask" to allow), so the agent is never left hanging.
      assert.equal(out, undefined);
    }, 'guard:\n  confirm_action: ask\n');
  });

  it('forwards the real toolCallId onto the span, never the fallback spanKey', async () => {
    const tracer = makeInMemoryTracer();
    try {
      const { registerPiExtension } = await import('../adapters/pi-plugin.js');
      const pi = fakePi();
      registerPiExtension(pi as never, {
        nioFactory: stubNioVerdict('allow'),
        tracerProvider: tracer.provider,
        meterProvider: null,
      });
      const { ctx } = fakeCtx(true, true);

      // No toolCallId on the event → must NOT fabricate one from the tool
      // name (spanKey falls back to toolName internally).
      await pi.handlers.get('tool_call')!({ toolName: 'bash', input: { command: 'ls' } }, ctx);
      await pi.handlers.get('tool_result')!({ toolName: 'bash', content: 'ok' }, ctx);

      // Real toolCallId on the event → carried through verbatim.
      await pi.handlers.get('tool_call')!(
        { toolName: 'bash', toolCallId: 'call-77', input: { command: 'ls' } }, ctx,
      );
      await pi.handlers.get('tool_result')!(
        { toolName: 'bash', toolCallId: 'call-77', content: 'ok' }, ctx,
      );

      // Pi parks its tool spans for end-of-turn attribution (see
      // PluginRuntimeOptions.eagerToolSpans), so the turn has to close
      // before anything reaches the exporter.
      await pi.handlers.get('agent_end')!({}, ctx);

      const spans = tracer.finished().filter((s) => s.name.startsWith('execute_tool'));
      assert.equal(spans.length, 2);
      assert.equal(spans[0]!.attributes['gen_ai.tool.call.id'], undefined);
      assert.equal(spans[1]!.attributes['gen_ai.tool.call.id'], 'call-77');
    } finally {
      await tracer.shutdown();
    }
  });

  it('reads tool parameters from `input` (Pi\'s key), not `params`', async () => {
    // stubNioVerdict ignores whatever params it's handed, so nothing above
    // this pins the actual event key the binding reads. The only place the
    // real params show up is the span's tool-call-arguments attribute.
    const tracer = makeInMemoryTracer();
    try {
      const { registerPiExtension } = await import('../adapters/pi-plugin.js');
      const pi = fakePi();
      registerPiExtension(pi as never, {
        nioFactory: stubNioVerdict('allow'),
        tracerProvider: tracer.provider,
        meterProvider: null,
      });
      const { ctx } = fakeCtx(true, true);

      await pi.handlers.get('tool_call')!(
        { toolName: 'bash', toolCallId: 'c1', input: { command: 'echo unique-marker-123' } }, ctx,
      );
      await pi.handlers.get('tool_result')!(
        { toolName: 'bash', toolCallId: 'c1', content: 'unique-marker-123' }, ctx,
      );
      // Deferred until turn close — see the toolCallId test above.
      await pi.handlers.get('agent_end')!({}, ctx);

      const spans = tracer.finished().filter((s) => s.name.startsWith('execute_tool'));
      assert.equal(spans.length, 1);
      const args = spans[0]!.attributes['gen_ai.tool.call.arguments'];
      assert.equal(typeof args, 'string');
      assert.ok(
        (args as string).includes('unique-marker-123'),
        `expected the recorded arguments to carry the command, got: ${args}`,
      );
    } finally {
      await tracer.shutdown();
    }
  });
});

describe('createNioPlugin (opencode)', () => {
  const pluginInput = {
    client: {}, project: {}, directory: '/tmp', worktree: '/tmp',
    $: (() => {}) as never, serverUrl: new URL('http://127.0.0.1:1'),
  };

  it('exposes every hook Nio needs', async () => {
    const { createNioPlugin } = await import('../adapters/opencode-plugin.js');
    const hooks = await createNioPlugin()(pluginInput as never);
    for (const name of [
      'tool.execute.before', 'tool.execute.after', 'chat.message',
      'permission.ask', 'event', 'dispose',
    ]) {
      assert.ok(name in hooks, `missing hook: ${name}`);
    }
    assert.ok(hooks.tool && 'nio_command' in hooks.tool);
  });

  it('tool.execute.before swallows internal errors instead of leaking a defect', async () => {
    // Fix round 1 (I3): the brief's original version of this test passed
    // `null` as hookOutput, but `hookOutput?.args ?? {}` makes that
    // harmless — the handler's body runs to completion whether or not
    // the try/catch is even there, so the test was vacuous (it could
    // never go red for a missing catch). This version forces a REAL
    // throw inside the try — a getter on `args` that throws the moment
    // it's accessed — so the assertion actually depends on the catch
    // working.
    const { createNioPlugin } = await import('../adapters/opencode-plugin.js');
    const hooks = await createNioPlugin()(pluginInput as never);
    const throwingOutput = {
      get args(): never { throw new Error('boom: args getter throws'); },
    };
    await hooks['tool.execute.before']!(
      { tool: 'bash', sessionID: 's1', callID: 'c1' } as never,
      throwingOutput as never,
    );
  });

  it('NioBlockedError carries the denial reason', async () => {
    const { NioBlockedError } = await import('../adapters/opencode-plugin.js');
    const err = new NioBlockedError('nope');
    assert.equal(err.message, 'nope');
    assert.equal(err.name, 'NioBlockedError');
    assert.ok(err instanceof Error);
  });

  it('the nio_command tool returns dispatcher text', async () => {
    const { createNioPlugin } = await import('../adapters/opencode-plugin.js');
    const hooks = await createNioPlugin()(pluginInput as never);
    const out = await hooks.tool!['nio_command']!.execute(
      { command: '' } as never, {} as never,
    );
    assert.equal(typeof out, 'string');
  });
});

// The four tests above only prove the hooks exist and don't throw — none
// of them drive a real deny verdict through, force an internal exception
// in a non-block handler, or exercise the opencode-specific span wiring
// (toolCallId forwarding, session.idle reclaiming a leaked span,
// sub-agent detection via parentID). Those are exactly the regressions
// the brief calls out by name, so pin them with controlled verdicts and
// an in-memory tracer.
describe('createNioPlugin (opencode) — block path and span wiring', () => {
  const pluginInput = {
    client: {}, project: {}, directory: '/tmp', worktree: '/tmp',
    $: (() => {}) as never, serverUrl: new URL('http://127.0.0.1:1'),
  };

  function stubNioVerdict(verdict: 'allow' | 'deny' | 'confirm') {
    return () => ({
      orchestrator: {
        async evaluate() {
          return {
            decision: verdict,
            risk_level: verdict === 'allow' ? 'low' : 'high',
            scores: { final: verdict === 'allow' ? 0 : 0.9 },
            findings: verdict === 'allow' ? [] : [{ rule_id: 'TEST_RULE' }],
            explanation: 'test verdict',
            phase_stopped: 2,
            diagnostics: [],
          };
        },
      },
    }) as never;
  }

  /** Isolate NIO_HOME to a fresh tmpdir for the duration of `fn`, then
   *  restore whatever isolate-nio-home.js had already pinned it to.
   *  Never touches the real `~/.nio`. Same pattern as the Pi plugin
   *  tests below — needed here to reach `confirm_action: ask`, which
   *  OpenCodePluginOptions has no override seam for. */
  async function withIsolatedNioHome<T>(
    fn: () => Promise<T>,
    configYaml?: string,
  ): Promise<T> {
    const had = Object.hasOwn(process.env, 'NIO_HOME');
    const prev = process.env.NIO_HOME;
    const nioHome = mkdtempSync(join(tmpdir(), 'nio-opencode-plugin-test-'));
    process.env.NIO_HOME = nioHome;
    // Capture on, for the same reason the module-scope block above does
    // it: this helper's fresh home would otherwise start with the gate
    // closed and every span assertion inside `fn` would vacuously pass.
    writeCaptureOnConfig(nioHome, configYaml);
    try {
      return await fn();
    } finally {
      // Restore an originally-unset variable by DELETING it — assigning
      // `undefined` back stores the literal string "undefined", which
      // makes nioDir() write into a relative `undefined/` directory.
      if (had) process.env.NIO_HOME = prev;
      else delete process.env.NIO_HOME;
    }
  }

  it('tool.execute.before rejects with NioBlockedError for a deny verdict', async () => {
    // The one deliberate exception in this file MUST actually escape —
    // opencode has no `{ block: true }` return value, so a swallowed
    // throw here means the tool call silently runs.
    const { createNioPlugin, NioBlockedError } = await import('../adapters/opencode-plugin.js');
    const hooks = await createNioPlugin({ nioFactory: stubNioVerdict('deny') })(pluginInput as never);
    await assert.rejects(
      () => hooks['tool.execute.before']!(
        { tool: 'bash', sessionID: 's1', callID: 'c1' } as never,
        { args: { command: 'rm -rf /' } } as never,
      ),
      NioBlockedError,
    );
  });

  it('tool.execute.after swallows a null hookInput instead of leaking a defect', async () => {
    const { createNioPlugin } = await import('../adapters/opencode-plugin.js');
    const hooks = await createNioPlugin()(pluginInput as never);
    // `hookInput.callID` on a null hookInput throws synchronously inside
    // the handler; it must resolve rather than reject.
    await hooks['tool.execute.after']!(null as never, { output: 'ok' } as never);
  });

  it('chat.message swallows a non-array `parts` instead of leaking a defect', async () => {
    const { createNioPlugin } = await import('../adapters/opencode-plugin.js');
    const hooks = await createNioPlugin()(pluginInput as never);
    // `parts` truthy but not an array — `.filter` is not a function on a
    // string, so this throws internally unless caught.
    await hooks['chat.message']!(
      {} as never,
      { message: { sessionID: 's1' }, parts: 'oops' } as never,
    );
  });

  it('permission.ask swallows a null output when hardening a parked "ask" verdict', async () => {
    // A 'deny' verdict already throws from tool.execute.before, so
    // opencode never reaches permission.ask for it (see I2 below) — the
    // only reachable verdict permission.ask can see is 'ask', which
    // requires confirm_action: ask to be parked in the first place.
    await withIsolatedNioHome(async () => {
      const { createNioPlugin } = await import('../adapters/opencode-plugin.js');
      const hooks = await createNioPlugin({ nioFactory: stubNioVerdict('confirm') })(pluginInput as never);

      await hooks['tool.execute.before']!(
        { tool: 'bash', sessionID: 's1', callID: 'c1' } as never,
        { args: {} } as never,
      );

      // Now permission.ask sees a parked 'ask' verdict for 'c1' and
      // tries to write `hookOutput.status` — on a null hookOutput that
      // throws a TypeError. It must be swallowed, not leaked.
      await hooks['permission.ask']!(
        { id: 'p1', type: 'bash', sessionID: 's1', callID: 'c1' } as never,
        null as never,
      );
    }, 'guard:\n  confirm_action: ask\n');
  });

  it('permission.ask forces an actual ask when Nio parked an "ask" verdict', async () => {
    // I2: the original 'deny' check in permission.ask was unreachable
    // dead code (a deny already threw from tool.execute.before, so
    // opencode never gets here for it). The reachable case is 'ask':
    // Nio wanted confirmation but provisionally let the call proceed
    // toward opencode's own permission system — this must not silently
    // resolve to whatever opencode's own heuristics picked for
    // `status`; it must force a real ask.
    await withIsolatedNioHome(async () => {
      const { createNioPlugin } = await import('../adapters/opencode-plugin.js');
      const hooks = await createNioPlugin({ nioFactory: stubNioVerdict('confirm') })(pluginInput as never);

      await hooks['tool.execute.before']!(
        { tool: 'bash', sessionID: 's1', callID: 'c1' } as never,
        { args: { command: 'curl x' } } as never,
      );

      const output: { status: 'ask' | 'deny' | 'allow' } = { status: 'allow' };
      await hooks['permission.ask']!(
        { id: 'p1', type: 'bash', sessionID: 's1', callID: 'c1' } as never,
        output,
      );
      assert.equal(output.status, 'ask', 'a parked ask verdict must force an actual ask, not silently allow');
    }, 'guard:\n  confirm_action: ask\n');
  });

  // NOTE: review round 1 (I2) specified an additional branch — verdict
  // 'ask' AND confirm_action 'deny' → force deny. It was implemented
  // literally, and the final review confirmed it is unreachable: if
  // confirm_action were 'deny' at the time tool.execute.before ran,
  // onPreTool would have folded straight to 'confirm_denied' and already
  // thrown, so verdictByCall could never hold 'ask'. The branch has been
  // removed from permission.ask rather than left as untestable dead code;
  // 'ask' is now the only status that handler writes.

  it('event swallows an internal throw from a broken meter provider (session.idle path)', async () => {
    const explodingMeterProvider = {
      getMeter() { throw new Error('boom'); },
    };
    const { createNioPlugin } = await import('../adapters/opencode-plugin.js');
    const hooks = await createNioPlugin({
      tracerProvider: null,
      meterProvider: explodingMeterProvider as never,
    })(pluginInput as never);
    await hooks.event!(
      { event: { type: 'session.idle', properties: { sessionID: 's1' } } } as never,
    );
  });

  it('forwards the real callID as opts.toolCallId onto the span', async () => {
    // genAiToolCallInputAttributes only sets `gen_ai.tool.call.id` when a
    // toolCallId is actually passed through opts — pin that it is, and
    // that it is the real opencode callID rather than a fallback.
    const tracer = makeInMemoryTracer();
    try {
      const { createNioPlugin } = await import('../adapters/opencode-plugin.js');
      const hooks = await createNioPlugin({
        nioFactory: stubNioVerdict('allow'),
        tracerProvider: tracer.provider,
        meterProvider: null,
      })(pluginInput as never);

      await hooks['tool.execute.before']!(
        { tool: 'bash', sessionID: 's1', callID: 'call-77' } as never,
        { args: { command: 'ls' } } as never,
      );
      await hooks['tool.execute.after']!(
        { tool: 'bash', sessionID: 's1', callID: 'call-77', args: { command: 'ls' } } as never,
        { title: 'ls', output: 'ok', metadata: {} } as never,
      );
      // opencode parks its tool spans for end-of-turn attribution (see
      // PluginRuntimeOptions.eagerToolSpans), so the session's idle has
      // to fire before anything reaches the exporter.
      await hooks.event!(
        { event: { type: 'session.idle', properties: { sessionID: 's1' } } } as never,
      );

      const spans = tracer.finished().filter((s) => s.name.startsWith('execute_tool'));
      assert.equal(spans.length, 1);
      assert.equal(spans[0]!.attributes['gen_ai.tool.call.id'], 'call-77');
    } finally {
      await tracer.shutdown();
    }
  });

  it('session.idle reclaims a pending span for a tool that threw and skipped tool.execute.after', async () => {
    // opencode-specific: when the tool itself throws, `tool.execute.after`
    // never fires (Effect.gen short-circuits), so the pending span from
    // tool.execute.before would leak forever without this safety net.
    const tracer = makeInMemoryTracer();
    try {
      const { createNioPlugin } = await import('../adapters/opencode-plugin.js');
      const hooks = await createNioPlugin({
        nioFactory: stubNioVerdict('allow'),
        tracerProvider: tracer.provider,
        meterProvider: null,
      })(pluginInput as never);

      await hooks['tool.execute.before']!(
        { tool: 'bash', sessionID: 's1', callID: 'c1' } as never,
        { args: { command: 'rm -rf /tmp/x' } } as never,
      );
      assert.equal(tracer.finished().length, 0, 'nothing emitted while the tool is (hypothetically) running');

      // tool.execute.after deliberately not called — simulates the tool
      // throwing and opencode skipping the after-hook.
      await hooks.event!(
        { event: { type: 'session.idle', properties: { sessionID: 's1' } } } as never,
      );

      // session.idle's onTurnEnd always emits a second "turn root" span
      // (`invoke_agent ...`) alongside whatever pending spans it reclaims,
      // so 2 total — the assertion that actually matters is that one of
      // them is the reclaimed tool span (proving it didn't leak forever),
      // not the exact count. Since A1, `flushSessionTurn` also drains
      // `pending_guard_attrs` on the reclaim path, so the reclaimed span
      // carries the same `nio.guard.*` attribution a normally closed one
      // does, plus explicit reclaim markers saying the outcome is
      // unknown.
      const spans = tracer.finished();
      assert.equal(spans.length, 2, 'the leaked pending span plus the turn root span');
      const toolSpan = spans.find(s => s.name.startsWith('execute_tool'));
      assert.ok(toolSpan, 'the leaked pending span must be reclaimed by session.idle');
      assert.equal(toolSpan!.attributes['nio.guard.decision'], 'allow');
      assert.equal(toolSpan!.attributes['nio.span.reclaimed'], true);
    } finally {
      await tracer.shutdown();
    }
  });

  it('detects a sub-agent session via Session.parentID and parks its task span under the parent', async () => {
    // If the binding used the sub-agent's own id instead of parentID,
    // flushing the PARENT session below would find nothing pending.
    const tracer = makeInMemoryTracer();
    try {
      const { createNioPlugin } = await import('../adapters/opencode-plugin.js');
      const hooks = await createNioPlugin({
        tracerProvider: tracer.provider,
        meterProvider: null,
      })(pluginInput as never);

      await hooks.event!({
        event: { type: 'session.created', properties: { info: { id: 'sub-1', parentID: 'parent-1' } } },
      } as never);
      assert.equal(tracer.finished().length, 0, 'only a pending task span parked, nothing emitted yet');

      await hooks.event!(
        { event: { type: 'session.idle', properties: { sessionID: 'parent-1' } } } as never,
      );

      // Same shape as the reclaim test above: the turn root span always
      // accompanies whatever gets flushed, so 2 total — the task span
      // itself is the proof that onSubagentStart landed on parentID.
      const spans = tracer.finished();
      assert.equal(spans.length, 2, 'the sub-agent task span plus the turn root span');
      assert.ok(
        spans.some(s => s.name === 'task:execute'),
        'task span for the sub-agent flushed under the parent session',
      );
    } finally {
      await tracer.shutdown();
    }
  });

  it('a deny still stops the tool when the tracer provider is broken (C1)', async () => {
    // The highest-value missing test flagged in review round 1: the
    // reviewer's repro showed `tool.execute.before` resolving instead of
    // rejecting when span-close telemetry failed, silently letting a
    // denied command run. This drives the exact same failure through the
    // opencode binding end-to-end and asserts NioBlockedError still
    // escapes.
    const explodingProvider = {
      getTracer() { throw new Error('boom: getTracer throws'); },
      async forceFlush() {},
      async shutdown() {},
    };
    const { createNioPlugin, NioBlockedError } = await import('../adapters/opencode-plugin.js');
    const hooks = await createNioPlugin({
      nioFactory: stubNioVerdict('deny'),
      tracerProvider: explodingProvider as never,
      meterProvider: null,
    })(pluginInput as never);

    await assert.rejects(
      () => hooks['tool.execute.before']!(
        { tool: 'bash', sessionID: 's1', callID: 'c1' } as never,
        { args: { command: 'rm -rf /' } } as never,
      ),
      NioBlockedError,
    );
  });

  it('closes the sub-agent task span via onSubagentEnd on the CHILD\'s own session.idle (I4)', async () => {
    // Before the fix, onSubagentEnd was never called at all — no
    // subagent_ended audit row, Task/TaskCompleted metric permanently
    // zero, span duration stretched to the parent's next idle. This
    // fires session.idle for the CHILD session (not the parent, unlike
    // the sub-agent detection test above) and asserts the task span
    // closes right away. No turn-root span for the child here: A2 added
    // a child-state flush before onSubagentEnd, but this child never ran
    // a tool, so `flushSessionTurn` finds no state and no-ops. The
    // sibling test below covers the case where it does have state.
    const tracer = makeInMemoryTracer();
    try {
      const { createNioPlugin } = await import('../adapters/opencode-plugin.js');
      const hooks = await createNioPlugin({
        tracerProvider: tracer.provider,
        meterProvider: null,
      })(pluginInput as never);

      await hooks.event!({
        event: { type: 'session.created', properties: { info: { id: 'sub-2', parentID: 'parent-2' } } },
      } as never);
      assert.equal(tracer.finished().length, 0);

      // The CHILD's own session.idle — not the parent's.
      await hooks.event!(
        { event: { type: 'session.idle', properties: { sessionID: 'sub-2' } } } as never,
      );

      const spans = tracer.finished();
      assert.equal(
        spans.length, 1,
        'exactly the task span — no turn-root span for the child, since onSubagentEnd runs instead of onTurnEnd',
      );
      assert.equal(spans[0]!.name, 'task:execute');
    } finally {
      await tracer.shutdown();
    }
  });

  it('flushes the CHILD session\'s own turn state at the child\'s session.idle (A2)', async () => {
    // A2: tools that run inside a sub-agent arrive at
    // tool.execute.before with hookInput.sessionID set to the CHILD id,
    // so onPreTool builds a CollectorState under that key. The
    // sub-agent branch of session.idle used to `return` straight after
    // onSubagentEnd, leaving that state to be swept only by dispose()'s
    // disposeAllSessions() — the child's tool spans landed under a late,
    // synthetic turn emitted at plugin teardown. Now the child's state
    // is flushed at its own idle.
    const tracer = makeInMemoryTracer();
    try {
      const { createNioPlugin } = await import('../adapters/opencode-plugin.js');
      const hooks = await createNioPlugin({
        nioFactory: stubNioVerdict('allow'),
        tracerProvider: tracer.provider,
        meterProvider: null,
      })(pluginInput as never);

      await hooks.event!({
        event: { type: 'session.created', properties: { info: { id: 'sub-3', parentID: 'parent-3' } } },
      } as never);

      // A tool running INSIDE the sub-agent — keyed on the child id.
      await hooks['tool.execute.before']!(
        { tool: 'bash', sessionID: 'sub-3', callID: 'c-sub' } as never,
        { args: { command: 'ls' } } as never,
      );
      await hooks['tool.execute.after']!(
        { tool: 'bash', sessionID: 'sub-3', callID: 'c-sub', args: { command: 'ls' } } as never,
        { title: 'ls', output: 'ok', metadata: {} } as never,
      );

      // Before the child's idle nothing has been emitted at all: the
      // child's turn root is still open, and its tool span is parked for
      // end-of-turn attribution rather than exported at
      // tool.execute.after (see PluginRuntimeOptions.eagerToolSpans).
      assert.equal(tracer.finished().length, 0);

      await hooks.event!(
        { event: { type: 'session.idle', properties: { sessionID: 'sub-3' } } } as never,
      );

      const spans = tracer.finished();
      assert.ok(
        spans.some(s => s.name === 'task:execute'),
        'the parent-side task span still closes',
      );
      assert.ok(
        spans.some(s => s.name.startsWith('invoke_agent')),
        'the child session\'s own turn root is emitted at the child\'s idle, not at dispose()',
      );
      assert.equal(
        spans.filter(s => s.name.startsWith('invoke_agent')).length,
        1,
        'exactly one turn root so far — the child\'s',
      );

      // ...and the child's state really is gone. Flush the parent too
      // (its own idle), then dispose(): nothing is left to sweep, so no
      // third, late turn root appears for the child.
      await hooks.event!(
        { event: { type: 'session.idle', properties: { sessionID: 'parent-3' } } } as never,
      );
      const beforeDispose = tracer.finished().filter(s => s.name.startsWith('invoke_agent')).length;
      await hooks.dispose!();
      assert.equal(
        tracer.finished().filter(s => s.name.startsWith('invoke_agent')).length,
        beforeDispose,
        'dispose() must not emit a late turn root for a session already flushed',
      );
    } finally {
      await tracer.shutdown();
    }
  });

  it('the child-session flush writes NO agent_end audit row (A2 side effect)', async () => {
    // A2's flush originally went through the public `onTurnEnd` (the
    // only reachable entry point, since `flushSessionTurn` is
    // protected), which writes an `agent_end` lifecycle row. Read
    // straight out of audit.jsonl, `agent_end` for a sub-agent child
    // session is indistinguishable from a *user* turn ending. The
    // sub-agent's lifecycle belongs to the parent's
    // subagent_spawning / subagent_ended pair; the child's flush is
    // bookkeeping and must stay silent.
    await withIsolatedNioHome(async () => {
      const nioHome = process.env.NIO_HOME!;
      const tracer = makeInMemoryTracer();
      try {
        const { createNioPlugin } = await import('../adapters/opencode-plugin.js');
        const hooks = await createNioPlugin({
          nioFactory: stubNioVerdict('allow'),
          tracerProvider: tracer.provider,
          meterProvider: null,
        })(pluginInput as never);

        await hooks.event!({
          event: { type: 'session.created', properties: { info: { id: 'sub-4', parentID: 'parent-4' } } },
        } as never);
        await hooks['tool.execute.before']!(
          { tool: 'bash', sessionID: 'sub-4', callID: 'c-sub4' } as never,
          { args: { command: 'ls' } } as never,
        );
        await hooks['tool.execute.after']!(
          { tool: 'bash', sessionID: 'sub-4', callID: 'c-sub4', args: { command: 'ls' } } as never,
          { title: 'ls', output: 'ok', metadata: {} } as never,
        );
        await hooks.event!(
          { event: { type: 'session.idle', properties: { sessionID: 'sub-4' } } } as never,
        );

        // The flush still happened — that is the A2 behaviour.
        assert.ok(
          tracer.finished().some(s => s.name.startsWith('invoke_agent')),
          'the child\'s turn root is still emitted',
        );

        const auditPath = join(nioHome, 'audit.jsonl');
        const rows = existsSync(auditPath)
          ? readFileSync(auditPath, 'utf-8')
              .split('\n')
              .filter(l => l.trim().length > 0)
              .map(l => JSON.parse(l) as { lifecycle_type?: string; session_id?: string })
          : [];
        assert.equal(
          rows.filter(r => r.lifecycle_type === 'agent_end').length,
          0,
          'a sub-agent child\'s idle must not log agent_end',
        );
        assert.ok(
          rows.some(r => r.lifecycle_type === 'subagent_ended' && r.session_id === 'parent-4'),
          'the sub-agent lifecycle is still recorded, on the PARENT',
        );
      } finally {
        await tracer.shutdown();
      }
    });
  });

  it('message.updated snapshots do not compound — the turn span carries the final count, not the sum (I5)', async () => {
    // opencode republishes message.updated on every change to the same
    // assistant message, with cumulative (not incremental) totals.
    // Feeding two growing snapshots straight into onLlmUsage (which
    // accumulates) would double-count; this drives the same message id
    // twice with growing totals and asserts the turn span carries only
    // the final snapshot's value.
    const tracer = makeInMemoryTracer();
    try {
      const { createNioPlugin } = await import('../adapters/opencode-plugin.js');
      const hooks = await createNioPlugin({
        tracerProvider: tracer.provider,
        meterProvider: null,
      })(pluginInput as never);

      await hooks.event!({
        event: {
          type: 'message.updated',
          properties: { info: { id: 'msg-1', sessionID: 's1', role: 'assistant', tokens: { input: 10, output: 5 } } },
        },
      } as never);
      await hooks.event!({
        event: {
          type: 'message.updated',
          properties: { info: { id: 'msg-1', sessionID: 's1', role: 'assistant', tokens: { input: 25, output: 12 } } },
        },
      } as never);

      await hooks.event!(
        { event: { type: 'session.idle', properties: { sessionID: 's1' } } } as never,
      );

      const spans = tracer.finished();
      const turnSpan = spans.find(s => s.name === 'invoke_agent UserPromptSubmit');
      assert.ok(turnSpan, 'turn root span must have been emitted');
      assert.equal(turnSpan!.attributes['gen_ai.usage.input_tokens'], 25, 'final snapshot value, not 10 + 25');
      assert.equal(turnSpan!.attributes['gen_ai.usage.output_tokens'], 12, 'final snapshot value, not 5 + 12');
    } finally {
      await tracer.shutdown();
    }
  });

  it('message.updated with no message id skips rather than risk double-counting a re-publish', async () => {
    // With no id to key the delta on, the handler must not call
    // onLlmUsage at all (skip, not "accumulate the raw snapshot" —
    // that would reintroduce the exact I5 bug). Proven here by the
    // absence of any session state: onLlmUsage is the only thing that
    // would have created turn state for 's1', so if the handler skipped
    // correctly, session.idle's flush finds nothing pending and emits
    // no span whatsoever.
    const tracer = makeInMemoryTracer();
    try {
      const { createNioPlugin } = await import('../adapters/opencode-plugin.js');
      const hooks = await createNioPlugin({
        tracerProvider: tracer.provider,
        meterProvider: null,
      })(pluginInput as never);

      await hooks.event!({
        event: {
          type: 'message.updated',
          properties: { info: { sessionID: 's1', role: 'assistant', tokens: { input: 10, output: 5 } } },
        },
      } as never);

      await hooks.event!(
        { event: { type: 'session.idle', properties: { sessionID: 's1' } } } as never,
      );

      assert.equal(tracer.finished().length, 0, 'no message id means no usage call, means no turn state, means no span');
    } finally {
      await tracer.shutdown();
    }
  });
});
