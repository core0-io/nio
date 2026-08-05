// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InProcessPluginRuntime, type PreToolResult } from '../adapters/plugin-runtime.js';
import { OpenClawAdapter } from '../adapters/openclaw.js';
import { ensureTurn } from '../scripts/lib/traces-collector.js';
import { makeInMemoryTracer } from './helpers/tracer.js';

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

      await rt.onPostTool('s1', 'call-1', 'exec', { result: 'ok' });
      const spans = tracer.finished();
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
    const prev = process.env.NIO_HOME;
    const nioHome = mkdtempSync(join(tmpdir(), 'nio-pi-plugin-test-'));
    process.env.NIO_HOME = nioHome;
    if (configYaml) writeFileSync(join(nioHome, 'config.yaml'), configYaml);
    try {
      return await fn();
    } finally {
      process.env.NIO_HOME = prev;
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

      const spans = tracer.finished();
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

      const spans = tracer.finished();
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
