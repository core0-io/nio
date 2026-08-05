// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerOpenClawPlugin } from '../adapters/openclaw-plugin.js';
import { makeInMemoryTracer } from './helpers/tracer.js';
import { trackTempDir } from './helpers/tmp-dirs.js';
import { writeCaptureOnConfig } from './helpers/capture-on.js';

// See helpers/capture-on.ts: capture is off by default, so a file
// asserting span wiring has to turn it on or every assertion below
// collapses into "nothing was emitted". Runs at module scope, before
// the first cached config read.
{
  const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-oc-plugin-tests-')));
  writeCaptureOnConfig(home);
  process.env.NIO_HOME = home;
}

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

/** Orchestrator stub whose raw decision is 'confirm' — the only input that
 *  makes evaluateHook produce the caller-facing 'ask' decision. */
function stubNioConfirm() {
  return () => ({
    orchestrator: {
      async evaluate() {
        return {
          decision: 'confirm',
          risk_level: 'medium',
          scores: { final: 0.5 },
          findings: [{ rule_id: 'TEST_RULE' }],
          explanation: 'characterization confirm verdict',
          phase_stopped: 2,
          diagnostics: [],
        };
      },
    },
  }) as never;
}

/** Isolate NIO_HOME to a fresh tmpdir for the duration of `fn`, then
 *  restore whatever isolate-nio-home.js had already pinned it to. Never
 *  touches the real `~/.nio`. */
async function withIsolatedNioHome<T>(
  fn: (nioHome: string) => Promise<T>,
  configYaml?: string,
): Promise<T> {
  const had = Object.hasOwn(process.env, 'NIO_HOME');
  const prev = process.env.NIO_HOME;
  const nioHome = mkdtempSync(join(tmpdir(), 'nio-oc-plugin-test-'));
  process.env.NIO_HOME = nioHome;
  // Capture on: this file asserts span/audit wiring, not the monitor
  // gate, and the gate is closed by default (see helpers/capture-on.ts).
  writeCaptureOnConfig(nioHome, configYaml);
  try {
    return await fn(nioHome);
  } finally {
    // Restore an originally-unset variable by DELETING it. Assigning
    // `undefined` back into process.env stores the literal string
    // "undefined", which later makes nioDir() resolve to a relative
    // `undefined/` directory and write config + audit files into cwd.
    if (had) process.env.NIO_HOME = prev;
    else delete process.env.NIO_HOME;
  }
}

function readAuditRows(nioHome: string): Array<{
  lifecycle_type?: string;
  details?: Record<string, unknown>;
}> {
  const raw = readFileSync(join(nioHome, 'audit.jsonl'), 'utf-8');
  return raw
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as { lifecycle_type?: string; details?: Record<string, unknown> });
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
      // Turn close now ALSO reconstructs a chat span from the
      // accumulated llm_output event, so a bare `spans.length === 1` no
      // longer describes this path. What it pinned still holds: exactly
      // one turn root, carrying the prompt and the usage.
      const turnRoots = spans.filter((s) => s.name.startsWith('invoke_agent'));
      assert.equal(turnRoots.length, 1);
      assert.equal(turnRoots[0]!.attributes['nio.turn.user_prompt'], 'hello there');
      assert.equal(turnRoots[0]!.attributes['gen_ai.usage.input_tokens'], 10);
      assert.equal(
        spans.filter((s) => s.name.startsWith('chat')).length, 1,
        'and the llm_output event the plugin accumulated becomes one chat span',
      );
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

// Fix round 1: closes the coverage gap that let three drifts (fabricated
// gen_ai.tool.call.id, lost run_id on sub-agent audit rows, 'ask' leaking
// onto span attributes) slip past the spans-and-shapes-only suite above.
describe('OpenClaw plugin — fix round 1 regressions', () => {
  it('sub-agent lifecycle audit rows carry BOTH subagent_id and run_id', async () => {
    await withIsolatedNioHome(async (nioHome) => {
      const api = fakeApi();
      registerOpenClawPlugin(api as never, {
        nioFactory: stubNio('allow'), tracerProvider: null, meterProvider: null,
      });
      await api.handlers.get('subagent_spawning')!(
        { subagentId: 'sub-42', runId: 'run-99' }, CTX,
      );
      await api.handlers.get('subagent_ended')!(
        { subagentId: 'sub-42', runId: 'run-99' }, CTX,
      );

      const rows = readAuditRows(nioHome).filter(
        r => r.lifecycle_type === 'subagent_spawning' || r.lifecycle_type === 'subagent_ended',
      );
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.equal(row.details?.['subagent_id'], 'sub-42');
        assert.equal(row.details?.['run_id'], 'run-99');
      }
    });
  });

  it('confirm_action "ask" folds the span decision to confirm_allowed, not "ask"', async () => {
    await withIsolatedNioHome(async () => {
      const tracer = makeInMemoryTracer();
      try {
        const api = fakeApi();
        registerOpenClawPlugin(api as never, {
          nioFactory: stubNioConfirm(),
          tracerProvider: tracer.provider,
          meterProvider: null,
        });
        const out = await api.handlers.get('before_tool_call')!(
          { toolName: 'exec', params: { command: 'curl x' }, toolCallId: 'c1' }, CTX,
        );
        // No interactive channel: 'ask' folds to allow at the block decision.
        assert.equal(out, undefined);

        await api.handlers.get('after_tool_call')!(
          { toolName: 'exec', toolCallId: 'c1', result: 'ok' }, CTX,
        );
        const spans = tracer.finished();
        assert.equal(spans.length, 1);
        assert.equal(spans[0]!.attributes['nio.guard.decision'], 'confirm_allowed');
      } finally {
        await tracer.shutdown();
      }
    }, 'guard:\n  confirm_action: ask\n');
  });

  it('gen_ai.tool.call.id is present only when the event supplies a real toolCallId', async () => {
    const tracer = makeInMemoryTracer();
    try {
      const api = fakeApi();
      registerOpenClawPlugin(api as never, {
        nioFactory: stubNio('allow'),
        tracerProvider: tracer.provider,
        meterProvider: null,
      });

      // No toolCallId on the event → must NOT fabricate one from the tool name.
      await api.handlers.get('before_tool_call')!(
        { toolName: 'exec', params: { command: 'ls' } }, CTX,
      );
      await api.handlers.get('after_tool_call')!(
        { toolName: 'exec', result: 'ok' }, CTX,
      );

      // Real toolCallId on the event → carried through verbatim.
      await api.handlers.get('before_tool_call')!(
        { toolName: 'exec', params: { command: 'ls' }, toolCallId: 'call-77' }, CTX,
      );
      await api.handlers.get('after_tool_call')!(
        { toolName: 'exec', toolCallId: 'call-77', result: 'ok' }, CTX,
      );

      const spans = tracer.finished();
      assert.equal(spans.length, 2);
      assert.equal(spans[0]!.attributes['gen_ai.tool.call.id'], undefined);
      assert.equal(spans[1]!.attributes['gen_ai.tool.call.id'], 'call-77');
    } finally {
      await tracer.shutdown();
    }
  });
});
