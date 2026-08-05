// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
