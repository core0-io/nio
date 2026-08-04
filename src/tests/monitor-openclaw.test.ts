// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { saveMonitorStore } from '../scripts/lib/monitor-store.js';
import type { CollectorLogsConfig } from '../adapters/config-schema.js';

/** Minimal OpenClaw register API stand-in — captures handlers by name. */
function makeFakeApi() {
  const handlers = new Map<string, (e: unknown, c?: unknown) => Promise<unknown> | unknown>();
  return {
    api: { on(name: string, h: (e: unknown, c?: unknown) => Promise<unknown> | unknown) { handlers.set(name, h); } },
    handlers,
  };
}

/**
 * Drive one `before_tool_call` invocation for `sessionId` and give any
 * telemetry it kicks off a chance to reach the sink.
 *
 * Uses `rm -rf /` — a literal Phase-2 DANGEROUS_COMMAND hit under every
 * protection level (see integration.test.ts's "should DENY rm -rf /") —
 * so the guard reliably takes the deny/block branch inside
 * `before_tool_call`. That branch is deliberately chosen over the
 * before_tool_call + after_tool_call allow-path pair: OpenClaw gates
 * pending-span *creation* (in before_tool_call) and pending-span
 * *export* (in after_tool_call) independently, each re-deriving
 * `isSessionMonitored` itself. For a session that is constantly
 * unmonitored (never armed, not just "checked stale"), after_tool_call's
 * own gate would correctly no-op even if before_tool_call's gate were
 * deleted — because before_tool_call's gate, still intact, would have
 * left no pending span for after_tool_call to find regardless. Two
 * independently-correct gates on the same allow-path data flow mask
 * each other's removal, so a single-handler mutation on that path can
 * never turn this test red — the two checks would need to be deleted
 * together, which isn't what Step 2 asks for.
 *
 * The block path doesn't have that problem: both the pending-span
 * creation and its immediate export (recordPreToolUse then the
 * block-path recordPostToolUse) live inside the same before_tool_call
 * invocation, gated by the exact same `monitored` value computed once
 * at the top of the handler. Deleting that one check flips both
 * halves together, which is exactly the single point of failure Step 2
 * needs to demonstrate.
 */
async function driveToolCall(
  handlers: Map<string, (e: unknown, c?: unknown) => Promise<unknown> | unknown>,
  sessionId: string,
): Promise<void> {
  const before = handlers.get('before_tool_call');
  assert.ok(before, 'before_tool_call handler must be registered');

  await before(
    {
      toolName: 'exec',
      params: { command: 'rm -rf /' },
      toolCallId: `call-${sessionId}`,
      runId: sessionId,
    },
    { sessionKey: sessionId },
  );

  // The block path's recordPostToolUse ends a span through a
  // SimpleSpanProcessor, which kicks off the OTLP HTTP export as a
  // fire-and-forget background promise (see SimpleSpanProcessor.onEnd
  // in @opentelemetry/sdk-trace-base) — nothing before_tool_call awaits
  // settles it. OpenClaw's own forceFlush() call (in flushSessionTurn,
  // reached from agent_end/session_end) is itself gated on the same
  // per-session monitor check, so calling it here wouldn't
  // deterministically wait for a *leaked* export during the Step 2
  // mutation check (that gate stays intact and correctly declines to
  // flush a session it still sees as unarmed). A short settle window on
  // a loopback HTTP request is simpler and catches the leak either way.
  await new Promise((resolve) => setTimeout(resolve, 400));
}

describe('openclaw monitor gating: armed vs unarmed reach the wire', () => {
  let sink: Server;
  let hits: string[] = [];
  let port = 0;

  before(async () => {
    sink = createServer((req, res) => { hits.push(req.url ?? ''); res.writeHead(200); res.end('{}'); });
    await new Promise<void>((r) => sink.listen(0, '127.0.0.1', r));
    port = (sink.address() as { port: number }).port;
  });

  after(async () => { await new Promise<void>((r) => sink.close(() => r())); });

  it('exports for an armed session and stays silent for an unarmed one', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nio-monitor-oc-'));
    writeFileSync(
      join(home, 'config.yaml'),
      `collector:\n  endpoint: "http://127.0.0.1:${port}"\n`,
      'utf-8',
    );
    const logsConfig = { path: join(home, 'audit.jsonl') } as CollectorLogsConfig;
    saveMonitorStore(logsConfig, {
      sessions: { 'oc-armed': { armed_at: Date.now(), cwd: process.cwd() } },
    });

    const prev = process.env['NIO_HOME'];
    process.env['NIO_HOME'] = home;
    try {
      const { registerOpenClawPlugin } = await import('../adapters/openclaw-plugin.js');
      const { api, handlers } = makeFakeApi();
      registerOpenClawPlugin(api);

      hits = [];
      await driveToolCall(handlers, 'oc-armed');
      const armedHits = hits.length;
      assert.ok(armedHits > 0, 'armed session must reach the sink');

      await driveToolCall(handlers, 'oc-unarmed');
      assert.equal(hits.length, armedHits, 'unarmed session must add zero requests');
    } finally {
      if (prev === undefined) delete process.env['NIO_HOME'];
      else process.env['NIO_HOME'] = prev;
    }
  });
});
