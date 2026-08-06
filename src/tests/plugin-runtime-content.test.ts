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

/** One assistant entry of a Pi session JSONL, newline-terminated. */
function piLine(id: string, timestampMs: number, text: string): string {
  return JSON.stringify({
    type: 'message',
    id,
    timestamp: new Date(timestampMs).toISOString(),
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      provider: 'anthropic',
      model: 'pi-replay-model',
      timestamp: timestampMs,
    },
  }) + '\n';
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

      // The content half: without it the chat span is structure with no
      // words in it. A reply this small rides on the span itself under
      // the size-based placement rule (content/span-content.ts) rather
      // than in a log record.
      const chat = tracer.finished().find((s) => s.name.startsWith('chat'));
      assert.equal(
        chat!.attributes['nio.chat.reply'], 'done',
        'the assistant text must reach the chat span',
      );
      logger.emitted();
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

  it('keeps a replay platform\'s transcript path across the turn boundary', async () => {
    // The mirror image of the event-clearing rule above, and it points
    // the OTHER way. Accumulated events are per-TURN and must be dropped
    // at the boundary; a session file is per-SESSION and must survive it,
    // because every later turn replays the same file scoped by its own
    // `turn_start_ms`. Clearing `transcriptPaths` in `flushSessionTurn`
    // alongside `conversationEvents` — the symmetric-looking move — costs
    // every turn after the first its entire chat layer, silently.
    armSession(home, 'sess-replay');
    const sessionFile = join(home, 'session.jsonl');
    const tracer = makeInMemoryTracer();
    try {
      const rt = new InProcessPluginRuntime({
        platform: 'pi',
        adapter: new OpenClawAdapter(),
        tracerProvider: tracer.provider,
        loggerProvider: null,
      });

      rt.onSessionStart('sess-replay');
      rt.setTranscriptPath('sess-replay', sessionFile);

      rt.onUserPrompt('sess-replay', 'first');
      writeFileSync(sessionFile, piLine('m2', Date.now() + 5, 'reply one'), 'utf-8');
      await rt.onTurnEnd('sess-replay');
      assert.equal(
        tracer.finished().filter((s) => s.name.startsWith('chat')).length, 1,
        'sanity: turn one replayed the file',
      );

      // Turn two: same file, one further entry. `callsSince` scopes it to
      // this turn, so the earlier entry must NOT come back.
      rt.onUserPrompt('sess-replay', 'second');
      writeFileSync(
        sessionFile,
        piLine('m2', 1, 'reply one') + piLine('m4', Date.now() + 5, 'reply two'),
        'utf-8',
      );
      await rt.onTurnEnd('sess-replay');

      const chats = tracer.finished().filter((s) => s.name.startsWith('chat'));
      assert.equal(
        chats.length, 2,
        'turn two must still find the session file — exactly one more chat span, not zero and not a replay of turn one',
      );
    } finally {
      await tracer.shutdown();
    }
  });

  it('stops replaying a transcript once it is cleared — by a null path or by a new session', async () => {
    // Two independent ways a stale session file must stop being ours to
    // replay, pinned in one place because each is otherwise masked by
    // the other: `setTranscriptPath(id, null)` (the binding says "this
    // session has no file", e.g. Pi's ephemeral sessions) and
    // `onSessionStart(id)` (a recycled id — a NEW session must not
    // inherit the old one's transcript even if its binding never gets
    // round to handing over a path of its own).
    armSession(home, 'sess-clear');
    const sessionFile = join(home, 'session-clear.jsonl');
    // Far enough ahead to be inside every turn window opened below, so
    // "no chat span" can only mean the path was dropped.
    writeFileSync(sessionFile, piLine('m2', Date.now() + 60_000, 'stale reply'), 'utf-8');
    const tracer = makeInMemoryTracer();
    try {
      const rt = new InProcessPluginRuntime({
        platform: 'pi',
        adapter: new OpenClawAdapter(),
        tracerProvider: tracer.provider,
        loggerProvider: null,
      });
      const chats = () => tracer.finished().filter((s) => s.name.startsWith('chat')).length;

      rt.onSessionStart('sess-clear');
      rt.setTranscriptPath('sess-clear', sessionFile);
      rt.onUserPrompt('sess-clear', 'first');
      await rt.onTurnEnd('sess-clear');
      assert.equal(chats(), 1, 'sanity: the file is replayable while the path is set');

      // (1) A null path clears it, mid-session.
      rt.setTranscriptPath('sess-clear', null);
      rt.onUserPrompt('sess-clear', 'second');
      await rt.onTurnEnd('sess-clear');
      assert.equal(chats(), 1, 'a null path must clear the stored one, not be ignored');

      // (2) And a new session under the same id clears it too, without
      //     the binding having to say anything.
      rt.setTranscriptPath('sess-clear', sessionFile);
      rt.onSessionStart('sess-clear');
      rt.onUserPrompt('sess-clear', 'third');
      await rt.onTurnEnd('sess-clear');
      assert.equal(chats(), 1, 'a recycled session id must not inherit the previous session\'s transcript');
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
