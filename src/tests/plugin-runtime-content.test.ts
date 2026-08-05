// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Chat spans and content records, at the runtime layer.
 *
 * `flushSessionTurn` used to call `endTurn(provider, state, cwd)` — three
 * arguments, so no reconstructed calls and no content sink, so no chat
 * spans and no assistant text on the logs signal. These tests pin the
 * accumulate → reconstruct → export path, and the fact that the monitor
 * gate covers it like everything else.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempDir } from './helpers/tmp-dirs.js';
import { makeInMemoryTracer } from './helpers/tracer.js';
import { makeInMemoryLogger } from './helpers/logger.js';
import { InProcessPluginRuntime } from '../adapters/plugin-runtime.js';
import { OpenClawAdapter } from '../adapters/openclaw.js';

/**
 * Arm a session the same way `/nio monitor on` does. Same shape as
 * plugin-runtime-monitor.test.ts's helper — see its docblock.
 */
function armSession(home: string, ...sessionIds: string[]): void {
  const sessions: Record<string, { armed_at: number; cwd: string }> = {};
  for (const id of sessionIds) sessions[id] = { armed_at: Date.now(), cwd: process.cwd() };
  writeFileSync(join(home, 'monitored-sessions.json'), JSON.stringify({ sessions }), 'utf-8');
}

/**
 * One `llm_output` event in the `{ hook, event }` envelope
 * `createOpenClawSource` reads. A flat object with a `hook` key and no
 * `event` key is silently skipped by that source, so the envelope is
 * load-bearing, not decoration.
 */
function llmOutput(model: string, text: string, callId: string): unknown {
  return {
    hook: 'llm_output',
    event: {
      callId,
      provider: 'anthropic',
      model,
      outcome: 'ok',
      durationMs: 10,
      assistantTexts: [text],
      usage: { input: 10, output: 20 },
    },
  };
}

describe('plugin runtime: chat spans reach the wire', () => {
  let home: string;
  beforeEach(() => {
    home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-runtime-content-')));
    process.env['NIO_HOME'] = home;
  });

  it('reconstructs a chat span from accumulated events on an armed session', async () => {
    armSession(home, 'sess-armed');
    const tracer = makeInMemoryTracer();
    const logger = makeInMemoryLogger();
    try {
      const rt = new InProcessPluginRuntime({
        platform: 'openclaw',
        adapter: new OpenClawAdapter(),
        tracerProvider: tracer.provider,
        loggerProvider: logger.provider,
      });

      rt.onSessionStart('sess-armed');
      rt.onUserPrompt('sess-armed', 'do the thing');
      // The daemon's llm_output event — the only place OpenClaw's calls
      // exist.
      rt.recordConversationEvent('sess-armed', llmOutput('oc-test-model', 'done', 'call-1'));
      await rt.onTurnEnd('sess-armed');

      const names = tracer.finished().map((s) => s.name);
      assert.ok(
        names.some((n) => n.startsWith('chat')),
        `the accumulated llm_output event must become a chat span; got ${JSON.stringify(names)}`,
      );

      // The content sink is the other half: without it the chat span is
      // structure with no words in it.
      const bodies = logger.emitted().map((r) => String(r.body));
      assert.ok(
        bodies.some((b) => b.includes('done')),
        `the assistant text must reach the logs signal; got ${JSON.stringify(bodies)}`,
      );
    } finally {
      await tracer.shutdown();
      await logger.shutdown();
    }
  });

  it('emits no chat span for an unmonitored session', async () => {
    const tracer = makeInMemoryTracer();
    try {
      const rt = new InProcessPluginRuntime({
        platform: 'openclaw',
        adapter: new OpenClawAdapter(),
        tracerProvider: tracer.provider,
      });

      rt.onSessionStart('sess-unarmed');
      // The prompt matters: without it no turn state is ever created,
      // and "no state" would suppress the span on its own — the test
      // would then stay green even with the gate ripped out. Driving the
      // same events an armed turn would produce is what makes the
      // assertion about the GATE rather than about an empty runtime.
      rt.onUserPrompt('sess-unarmed', 'do the thing');
      rt.recordConversationEvent('sess-unarmed', llmOutput('m', 'x', 'call-1'));
      await rt.onTurnEnd('sess-unarmed');

      assert.equal(
        tracer.finished().length, 0,
        'an unarmed session must put nothing on the wire, chat spans included',
      );
    } finally {
      await tracer.shutdown();
    }
  });

  it('does not carry a turn\'s calls into the next turn', async () => {
    // Leaking accumulated events across turns is the amplification bug
    // this branch already fixed once on Hermes: every subsequent turn
    // re-exports every earlier turn's chat spans, so a long session ends
    // up billing quadratically for its own history.
    armSession(home, 'sess-two-turns');
    const tracer = makeInMemoryTracer();
    try {
      const rt = new InProcessPluginRuntime({
        platform: 'openclaw',
        adapter: new OpenClawAdapter(),
        tracerProvider: tracer.provider,
      });

      rt.onSessionStart('sess-two-turns');
      rt.onUserPrompt('sess-two-turns', 'first');
      rt.recordConversationEvent('sess-two-turns', llmOutput('m', 'reply one', 'call-1'));
      await rt.onTurnEnd('sess-two-turns');

      const afterFirst = tracer.finished().filter((s) => s.name.startsWith('chat')).length;
      assert.equal(afterFirst, 1, 'sanity: the first turn produced exactly one chat span');

      rt.onUserPrompt('sess-two-turns', 'second');
      rt.recordConversationEvent('sess-two-turns', llmOutput('m', 'reply two', 'call-2'));
      await rt.onTurnEnd('sess-two-turns');

      const total = tracer.finished().filter((s) => s.name.startsWith('chat')).length;
      assert.equal(
        total, 2,
        'the second turn must contribute exactly one more chat span, not replay the first',
      );
    } finally {
      await tracer.shutdown();
    }
  });

  it('drops events accumulated for an unmonitored turn instead of exporting them later', async () => {
    // The mirror image of the leak above: events recorded while the
    // session was unarmed must not sit in memory waiting to be exported
    // by the next turn that happens to be armed.
    const tracer = makeInMemoryTracer();
    try {
      const rt = new InProcessPluginRuntime({
        platform: 'openclaw',
        adapter: new OpenClawAdapter(),
        tracerProvider: tracer.provider,
      });

      rt.onSessionStart('sess-late-arm');
      rt.recordConversationEvent('sess-late-arm', llmOutput('m', 'disarm-era reply', 'call-old'));
      await rt.onTurnEnd('sess-late-arm');

      armSession(home, 'sess-late-arm');
      rt.onUserPrompt('sess-late-arm', 'now armed');
      await rt.onTurnEnd('sess-late-arm');

      const chatSpans = tracer.finished().filter((s) => s.name.startsWith('chat'));
      assert.equal(
        chatSpans.length, 0,
        'a call recorded while unarmed must not be exported by a later armed turn',
      );
    } finally {
      await tracer.shutdown();
    }
  });
});
