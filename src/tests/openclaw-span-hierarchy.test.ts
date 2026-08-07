// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Platform exception, pinned: on OpenClaw a tool span is a SIBLING of
 * the `chat` span, exported eagerly at `after_tool_call`.
 *
 * Every other platform parks a finished tool span in
 * `traces-state-store-<session>.json` and emits the whole tree at turn
 * close, nesting each tool under the `chat` call that issued it.
 * OpenClaw cannot: `createOpenClawSource` never produces a `tool_use`
 * block, and all its calls are `timing: 'synthetic'`, so both of
 * `buildSpanTree`'s attribution channels are unavailable and every tool
 * span lands on the turn root no matter WHEN it is emitted. That is why
 * the plugin keeps its eager per-tool export — deferring would trade
 * crash-resilience (OpenClaw's state is in memory; nothing on disk for
 * the recovery path to replay) for no structural gain. See
 * COLLECTOR-SIGNALS.md § "Platform exception · on OpenClaw, chat and
 * execute_tool are siblings".
 *
 * The exception was documented but had no guard, so nothing stopped
 * someone "unifying" OpenClaw onto the deferred path and silently
 * dropping that crash-resilience.
 *
 * ── Why this test is not vacuous ──────────────────────────────────────
 *
 * An earlier OpenClaw guard test on this branch was evergreen because
 * its input carried no tool-call events at all: no implementation could
 * produce a tool span from it, so the test pinned "nothing was
 * fabricated" rather than "the eager path exists". This one drives a
 * real `before_tool_call` + `after_tool_call` pair and asserts on spans
 * that actually reach an OTLP sink. Both properties were mutation-
 * checked (see the deferred-batch-3 report):
 *   - `after_tool_call` switched to the deferred path → the eager-export
 *     assertions go red;
 *   - `recordPostToolUse`'s parent switched off the turn root → the
 *     parentage assertions go red.
 *
 * Assertions run against the raw OTLP/HTTP JSON body, the same technique
 * monitor-openclaw.test.ts uses: the exporter sends uncompressed JSON,
 * so `spanId` / `parentSpanId` / `traceId` are readable without a
 * protobuf decoder.
 */

import { describe, it, before as beforeHook, after as afterHook } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { saveMonitorStore } from '../scripts/lib/monitor-store.js';
import type { CollectorLogsConfig } from '../adapters/config-schema.js';
import { trackTempDir } from './helpers/tmp-dirs.js';
import { closeOtlpSink } from './helpers/otlp-sink.js';

