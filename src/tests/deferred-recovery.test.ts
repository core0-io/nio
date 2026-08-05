// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Task 5: recover a crash-orphaned deferred-span tree.
 *
 * Deferring tool-span emission to end-of-turn raised the crash stakes:
 * before deferral, a killed process only cost the turn's root span
 * (every tool span had already gone out individually as it closed). Now
 * the whole tree — root AND every finished-but-unflushed tool span —
 * sits in `state.deferred_spans` until `Stop`/`SubagentStop`/`SessionEnd`
 * runs `endTurn`. If the process dies first, all of it would silently
 * vanish, because nothing else in the codebase ever reads
 * `deferred_spans` back out.
 *
 * Recovery has two entry points, both exercised below:
 *   (a) lazy — any event that arrives and finds an orphaned tree in the
 *       state it loads flushes that tree before doing its own work.
 *   (b) SessionStart — the same lazy check, but specifically covering
 *       the case where nothing else ever arrives to trigger it (a) — the
 *       user's next session simply starts.
 *
 * Both funnel through `hasOrphanedDeferredTree` / `recoverDeferredTree`
 * in traces-collector.ts, wired into `dispatchCollectorEvent` in
 * collector-core.ts ahead of all per-event handling.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchCollectorEvent } from '../scripts/lib/collector-core.js';
import { recoverDeferredTree } from '../scripts/lib/traces-collector.js';
import { loadState, saveState, type CollectorState, type DeferredSpan } from '../scripts/lib/traces-state-store.js';
import type { ResolvedMetricsConfig, CollectorLogsConfig } from '../adapters/common.js';
import { makeInMemoryTracer } from './helpers/tracer.js';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-node';

function freshFixture(): { logsConfig: CollectorLogsConfig } {
  const dir = mkdtempSync(join(tmpdir(), 'nio-deferred-recovery-'));
  const auditPath = join(dir, 'audit.jsonl');
  return { logsConfig: { enabled: true, local: true, path: auditPath, max_size_mb: 100 } };
}

const baseConfig: ResolvedMetricsConfig = {
  endpoint: '',
  api_key: '',
  timeout: 5000,
  protocol: 'http',
  enabled: true,
  metrics_enabled: true,
  traces_enabled: true,
  logs_enabled: true,
};

function orphanTool(spanId: string, ageMs = 6000): DeferredSpan {
  return {
    kind: 'tool',
    name: 'execute_tool Bash',
    span_id: spanId,
    start_ms: Date.now() - ageMs,
    end_ms: Date.now() - ageMs + 500,
    attributes: { 'gen_ai.tool.name': 'Bash' },
  };
}

function incompleteRoot(spans: readonly ReadableSpan[]): ReadableSpan | undefined {
  return spans.find((s) => s.attributes['nio.turn.incomplete'] === true);
}

// ── (a) Lazy recovery: turn_trace_id already cleared, same session ─────

describe('deferred-recovery: lazy recovery when turn_trace_id is empty but deferred_spans survived', () => {
  it('the next event flushes the orphaned tree, tags the root incomplete, and drains deferred_spans', async () => {
    const { logsConfig } = freshFixture();
    const tracer = makeInMemoryTracer();
    const sessionId = 'sess-crashed-1';

    const stale: CollectorState = {
      session_id: sessionId,
      turn_number: 3,
      turn_trace_id: '',               // already cleared — the trigger condition under test
      turn_start_ms: 0,
      pending_spans: {},
      pending_task_spans: {},
      turn_attributes: {},
      deferred_spans: [orphanTool('a'.repeat(16))],
    };
    saveState(logsConfig, stale);

    // Any event on the same session should notice and flush.
    await dispatchCollectorEvent({
      event: 'PreToolUse',
      input: {
        tool_name: 'Read', tool_input: { file_path: '/x' },
        session_id: sessionId, tool_use_id: 'call-new', cwd: '/tmp',
      },
      platform: 'claude-code',
      config: baseConfig, meterProvider: null, tracerProvider: tracer.provider, logsConfig,
    });

    const spans = tracer.finished();
    const root = incompleteRoot(spans);
    assert.ok(root, 'a root span tagged nio.turn.incomplete must be exported');

    const tool = spans.find((s) => s.name === 'execute_tool Bash');
    assert.ok(tool, 'the orphaned tool span must be exported too');

    const after = loadState(logsConfig);
    assert.deepEqual(after?.deferred_spans, [], 'deferred_spans must be drained after recovery');
  });

  it('recovering twice in a row does not re-emit (idempotent — no duplicate incomplete root)', async () => {
    const { logsConfig } = freshFixture();
    const tracer = makeInMemoryTracer();
    const sessionId = 'sess-crashed-1b';

    const stale: CollectorState = {
      session_id: sessionId,
      turn_number: 1,
      turn_trace_id: '',
      turn_start_ms: 0,
      pending_spans: {},
      pending_task_spans: {},
      turn_attributes: {},
      deferred_spans: [orphanTool('b'.repeat(16))],
    };
    saveState(logsConfig, stale);

    for (let i = 0; i < 2; i++) {
      await dispatchCollectorEvent({
        event: 'PreToolUse',
        input: {
          tool_name: 'Read', tool_input: { file_path: '/y' },
          session_id: sessionId, tool_use_id: `call-${i}`, cwd: '/tmp',
        },
        platform: 'claude-code',
        config: baseConfig, meterProvider: null, tracerProvider: tracer.provider, logsConfig,
      });
    }

    const incompleteRoots = tracer.finished().filter((s) => s.attributes['nio.turn.incomplete'] === true);
    assert.equal(incompleteRoots.length, 1, 'the orphaned tree must be flushed exactly once');
  });
});

