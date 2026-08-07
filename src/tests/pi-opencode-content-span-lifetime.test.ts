// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * The window in which a tool's content records name a span the backend
 * does not have yet, and what closed most of it.
 *
 * `tool_input` goes out at the pre side and `tool_output` at the post
 * side, each stamped with the tool span's id. While tool spans were
 * PARKED until turn close, that window covered the whole turn and did
 * not always end: a mid-turn disarm (or a mid-turn crash) left both
 * records naming a span nobody would ever send.
 *
 * Eager export closes it for a tool that RAN. The span leaves at the
 * post side, immediately after the record that names it, so the first
 * case below — a disarm after the tool completed — now joins cleanly
 * where it used to dangle two records.
 *
 * What remains is the narrow case in the second test: a disarm BETWEEN
 * the two sides. The arguments were emitted while armed, the post side
 * finds the session unmonitored and resolves no provider, and
 * `flushSessionTurnInner` takes its `!tracerProvider` early return. That
 * record dangles, permanently, and that is still the right trade:
 * parking the content so it shares the span's fate would delete, on
 * exactly the mid-turn crash that motivated the question, the arguments
 * that survive it today. A dangling record says what the tool was asked
 * to do; a parked one says nothing.
 *
 * ── Why these cases are not vacuous ───────────────────────────────────
 *
 * Each asserts both halves against each other on one run — which records
 * exist AND which span ids the tracer actually received — so an
 * implementation that parks content fails one half and one that exports
 * spans for a disarmed session fails the other. The two cases differ by
 * exactly one thing, the position of the disarm relative to
 * `tool.execute.after`, so neither can pass by accident on the other's
 * mechanism.
 *
 * They drive the real `createNioPlugin` binding through the real
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

describe('tool content records and the span they name', () => {
  it('joins both records to their span when the disarm lands after the tool completed', async () => {
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
      const toolSpans = spans.filter((s) => s.name.startsWith('execute_tool'));
      assert.equal(
        toolSpans.length, 1,
        'the tool span left at tool.execute.after, while the session was still armed — parking it ' +
          'would have made this 0 and stranded both records below',
      );
      assert.equal(
        spans.filter((s) => s.name.startsWith('invoke_agent')).length, 0,
        'and the turn root was NOT exported: the disarm took flushSessionTurnInner\'s early ' +
          'return, so this run really did lose everything that waits for turn close',
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
      assert.equal(
        [...namedSpanIds][0], toolSpans[0]!.spanContext().spanId,
        'and that span is the one the tracer received — the join completes. Under the parked ' +
          'implementation this is precisely where it did not.',
      );
    } finally {
      if (previousHome === undefined) delete process.env['NIO_HOME'];
      else process.env['NIO_HOME'] = previousHome;
      await tracer.shutdown();
      await logger.shutdown();
    }
  });

  it('leaves the arguments record dangling when the disarm lands mid-call', async () => {
    const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-content-lifetime-mid-')));
    writeFileSync(join(home, 'config.yaml'), 'collector: {}\n', 'utf-8');
    const logsConfig = { path: join(home, 'audit.jsonl') } as CollectorLogsConfig;
    const sessionID = 'oc-content-lifetime-2';

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
        { tool: 'bash', sessionID, callID: 'clt_2' } as never,
        { args: { command: 'grep -rn TODO src' } } as never,
      );

      // ── `/nio monitor off` lands WHILE the tool is running. ────────
      saveMonitorStore(logsConfig, { sessions: {} });

      await hooks['tool.execute.after']!(
        { tool: 'bash', sessionID, callID: 'clt_2', args: {} } as never,
        { title: 'bash', output: 'src/a.ts:1: TODO fix', metadata: {} } as never,
      );
      await hooks.event!(
        { event: { type: 'session.idle', properties: { sessionID } } } as never,
      );

      const spans = await tracer.flushed();
      assert.equal(
        spans.length, 0,
        'the post side found the session unmonitored and resolved no provider — if this ever ' +
          'becomes non-zero the capture gate is broken and this test is the least of the problems',
      );

      const records = await logger.flushed();
      const withSpan = records.filter((r) => spanIdOf(r) !== undefined);
      assert.equal(
        withSpan.length, 1,
        'only the arguments record was emitted while armed; the result record was gated off with ' +
          'the span',
      );
      assert.ok(
        bodyOf(withSpan[0]!).includes('grep -rn TODO src'),
        'and it carries the real arguments, not an empty shell',
      );

      const exportedSpanIds = new Set(spans.map((s) => s.spanContext().spanId));
      assert.equal(
        exportedSpanIds.has(spanIdOf(withSpan[0]!)!), false,
        'DOCUMENTED CONSEQUENCE: the span this record names is never exported. Eager export ' +
          'closed the window for a tool that ran; a disarm (or a crash) between the two sides ' +
          'still leaves it open permanently. See InProcessPluginRuntime.emitToolContent for why ' +
          'this is preferred to parking the content.',
      );
    } finally {
      if (previousHome === undefined) delete process.env['NIO_HOME'];
      else process.env['NIO_HOME'] = previousHome;
      await tracer.shutdown();
      await logger.shutdown();
    }
  });
});
