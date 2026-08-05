// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it, before as beforeHook, after as afterHook } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { saveMonitorStore } from '../scripts/lib/monitor-store.js';
import type { CollectorLogsConfig } from '../adapters/config-schema.js';
import { trackTempDir } from './helpers/tmp-dirs.js';

/** Minimal OpenClaw register API stand-in — captures handlers by name. */
function makeFakeApi() {
  const handlers = new Map<string, (e: unknown, c?: unknown) => Promise<unknown> | unknown>();
  return {
    api: { on(name: string, h: (e: unknown, c?: unknown) => Promise<unknown> | unknown) { handlers.set(name, h); } },
    handlers,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('openclaw monitor gating: armed vs unarmed reach the wire', () => {
  let sink: Server;
  let records: { url: string; body: Buffer }[] = [];
  let port = 0;

  // Counting only `/v1/traces` requests, not raw request count, matters
  // for reasons that go beyond style: `createMeterProvider` wires a
  // `PeriodicExportingMetricReader` with `exportIntervalMillis: 1000`
  // (metrics-collector.ts). The instant any armed-session call records a
  // counter, that reader starts firing `/v1/metrics` once a second in
  // the background — unconditionally, independent of session or
  // monitor state — for as long as this test file's process lives.
  // These tests' own armed-then-unarmed sequences run close enough to
  // that 1s boundary (guard evaluation + settle waits land in the
  // 900-1050ms range) that a slow CI tick can push a periodic export
  // into the unarmed observation window and fail a *correct*
  // implementation. Traces have no such background timer — a
  // `/v1/traces` request only happens when something explicitly ends a
  // span — so counting only those makes the assertions immune to that
  // drift without weakening what they pin.
  const traceRecords = () => records.filter((r) => r.url === '/v1/traces');
  const traceHits = () => traceRecords().length;

  // The OTLP HTTP trace exporter used here (@opentelemetry/exporter-
  // trace-otlp-http via createTracerProvider) sends plain, uncompressed
  // JSON bodies (verified empirically against this sink: Content-Type
  // application/json, no Content-Encoding) — not protobuf. That makes a
  // raw substring search over the request body a reliable way to assert
  // on span *content*, not just request count, without pulling in a
  // protobuf decoder.
  const traceBodiesContain = (needle: string): boolean => {
    const n = Buffer.from(needle, 'utf-8');
    return traceRecords().some((r) => r.body.includes(n));
  };

  beforeHook(async () => {
    sink = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        records.push({ url: req.url ?? '', body: Buffer.concat(chunks) });
        res.writeHead(200);
        res.end('{}');
      });
    });
    await new Promise<void>((r) => sink.listen(0, '127.0.0.1', r));
    port = (sink.address() as { port: number }).port;
  });

  afterHook(async () => { await new Promise<void>((r) => sink.close(() => r())); });

  /**
   * Register a fresh plugin instance against a fresh NIO_HOME pointed at
   * the shared sink, running `body` with NIO_HOME set and always
   * restoring it afterward. Each test gets its own home (and therefore
   * its own monitor store + its own tracer/meter/logger providers) —
   * only the module-level `sessionState` / `pendingGuardAttrs` maps in
   * openclaw-plugin.ts are process-global, so callers must use session
   * ids unique to their own test.
   */
  async function withPlugin(
    body: (handlers: Map<string, (e: unknown, c?: unknown) => Promise<unknown> | unknown>, logsConfig: CollectorLogsConfig) => Promise<void>,
  ): Promise<void> {
    const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-monitor-oc-')));
    writeFileSync(
      join(home, 'config.yaml'),
      `collector:\n  endpoint: "http://127.0.0.1:${port}"\n`,
      'utf-8',
    );
    const logsConfig = { path: join(home, 'audit.jsonl') } as CollectorLogsConfig;

    const prev = process.env['NIO_HOME'];
    process.env['NIO_HOME'] = home;
    try {
      const { registerOpenClawPlugin } = await import('../adapters/openclaw-plugin.js');
      const { api, handlers } = makeFakeApi();
      registerOpenClawPlugin(api);
      await body(handlers, logsConfig);
    } finally {
      if (prev === undefined) delete process.env['NIO_HOME'];
      else process.env['NIO_HOME'] = prev;
    }
  }

  /**
   * Drive one `before_tool_call` invocation for `sessionId`, using
   * `rm -rf /` — a literal Phase-2 DANGEROUS_COMMAND hit under every
   * protection level (see integration.test.ts's "should DENY rm -rf /")
   * — so the guard reliably takes the deny/block branch.
   *
   * Deliberately chosen over an allow-path before_tool_call +
   * after_tool_call pair: before_tool_call gates pending-span *creation*
   * and after_tool_call independently gates pending-span *export*, each
   * re-deriving `isSessionMonitored` itself. For a session that is
   * constantly unmonitored (never armed, not "checked stale"), deleting
   * *either* gate alone — with the other correctly left in place — is
   * unobservable on the trace signal: whichever gate stays intact
   * blocks the leak regardless of the other's mutation. That is
   * *correct*, defense-in-depth behaviour, but it also means neither
   * single-handler deletion is provably load-bearing via that pairing
   * on the trace signal alone (see task-7-report.md for the empirical
   * mutation results on driveAllowedToolCall below).
   *
   * The block path doesn't have that problem: both the pending-span
   * creation and its immediate export (recordPreToolUse then the
   * block-path recordPostToolUse) live inside the same before_tool_call
   * invocation, gated by the exact same `monitored` value computed once
   * at the top of the handler. Deleting that one check flips both
   * halves together — a genuine single point of failure.
   */
  async function driveBlockedToolCall(
    handlers: Map<string, (e: unknown, c?: unknown) => Promise<unknown> | unknown>,
    sessionId: string,
  ): Promise<void> {
    const before = handlers.get('before_tool_call');
    assert.ok(before, 'before_tool_call handler must be registered');

    await before(
      {
        toolName: 'exec',
        params: { command: 'rm -rf /' },
        toolCallId: `call-block-${sessionId}`,
        runId: sessionId,
      },
      { sessionKey: sessionId },
    );

    // recordPostToolUse ends the span through a SimpleSpanProcessor,
    // whose onEnd() kicks off the OTLP HTTP export as a fire-and-forget
    // background promise (see SimpleSpanProcessor.onEnd in
    // @opentelemetry/sdk-trace-base) — nothing before_tool_call awaits
    // settles it, and forceFlush() (reached via agent_end/session_end)
    // is itself gated on the same per-session check, so it can't be
    // used to deterministically await a *leaked* export during a
    // mutation check. A short settle window on a loopback HTTP request
    // is simpler and catches the leak either way.
    await wait(400);
  }

  /**
   * Drive one full before_tool_call + after_tool_call cycle (the allow
   * path) for `sessionId`, using a benign command the guard allows.
   * Mirrors the original task-7-brief.md skeleton.
   *
   * IMPORTANT — what this test does and does not pin: empirically (see
   * task-7-report.md), deleting *either* before_tool_call's or
   * after_tool_call's `isSessionMonitored` check alone, with the other
   * left intact, does NOT turn this test red. That's not a bug in the
   * test's wiring — it's the same defense-in-depth masking described on
   * driveBlockedToolCall above, empirically confirmed for this exact
   * pairing: before_tool_call's own gate blocking pending-span creation
   * means after_tool_call's `if (state)` check finds nothing regardless
   * of its own gate's presence, and vice versa. This test still has
   * value as an end-to-end regression check of the allow path (armed
   * exports, unarmed doesn't, across two real handler calls) — it just
   * doesn't independently prove either gate necessary the way
   * driveBlockedToolCall's single-handler design does. Counting
   * `/v1/metrics` in addition to `/v1/traces` here would restore
   * mutation-detection for both gates (before_tool_call's own metrics
   * calls are unconditional-once-mutated, independent of `state`), but
   * was rejected: metrics have a live `PeriodicExportingMetricReader`
   * background timer per MeterProvider (metrics-collector.ts,
   * `exportIntervalMillis: 1000`) that starts as soon as any test in
   * this file records a counter, and keeps ticking for the rest of the
   * process — so counting metrics here would make this test's pass/fail
   * depend on unrelated background noise from whichever other tests
   * happened to run earlier in the same file. Traces have no such timer.
   */
  async function driveAllowedToolCall(
    handlers: Map<string, (e: unknown, c?: unknown) => Promise<unknown> | unknown>,
    sessionId: string,
  ): Promise<void> {
    const before = handlers.get('before_tool_call');
    const after = handlers.get('after_tool_call');
    assert.ok(before && after, 'before_tool_call/after_tool_call handlers must be registered');

    const toolCallId = `call-allow-${sessionId}`;
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

    await wait(400);
  }

  it('block path: exports for an armed session and stays silent for an unarmed one', async () => {
    await withPlugin(async (handlers, logsConfig) => {
      saveMonitorStore(logsConfig, {
        sessions: { 'oc-block-armed': { armed_at: Date.now(), cwd: process.cwd() } },
      });

      records = [];
      await driveBlockedToolCall(handlers, 'oc-block-armed');
      const armedHits = traceHits();
      assert.ok(armedHits > 0, 'armed session must reach the sink');

      await driveBlockedToolCall(handlers, 'oc-block-unarmed');
      assert.equal(traceHits(), armedHits, 'unarmed session must add zero trace requests');
    });
  });

  // End-to-end regression check for the allow path (see the caveat in
  // driveAllowedToolCall's docblock: unlike the block-path test, this
  // one does not independently pin either individual gate under
  // mutation — both before_tool_call's and after_tool_call's checks
  // mask each other's removal on the trace signal).
  it('allow path: exports for an armed session and stays silent for an unarmed one', async () => {
    await withPlugin(async (handlers, logsConfig) => {
      saveMonitorStore(logsConfig, {
        sessions: { 'oc-allow-armed': { armed_at: Date.now(), cwd: process.cwd() } },
      });

      records = [];
      await driveAllowedToolCall(handlers, 'oc-allow-armed');
      const armedHits = traceHits();
      assert.ok(armedHits > 0, 'armed session must reach the sink');

      await driveAllowedToolCall(handlers, 'oc-allow-unarmed');
      assert.equal(traceHits(), armedHits, 'unarmed session must add zero trace requests');
    });
  });

  it('does not re-export state accumulated before a disarm once the session is re-armed', async () => {
    await withPlugin(async (handlers, logsConfig) => {
      const sessionId = 'oc-leak-session';
      const beforeAgentReply = handlers.get('before_agent_reply');
      const beforeToolCall = handlers.get('before_tool_call');
      const sessionEnd = handlers.get('session_end');
      const agentEnd = handlers.get('agent_end');
      assert.ok(
        beforeAgentReply && beforeToolCall && sessionEnd && agentEnd,
        'before_agent_reply/before_tool_call/session_end/agent_end handlers must be registered',
      );

      // 1. Arm.
      saveMonitorStore(logsConfig, {
        sessions: { [sessionId]: { armed_at: Date.now(), cwd: process.cwd() } },
      });

      records = [];

      // 2. Accumulate real state while armed: a captured user prompt
      // (turn_attributes) and an open tool-call span that's never
      // closed by after_tool_call — representing a mid-flight call at
      // the moment of disarm.
      await beforeAgentReply({ cleanedBody: 'nio leak canary prompt' }, { sessionKey: sessionId });
      await beforeToolCall(
        { toolName: 'exec', params: { command: 'echo canary' }, toolCallId: `call-${sessionId}`, runId: sessionId },
        { sessionKey: sessionId },
      );

      // 3. Disarm — remove the session from the store entirely.
      saveMonitorStore(logsConfig, { sessions: {} });

      // 4. A lifecycle boundary fires while unarmed. Pre-fix, this left
      // sessionState/pendingGuardAttrs untouched (the whole handler,
      // including cleanup, lived behind the `!monitored` early return);
      // post-fix, cleanup must still happen even though nothing exports.
      await sessionEnd({}, { sessionKey: sessionId });

      // 5. Re-arm.
      saveMonitorStore(logsConfig, {
        sessions: { [sessionId]: { armed_at: Date.now(), cwd: process.cwd() } },
      });

      // 6. A fresh boundary event. If step 4 didn't clear the old
      // state, this exports the disarm-era canary data now.
      await agentEnd({}, { sessionKey: sessionId });
      await wait(400);

      assert.equal(
        traceHits(), 0,
        'state accumulated before a disarm must not be exported after the session is re-armed',
      );
    });
  });

  it('does not merge a stale guard-decision left by a disarmed after_tool_call into a later export', async () => {
    // Pins the (b) fix from the second review round: after_tool_call
    // now reads-and-deletes its pendingGuardAttrs entry *before* the
    // `if (!monitored) return;` check, not after. The bug this guards
    // against is invisible to a hit-count assertion (pendingGuardAttrs
    // is a passive side-channel Map — leaving a stale entry there
    // doesn't itself cause an extra export), so this test inspects
    // exported span *content* instead of just counting requests: it
    // reuses the same span key across a disarm/re-arm boundary so a
    // leaked entry would surface as an attribute on a later, legitimate
    // export of that same span.
    await withPlugin(async (handlers, logsConfig) => {
      const sessionId = 'oc-guard-attr-leak';
      const beforeToolCall = handlers.get('before_tool_call');
      const afterToolCall = handlers.get('after_tool_call');
      assert.ok(beforeToolCall && afterToolCall, 'before_tool_call/after_tool_call handlers must be registered');
      const toolCallId = `call-${sessionId}`;

      // 1. Arm, then open a span. The guard allows 'echo canary', so
      // before_tool_call stashes real guard-decision attrs
      // (nio.guard.decision=allow, etc.) into pendingGuardAttrs keyed
      // by `${sessionId}:${toolCallId}` — see the "Allow / confirm_allowed"
      // comment in before_tool_call.
      saveMonitorStore(logsConfig, {
        sessions: { [sessionId]: { armed_at: Date.now(), cwd: process.cwd() } },
      });
      records = [];
      await beforeToolCall(
        { toolName: 'exec', params: { command: 'echo canary' }, toolCallId, runId: sessionId },
        { sessionKey: sessionId },
      );

      // 2. Disarm.
      saveMonitorStore(logsConfig, { sessions: {} });

      // 3. "Normal" wind-down attempt for the same call, but the
      // session is unarmed now. recordPostToolUse never runs either
      // way (gated on `monitored`), so the span stays pending in
      // sessionState regardless of this fix — only whether
      // pendingGuardAttrs[fullKey] survives this call differs:
      // pre-fix, the early return skipped the get+delete entirely;
      // post-fix, they run unconditionally before the return.
      await afterToolCall(
        { toolName: 'exec', params: { command: 'echo canary' }, toolCallId, runId: sessionId, result: 'canary\n', durationMs: 3 },
        { sessionKey: sessionId },
      );

      // 4. Re-arm the *same* session — no boundary event (session_end/
      // agent_end/session_start) runs in between, so clearSessionState
      // never gets a chance to sweep up whatever step 3 left behind.
      saveMonitorStore(logsConfig, {
        sessions: { [sessionId]: { armed_at: Date.now(), cwd: process.cwd() } },
      });

      // 5. Close the same still-pending span for real. This is the
      // read site: `pendingGuardAttrs.get(fullKey) ?? {}` decides what
      // merges into the exported span's attributes.
      await afterToolCall(
        { toolName: 'exec', params: { command: 'echo canary' }, toolCallId, runId: sessionId, result: 'canary\n', durationMs: 3 },
        { sessionKey: sessionId },
      );
      await wait(400);

      assert.equal(traceHits(), 1, 'exactly one span (from step 5) should have been exported');
      assert.equal(
        traceBodiesContain('nio.guard.decision'), false,
        'a guard-decision attribute from the disarm-era evaluation must not appear on the later export',
      );
    });
  });
});