// ── Trace id consistency: recovery reuses the leftover turn_trace_id ───

describe('deferred-recovery: reuses the leftover turn_trace_id, never mints a new one', () => {
  it('recovered spans land on the SAME trace id that was already persisted (session changed mid-turn)', async () => {
    const { logsConfig } = freshFixture();
    const tracer = makeInMemoryTracer();

    const staleTurnTraceId = 'b'.repeat(32);
    const stale: CollectorState = {
      session_id: 'sess-crashed-2',
      turn_number: 1,
      turn_trace_id: staleTurnTraceId,   // non-empty: a real crash mid-turn
      turn_start_ms: Date.now() - 10000,
      pending_spans: {},
      pending_task_spans: {},
      turn_attributes: {},
      deferred_spans: [orphanTool('c'.repeat(16), 8000)],
    };
    saveState(logsConfig, stale);

    // A brand new session starts — this is the realistic crash-recovery
    // trigger: the old process died mid-turn, and a fresh process/session
    // picks up afterwards.
    await dispatchCollectorEvent({
      event: 'UserPromptSubmit',
      input: { session_id: 'sess-new-2', prompt: 'hello again', cwd: '/tmp' },
      platform: 'claude-code',
      config: baseConfig, meterProvider: null, tracerProvider: tracer.provider, logsConfig,
    });

    const spans = tracer.finished();
    const root = incompleteRoot(spans);
    assert.ok(root, 'recovery must fire on the session-changed trigger too');
    assert.equal(
      root!.spanContext().traceId, staleTurnTraceId,
      'recovered root must reuse the leftover turn_trace_id, not a freshly minted one',
    );

    const tool = spans.find((s) => s.name === 'execute_tool Bash');
    assert.ok(tool);
    assert.equal(
      tool!.spanContext().traceId, staleTurnTraceId,
      'recovered tool span must join the SAME trace as the root — otherwise it orphans from ' +
      'any content log records already emitted under the old trace id',
    );
  });
});

// ── (b) SessionStart scan: the "no third event ever arrives" fallback ──

describe('deferred-recovery: SessionStart also scans for and flushes a leftover tree', () => {
  it('a fresh SessionStart flushes a crashed prior session\'s orphaned tree before minting its own session trace', async () => {
    const { logsConfig } = freshFixture();
    const tracer = makeInMemoryTracer();

    const staleTurnTraceId = 'd'.repeat(32);
    const stale: CollectorState = {
      session_id: 'sess-crashed-3',
      turn_number: 1,
      turn_trace_id: staleTurnTraceId,
      turn_start_ms: Date.now() - 20000,
      pending_spans: {},
      pending_task_spans: {},
      turn_attributes: {},
      deferred_spans: [orphanTool('e'.repeat(16), 15000)],
    };
    saveState(logsConfig, stale);

    await dispatchCollectorEvent({
      event: 'SessionStart',
      input: { session_id: 'sess-new-3' },
      platform: 'claude-code',
      config: baseConfig, meterProvider: null, tracerProvider: tracer.provider, logsConfig,
    });

    const spans = tracer.finished();
    const root = incompleteRoot(spans);
    assert.ok(root, 'SessionStart must flush the orphaned tree from the crashed session');
    assert.equal(root!.spanContext().traceId, staleTurnTraceId);

    const after = loadState(logsConfig);
    assert.deepEqual(after?.deferred_spans, [], 'deferred_spans must be drained after the SessionStart scan');
    // The new session still gets its own session trace minted (Task 4)
    // on top of the recovery — the two concerns are independent.
    assert.ok(after?.session_trace_id, 'SessionStart must still mint a session trace for the NEW session');
  });
});

