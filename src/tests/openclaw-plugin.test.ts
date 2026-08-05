// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerOpenClawPlugin } from '../adapters/openclaw-plugin.js';
import { makeInMemoryTracer } from './helpers/tracer.js';

/** Minimal stand-in for OpenClaw's plugin register API. */
function fakeApi() {
  const handlers = new Map<string, (e: unknown, ctx: unknown) => Promise<unknown>>();
  const tools: Array<{ name: string }> = [];
  return {
    handlers,
    tools,
    on(name: string, fn: (e: unknown, ctx: unknown) => Promise<unknown>) {
      handlers.set(name, fn);
    },
    registerTool(def: { name: string }) { tools.push(def); },
  };
}

function stubNio(verdict: 'allow' | 'deny') {
  return () => ({
    orchestrator: {
      async evaluate() {
        return {
          decision: verdict,
          risk_level: verdict === 'allow' ? 'low' : 'high',
          scores: { final: verdict === 'allow' ? 0 : 0.9 },
          findings: verdict === 'allow' ? [] : [{ rule_id: 'TEST_RULE' }],
          explanation: 'characterization verdict',
          phase_stopped: 2,
          diagnostics: [],
        };
      },
    },
  }) as never;
}

const CTX = { sessionKey: 'oc-session-1' };

describe('OpenClaw plugin — characterization', () => {
  it('subscribes to every event the integration relies on', () => {
    const api = fakeApi();
    registerOpenClawPlugin(api as never, {
      nioFactory: stubNio('allow'), tracerProvider: null, meterProvider: null,
    });
    for (const name of [
      'before_tool_call', 'after_tool_call', 'subagent_spawning', 'subagent_ended',
      'before_agent_reply', 'llm_output', 'session_start', 'session_end', 'agent_end',
    ]) {
      assert.ok(api.handlers.has(name), `missing handler: ${name}`);
    }
    assert.deepEqual(api.tools.map(t => t.name), ['nio_command']);
  });

  it('allows a benign call and returns undefined', async () => {
    const api = fakeApi();
    registerOpenClawPlugin(api as never, {
      nioFactory: stubNio('allow'), tracerProvider: null, meterProvider: null,
    });
    const out = await api.handlers.get('before_tool_call')!(
      { toolName: 'exec', params: { command: 'ls' }, toolCallId: 'c1' }, CTX,
    );
    assert.equal(out, undefined);
  });

  it('blocks with { block, blockReason } — NOT { reason }', async () => {
    // OpenClaw reads `blockReason`. Renaming this key silently disables
    // blocking on the whole platform, so pin it explicitly.
    const api = fakeApi();
    registerOpenClawPlugin(api as never, {
      nioFactory: stubNio('deny'), tracerProvider: null, meterProvider: null,
    });
    const out = await api.handlers.get('before_tool_call')!(
      { toolName: 'exec', params: { command: 'rm -rf /' }, toolCallId: 'c1' }, CTX,
    ) as { block?: boolean; blockReason?: string; reason?: string };

    assert.equal(out.block, true);
    assert.equal(typeof out.blockReason, 'string');
    assert.ok(out.blockReason!.length > 0);
    assert.equal(out.reason, undefined, 'must not switch to the Pi-style `reason` key');
  });

  it('fails open: a malformed event never blocks', async () => {
    const api = fakeApi();
    registerOpenClawPlugin(api as never, {
      nioFactory: stubNio('deny'), tracerProvider: null, meterProvider: null,
    });
    const out = await api.handlers.get('before_tool_call')!(null, null);
    assert.equal(out, undefined);
  });

  it('emits one tool span carrying the guard decision', async () => {
    const tracer = makeInMemoryTracer();
    try {
      const api = fakeApi();
      registerOpenClawPlugin(api as never, {
        nioFactory: stubNio('allow'),
        tracerProvider: tracer.provider,
        meterProvider: null,
      });
      await api.handlers.get('before_tool_call')!(
        { toolName: 'exec', params: { command: 'ls' }, toolCallId: 'c1' }, CTX,
      );
      assert.equal(tracer.finished().length, 0);

      await api.handlers.get('after_tool_call')!(
        { toolName: 'exec', toolCallId: 'c1', result: 'ok' }, CTX,
      );
      const spans = tracer.finished();
      assert.equal(spans.length, 1);
      assert.equal(spans[0]!.attributes['nio.guard.decision'], 'allow');
    } finally {
      await tracer.shutdown();
    }
  });

  it('emits the orphan span when a call is blocked', async () => {
    const tracer = makeInMemoryTracer();
    try {
      const api = fakeApi();
      registerOpenClawPlugin(api as never, {
        nioFactory: stubNio('deny'),
        tracerProvider: tracer.provider,
        meterProvider: null,
      });
      await api.handlers.get('before_tool_call')!(
        { toolName: 'exec', params: { command: 'rm -rf /' }, toolCallId: 'c1' }, CTX,
      );
      const spans = tracer.finished();
      assert.equal(spans.length, 1, 'after_tool_call never fires for a blocked call');
      assert.equal(spans[0]!.attributes['nio.guard.decision'], 'deny');
    } finally {
      await tracer.shutdown();
    }
  });

  it('agent_end emits the turn root span with prompt and usage', async () => {
    const tracer = makeInMemoryTracer();
    try {
      const api = fakeApi();
      registerOpenClawPlugin(api as never, {
        nioFactory: stubNio('allow'),
        tracerProvider: tracer.provider,
        meterProvider: null,
      });
      await api.handlers.get('before_agent_reply')!({ cleanedBody: 'hello there' }, CTX);
      await api.handlers.get('llm_output')!(
        { assistantTexts: ['hi'], usage: { input: 10, output: 5 } }, CTX,
      );
      await api.handlers.get('agent_end')!({}, CTX);

      const spans = tracer.finished();
      assert.equal(spans.length, 1);
      assert.equal(spans[0]!.attributes['nio.turn.user_prompt'], 'hello there');
      assert.equal(spans[0]!.attributes['gen_ai.usage.input_tokens'], 10);
    } finally {
      await tracer.shutdown();
    }
  });

  it('subagent_spawning + subagent_ended emit one task span', async () => {
    const tracer = makeInMemoryTracer();
    try {
      const api = fakeApi();
      registerOpenClawPlugin(api as never, {
        nioFactory: stubNio('allow'),
        tracerProvider: tracer.provider,
        meterProvider: null,
      });
      await api.handlers.get('subagent_spawning')!({ subagentId: 'sub-1' }, CTX);
      assert.equal(tracer.finished().length, 0);
      await api.handlers.get('subagent_ended')!({ subagentId: 'sub-1' }, CTX);
      assert.equal(tracer.finished().length, 1);
    } finally {
      await tracer.shutdown();
    }
  });

  it('the nio_command tool returns dispatcher text', async () => {
    const api = fakeApi();
    registerOpenClawPlugin(api as never, {
      nioFactory: stubNio('allow'), tracerProvider: null, meterProvider: null,
    });
    const tool = api.tools[0] as unknown as {
      execute(id: string, p: Record<string, string>): Promise<{ content: Array<{ text: string }> }>;
    };
    const out = await tool.execute('id-1', {
      command: '', commandName: 'nio', skillName: 'nio',
    });
    assert.equal(typeof out.content[0]!.text, 'string');
    assert.ok(out.content[0]!.text.length > 0);
  });
});
