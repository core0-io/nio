// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * A tool's content records can outlive the span they name, and that is
 * the deliberate half of the deferred-span trade. Pinned here so a
 * future "fix" has to argue with the reasoning rather than discover it.
 *
 * Under the default (`eagerToolSpans: false`) the tool span is parked
 * until turn close, while `tool_input` goes out at PreToolUse and
 * `tool_output` at PostToolUse — both stamped with the span id the
 * backend has not received yet. Normally the span follows at turn close
 * and the join completes. This test drives the case where it never does,
 * and it is reachable WITHOUT a crash: the session is disarmed
 * mid-turn, so `flushSessionTurnInner` takes its `!tracerProvider` early
 * return, drops the parked spans, and the two records emitted while the
 * session was still armed are left naming a span nobody will send.
 *
 * The alternative — parking the content alongside the span so the two
 * share a fate — is worse where it counts. It would delete, on exactly
 * the mid-turn host crash that motivated the question, the tool
 * arguments and results that survive it today. A dangling log record
 * still says what the tool was asked to do and what it answered; a
 * parked one says nothing. So the join is best-effort by design and the
 * content leg is the durable one.
 *
 * ── Why this case is not vacuous ──────────────────────────────────────
 *
 * Both halves are asserted against each other on ONE run: the content
 * records must be present AND carry their real payloads, and the span id
 * they name must be absent from everything the tracer received. An
 * implementation that parks content fails the first half; one that
 * exports spans for a disarmed session fails the second (and would be a
 * capture-gate break, not just a shape change).
 *
 * It drives the real `createNioPlugin` binding through the real
 * per-session monitor gate — arming and disarming through
 * `saveMonitorStore`, never `monitor_all_sessions` — because the gate
 * transition is the mechanism under test.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReadableLogRecord } from '@opentelemetry/sdk-logs';
import { saveMonitorStore } from '../scripts/lib/monitor-store.js';
import type { CollectorLogsConfig } from '../adapters/config-schema.js';
import { makeInMemoryTracer } from './helpers/tracer.js';
import { makeInMemoryLogger } from './helpers/logger.js';
import { trackTempDir } from './helpers/tmp-dirs.js';

/** Guard verdict stub — this file never runs real Phase 0–6. */
function stubNioAllow(): never {
  return (() => ({
    orchestrator: {
      async evaluate() {
        return {
          decision: 'allow', risk_level: 'low', scores: { final: 0 },
          findings: [], explanation: 'test verdict', phase_stopped: 1, diagnostics: [],
        };
      },
    },
  })) as never;
}

const bodyOf = (r: ReadableLogRecord): string =>
  typeof r.body === 'string' ? r.body : JSON.stringify(r.body);

const spanIdOf = (r: ReadableLogRecord): string | undefined =>
  (r as unknown as { spanContext?: { spanId?: string } }).spanContext?.spanId;

describe('tool content records outlive the span they name (deliberate)', () => {
  it('keeps the arguments and result on the wire when a mid-turn disarm kills their span', async () => {
    const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-content-lifetime-')));
    // Deliberately NOT writeCaptureOnConfig: this case pins the gate
    // transition itself, so arming has to be visible next to the
    // assertion.
    writeFileSync(join(home, 'config.yaml'), 'collector: {}\n', 'utf-8');
    const logsConfig = { path: join(home, 'audit.jsonl') } as CollectorLogsConfig;
    const sessionID = 'oc-content-lifetime-1';

    const previousHome = process.env['NIO_HOME'];
    process.env['NIO_HOME'] = home;
    const tracer = makeInMemoryTracer();
    const logger = makeInMemoryLogger();
    try {
      saveMonitorStore(logsConfig, {
        sessions: { [sessionID]: { armed_at: Date.now(), cwd: join(home, 'workdir') } },
      });

      const { createNioPlugin } = await import('../adapters/opencode-plugin.js');
      const hooks = await createNioPlugin({
        nioFactory: stubNioAllow(),
        tracerProvider: tracer.provider,
        meterProvider: null,
        loggerProvider: logger.provider,
      })({ directory: '/tmp', worktree: '/tmp' } as never);

      await hooks.event!({
        event: { type: 'session.created', properties: { info: { id: sessionID } } },
      } as never);
      await hooks['chat.message']!(
        {}, { message: { sessionID }, parts: [{ type: 'text', text: 'read the file' }] },
      );
      await hooks['tool.execute.before']!(
        { tool: 'bash', sessionID, callID: 'clt_1' } as never,
        { args: { command: 'grep -rn TODO src' } } as never,
      );
      await hooks['tool.execute.after']!(
        { tool: 'bash', sessionID, callID: 'clt_1', args: {} } as never,
        { title: 'bash', output: 'src/a.ts:1: TODO fix', metadata: {} } as never,
      );

      // ── The user runs `/nio monitor off` here, mid-turn. ────────────
      saveMonitorStore(logsConfig, { sessions: {} });

      await hooks.event!(
        { event: { type: 'session.idle', properties: { sessionID } } } as never,
      );

      // Flush both signals before reading: the helpers batch exactly as
      // production does, and a NEGATIVE assertion read off an undrained
      // queue would pass for the wrong reason.
      const spans = await tracer.flushed();
      assert.equal(
        spans.length, 0,
        'a disarmed session exports nothing — if this ever becomes non-zero the capture gate is ' +
          'broken and this test is the least of the problems',
      );

      const records = await logger.flushed();
      const withSpan = records.filter((r) => spanIdOf(r) !== undefined);
      assert.equal(
        withSpan.length, 2,
        'the tool arguments and the tool result were both emitted while the session was still ' +
          'armed, and they stay emitted — parking content so it shares the span\'s fate would ' +
          'delete exactly the record a mid-turn crash makes most valuable',
      );

      const bodies = withSpan.map(bodyOf);
      assert.ok(
        bodies.some((b) => b.includes('grep -rn TODO src')),
        'the tool_input record must carry the real arguments, not an empty shell',
      );
      assert.ok(
        bodies.some((b) => b.includes('src/a.ts:1: TODO fix')),
        'the tool_output record must carry the real result',
      );

      const namedSpanIds = new Set(withSpan.map(spanIdOf));
      assert.equal(namedSpanIds.size, 1, 'both records name the one tool span');
      const exportedSpanIds = new Set(spans.map((s) => s.spanContext().spanId));
      for (const id of namedSpanIds) {
        assert.equal(
          exportedSpanIds.has(id!), false,
          'DOCUMENTED CONSEQUENCE: the span these records name is never exported. The window ' +
            'between a content record and its parked span does not always close — a mid-turn ' +
            'disarm (here) and a mid-turn host death both leave it open permanently. See ' +
            'InProcessPluginRuntime.emitToolContent for why this is preferred to the alternative.',
        );
      }
    } finally {
      if (previousHome === undefined) delete process.env['NIO_HOME'];
      else process.env['NIO_HOME'] = previousHome;
      await tracer.shutdown();
      await logger.shutdown();
    }
  });
});