// ── I1 regression: recoverDeferredTree itself must drain and be idempotent ─
//
// Review finding I1: changing recoverDeferredTree's return value from
// `deferred_spans: []` to `deferred_spans: deferred` (i.e. never
// clearing it) left `deferred-recovery.test.ts` fully green, because
// both suites above only observe recoverDeferredTree indirectly through
// `dispatchCollectorEvent` → `ensureTurn`, and `ensureTurn`'s
// new-turn branch (`carryPending`) unconditionally resets
// `deferred_spans` to `[]` whenever it mints a fresh turn — which is
// exactly what happens on the very next event after recovery. That
// reset papers over a broken recoverDeferredTree before any test gets a
// chance to read the drained value back out.
//
// The two tests below close that gap: the first calls
// `recoverDeferredTree` directly — no `dispatchCollectorEvent`, no
// `ensureTurn` in the call path at all — so a regression is visible on
// the very state object the function returns. The second exercises the
// one dispatch-level path that does NOT go through the masking
// `ensureTurn` reset: a `SessionStart` for the SAME session id that was
// just recovered takes `startSessionTrace`'s `base = prev` branch
// (session unchanged), which passes `deferred_spans` through as-is
// rather than resetting it — unlike the cross-session case in the
// "(b) SessionStart scan" suite above, whose `sessionChanged` branch
// always builds a clean skeleton and would hide the same bug.

describe('deferred-recovery: recoverDeferredTree itself drains and is idempotent (bypasses dispatchCollectorEvent/ensureTurn)', () => {
  it('draining: the returned state has deferred_spans == [] right after the call', async () => {
    const tracer = makeInMemoryTracer();
    const sessionId = 'sess-direct-1';

    const state: CollectorState = {
      session_id: sessionId,
      turn_number: 1,
      turn_trace_id: 'a'.repeat(32),
      turn_start_ms: Date.now() - 5000,
      pending_spans: {},
      pending_task_spans: {},
      turn_attributes: {},
      deferred_spans: [orphanTool('1'.repeat(16))],
    };

    const first = await recoverDeferredTree(tracer.provider, state);
    assert.deepEqual(first.deferred_spans, [], 'recoverDeferredTree must return deferred_spans: [] on its own result');

    const spansAfterFirst = tracer.finished().length;
    assert.ok(spansAfterFirst > 0, 'the first call must actually emit the recovered tree');

    // Idempotency: calling it again on the (now-drained) result must be a
    // pure no-op — same empty deferred_spans, no additional spans exported.
    const second = await recoverDeferredTree(tracer.provider, first);
    assert.deepEqual(second.deferred_spans, [], 'a second call on an already-drained state must still be []');
    assert.equal(
      tracer.finished().length, spansAfterFirst,
      'a second call must not re-emit the tree — recoverDeferredTree is a no-op once deferred_spans is empty',
    );
  });
});

describe('deferred-recovery: SessionStart on the SAME session that was just recovered', () => {
  it('deferred_spans stays empty — the base=prev pass-through path does not resurrect it', async () => {
    const { logsConfig } = freshFixture();
    const tracer = makeInMemoryTracer();
    const sessionId = 'sess-same-session-recover';

    const stale: CollectorState = {
      session_id: sessionId,
      turn_number: 2,
      turn_trace_id: '',               // closed turn — the lazy-recovery trigger
      turn_start_ms: 0,
      pending_spans: {},
      pending_task_spans: {},
      turn_attributes: {},
      deferred_spans: [orphanTool('f'.repeat(16))],
    };
    saveState(logsConfig, stale);

    // SessionStart for the SAME session id as the stale state: the lazy
    // crash-recovery block fires first (closed turn_trace_id, not a
    // session mismatch), then the SessionStart branch reloads state and
    // calls startSessionTrace with sessionChanged === false, so it takes
    // the base=prev branch — the one path that carries deferred_spans
    // through unchanged instead of resetting it.
    await dispatchCollectorEvent({
      event: 'SessionStart',
      input: { session_id: sessionId },
      platform: 'claude-code',
      config: baseConfig, meterProvider: null, tracerProvider: tracer.provider, logsConfig,
    });

    const after = loadState(logsConfig);
    assert.deepEqual(
      after?.deferred_spans, [],
      'deferred_spans must stay empty after SessionStart on the just-recovered session — a leak here ' +
      'would re-emit the same orphaned tree the next time hasOrphanedDeferredTree sees it',
    );
    assert.ok(after?.session_trace_id, 'SessionStart must still mint a session trace for this session');
  });
});