interface WireSpan {
  name: string;
  spanId: string;
  parentSpanId?: string;
  traceId: string;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeFakeApi() {
  const handlers = new Map<string, (e: unknown, c?: unknown) => Promise<unknown> | unknown>();
  return {
    api: { on(name: string, h: (e: unknown, c?: unknown) => Promise<unknown> | unknown) { handlers.set(name, h); } },
    handlers,
  };
}

describe('openclaw span hierarchy: tool spans are eager siblings of chat, not deferred children', () => {
  let sink: Server;
  const bodies: string[] = [];
  let port = 0;

  beforeHook(async () => {
    sink = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.url === '/v1/traces') bodies.push(Buffer.concat(chunks).toString('utf-8'));
        res.writeHead(200);
        res.end('{}');
      });
    });
    await new Promise<void>((r) => sink.listen(0, '127.0.0.1', r));
    port = (sink.address() as { port: number }).port;
  });

  afterHook(async () => { await closeOtlpSink(sink); });

  /** Every span the sink has seen so far, flattened out of the OTLP JSON. */
  function spans(): WireSpan[] {
    const out: WireSpan[] = [];
    for (const body of bodies) {
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { continue; }
      const rs = (parsed as { resourceSpans?: unknown[] }).resourceSpans ?? [];
      for (const r of rs) {
        for (const ss of (r as { scopeSpans?: unknown[] }).scopeSpans ?? []) {
          for (const s of (ss as { spans?: WireSpan[] }).spans ?? []) {
            out.push(s);
          }
        }
      }
    }
    return out;
  }

  const toolSpans = () => spans().filter((s) => s.name.startsWith('execute_tool'));
  const chatSpans = () => spans().filter((s) => s.name.startsWith('chat'));

  it('exports the tool span at after_tool_call, parented to the turn root, and never re-emits it at turn close', async () => {
    const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-oc-hierarchy-')));
    writeFileSync(
      join(home, 'config.yaml'),
      `collector:\n  endpoint: "http://127.0.0.1:${port}"\n`,
      'utf-8',
    );
    const logsConfig = { path: join(home, 'audit.jsonl') } as CollectorLogsConfig;
    const sessionId = 'oc-hierarchy-1';

    const prev = process.env['NIO_HOME'];
    process.env['NIO_HOME'] = home;
    try {
      saveMonitorStore(logsConfig, {
        sessions: { [sessionId]: { armed_at: Date.now(), cwd: process.cwd() } },
      });

      const { registerOpenClawPlugin } = await import('../adapters/openclaw-plugin.js');
      const { api, handlers } = makeFakeApi();
      registerOpenClawPlugin(api);

      const before = handlers.get('before_tool_call');
      const after = handlers.get('after_tool_call');
      const llmOutput = handlers.get('llm_output');
      const sessionEnd = handlers.get('session_end');
      assert.ok(before, 'before_tool_call handler must be registered');
      assert.ok(after, 'after_tool_call handler must be registered');
      assert.ok(llmOutput, 'llm_output handler must be registered');
      assert.ok(sessionEnd, 'session_end handler must be registered');

      // An LLM call happens first, so the turn genuinely HAS a chat span
      // to nest under. Without this the test would prove nothing: a
      // sibling and a missing parent look identical.
      await llmOutput(
        {
          runId: sessionId, callId: 'call-oc-1', provider: 'anthropic',
          model: 'claude-placeholder', outcome: 'success', durationMs: 900,
          assistantTexts: ['placeholder reply'],
        },
        { sessionKey: sessionId },
      );

      const toolCallId = 'call-oc-tool-1';
      await before(
        { toolName: 'exec', params: { command: 'echo hello' }, toolCallId, runId: sessionId },
        { sessionKey: sessionId },
      );
      await after(
        {
          toolName: 'exec', params: { command: 'echo hello' }, toolCallId, runId: sessionId,
          result: 'hello\n', durationMs: 5,
        },
        { sessionKey: sessionId },
      );
      await wait(500);

      // ── Property 1: EAGER. The tool span is already on the wire, and
      // the turn has not closed yet — nothing has emitted a chat span or
      // a turn root. On the deferred platforms this list would be empty
      // at this point.
      const eagerTools = toolSpans();
      assert.equal(
        eagerTools.length, 1,
        'the tool span must reach the exporter at after_tool_call, not wait for the turn to close — ' +
        'OpenClaw keeps its state in memory, so a deferred span is simply lost if the daemon dies',
      );
      assert.equal(
        chatSpans().length, 0,
        'no chat span can exist yet — it is reconstructed at turn close; if one is here the ' +
        'sequencing assumption behind this test has changed',
      );

      const tool = eagerTools[0]!;
      assert.equal(
        tool.parentSpanId, tool.traceId.slice(0, 16),
        'the tool span must be parented to the synthetic turn-root span id (traceId.slice(0,16))',
      );

      // ── Property 2: still a SIBLING once the chat span exists.
      await sessionEnd({}, { sessionKey: sessionId });
      await wait(500);

      const chats = chatSpans();
      assert.equal(chats.length, 1, 'turn close must reconstruct exactly one chat span from the llm_output event');

      const toolsAfter = toolSpans();
      assert.equal(
        toolsAfter.length, 1,
        'the eagerly-exported tool span must NOT be re-emitted by endTurn — deferred_spans is ' +
        'empty on OpenClaw precisely because recordPostToolUse already drained it',
      );
      assert.equal(
        toolsAfter[0]!.spanId, tool.spanId,
        'and it must be the same span, not a duplicate with a fresh id',
      );
      assert.notEqual(
        toolsAfter[0]!.parentSpanId, chats[0]!.spanId,
        'PLATFORM EXCEPTION: on OpenClaw the tool span is a sibling of the chat span, never its ' +
        'child — createOpenClawSource emits no tool_use block and all its calls are synthetic, ' +
        'so buildSpanTree has no attribution channel. If this ever becomes false, ' +
        'COLLECTOR-SIGNALS.md\'s platform-exception section is stale.',
      );
      assert.equal(
        toolsAfter[0]!.parentSpanId, chats[0]!.parentSpanId,
        'sibling means literally that: tool and chat share the turn root as their parent',
      );
    } finally {
      if (prev === undefined) delete process.env['NIO_HOME'];
      else process.env['NIO_HOME'] = prev;
    }
  });
});
