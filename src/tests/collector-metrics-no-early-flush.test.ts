// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * `dispatchCollectorEvent` must not spend its caller's flush budget on a
 * metrics export.
 *
 * ── The defect ────────────────────────────────────────────────────────
 *
 * Five branches of the dispatcher used to `await recordToolUse(...)` /
 * `await recordTurn(...)`, and each of those helpers ends in
 * `provider.forceFlush()`. All three of the dispatcher's callers
 * (`collector-hook.ts`, and both Hermes paths in `hook-cli.ts`) run the
 * WHOLE dispatch inside one shared `createFlushBudget` deadline, so a
 * metrics endpoint that accepts the connection and never answers turns
 * that mid-branch flush into the caller's entire budget — and the caller
 * then abandons the dispatch where it stands.
 *
 * Measured against a stalled OTLP sink at the default
 * `collector.timeout: 5000`, driving the shipped bundles:
 *
 *   metrics stalled, traces healthy      metrics healthy, traces healthy
 *   ─────────────────────────────────    ──────────────────────────────
 *   PreToolUse       5788 ms             PreToolUse        221 ms
 *   PostToolUse      5172 ms             PostToolUse       188 ms
 *   Stop             5175 ms             Stop              218 ms
 *
 * A dispatch that spends the whole budget is a dispatch the caller
 * abandons, and the caller's closing `Promise.all([...forceFlush])` then
 * never runs — so a stalled METRICS endpoint silently costs the turn's
 * SPANS on a traces endpoint that is working perfectly.
 *
 * ── What this file pins ───────────────────────────────────────────────
 *
 * The fix is `NO_EARLY_FLUSH` in collector-core.ts: `counter.add()` is
 * synchronous and already lands the point in the reader's aggregator, and
 * every caller ends with its own budgeted `meterProvider.forceFlush()`, so
 * the mid-branch flush bought nothing but the stall.
 *
 * Rather than stand up another stalled HTTP server (the suite already
 * carries two, and full-suite runs have hung twice on this branch), the
 * stall is injected at the provider seam: a `MeterProvider` stand-in whose
 * `forceFlush()` returns a promise that never settles. That is the exact
 * shape the stalled sink produced, with no socket to leak.
 *
 * MUTATION: drop the `NO_EARLY_FLUSH` argument at any of the five call
 * sites in collector-core.ts and the matching case below hangs on that
 * dispatch and fails on `DISPATCH_BOUND_MS`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MeterProvider } from '@opentelemetry/sdk-metrics';
import { dispatchCollectorEvent, type HookStdinPayload } from '../scripts/lib/collector-core.js';
import { loadState } from '../scripts/lib/traces-state-store.js';
import type { ResolvedMetricsConfig, CollectorLogsConfig } from '../adapters/common.js';
import { makeInMemoryTracer } from './helpers/tracer.js';
import { trackTempDir } from './helpers/tmp-dirs.js';

/**
 * Ceiling for one dispatch. The stalled sink cost 5.1-5.8s per event;
 * the same events with no early flush cost 0.19-0.22s. 2s sits well
 * clear of both, so the mutation fails on time rather than on a coin
 * toss, and slow CI still passes.
 */
const DISPATCH_BOUND_MS = 2000;

/**
 * A `MeterProvider` whose `forceFlush()` never settles.
 *
 * Only the three members `recordToolUse` / `recordTurn` touch are
 * implemented. `counter.add()` is a no-op recorder: this file is about
 * the dispatcher's control flow, not about metric values (those are
 * covered by metrics-collector's own tests).
 */
function stalledMeterProvider(): { provider: MeterProvider; recorded: { count: number } } {
  const recorded = { count: 0 };
  const instrument = {
    add: (): void => { recorded.count += 1; },
    record: (): void => { recorded.count += 1; },
  };
  const provider = {
    getMeter: () => ({
      createCounter: () => instrument,
      createHistogram: () => instrument,
    }),
    // Never resolves, never rejects — the stalled-endpoint shape.
    forceFlush: () => new Promise<void>(() => { /* deliberately pending */ }),
  };
  return { provider: provider as unknown as MeterProvider, recorded };
}

/**
 * Reject rather than hang, so a regression is a named failure inside this
 * file instead of a stalled suite.
 */
async function within<T>(label: string, p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(
            `${label} did not settle within ${DISPATCH_BOUND_MS}ms — a metrics ` +
            `forceFlush is being awaited inside dispatchCollectorEvent again`,
          )),
          DISPATCH_BOUND_MS,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

function freshLogsConfig(): CollectorLogsConfig {
  const dir = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-metrics-noflush-')));
  return { enabled: true, local: true, path: join(dir, 'audit.jsonl'), max_size_mb: 100 };
}

function toolPayload(sessionId: string): HookStdinPayload {
  return {
    tool_name: 'Bash',
    tool_input: { command: 'echo hi' },
    session_id: sessionId,
    tool_use_id: 'tc-noflush-1',
    cwd: '/tmp',
  };
}

describe('collector-core does not await a metrics flush inside a dispatch', () => {
  it('PreToolUse settles promptly with a meter provider that never flushes', async () => {
    const logsConfig = freshLogsConfig();
    const meter = stalledMeterProvider();
    const sessionId = 'sess-noflush-pre';

    await within('PreToolUse dispatch', dispatchCollectorEvent({
      event: 'PreToolUse', input: toolPayload(sessionId), platform: 'claude-code',
      config: baseConfig, meterProvider: meter.provider,
      tracerProvider: null, logsConfig,
    }));

    // The point still has to be RECORDED — "don't flush" must not become
    // "don't count". Without this, deleting the counter.add() call
    // entirely would pass.
    assert.equal(meter.recorded.count, 1, 'the tool-use counter must still be incremented');
  });

  it('PostToolUse and TaskCreated/TaskCompleted settle promptly too', async () => {
    const logsConfig = freshLogsConfig();
    const meter = stalledMeterProvider();
    const sessionId = 'sess-noflush-rest';

    await within('PostToolUse dispatch', dispatchCollectorEvent({
      event: 'PostToolUse',
      input: { ...toolPayload(sessionId), tool_response: { output: 'hi' } },
      platform: 'claude-code',
      config: baseConfig, meterProvider: meter.provider,
      tracerProvider: null, logsConfig,
    }));
    await within('TaskCreated dispatch', dispatchCollectorEvent({
      event: 'TaskCreated',
      input: { session_id: sessionId, cwd: '/tmp', task_id: 'task-1', task_input: { prompt: 'go' } },
      platform: 'claude-code',
      config: baseConfig, meterProvider: meter.provider,
      tracerProvider: null, logsConfig,
    }));
    await within('TaskCompleted dispatch', dispatchCollectorEvent({
      event: 'TaskCompleted',
      input: { session_id: sessionId, cwd: '/tmp', task_id: 'task-1' },
      platform: 'claude-code',
      config: baseConfig, meterProvider: meter.provider,
      tracerProvider: null, logsConfig,
    }));

    assert.equal(meter.recorded.count, 3, 'each of the three events must still count');
  });

  /**
   * The consequence test, and the reason this defect is worth a fix
   * rather than a note: a `Stop` whose dispatch is abandoned mid-branch
   * takes its CALLER's closing flush with it, so a stalled METRICS
   * endpoint costs the turn tree on a perfectly healthy TRACES endpoint.
   * Stated as a behaviour rather than a note.
   */
  it('Stop still closes the turn and clears its state when metrics never flush', async () => {
    const logsConfig = freshLogsConfig();
    const meter = stalledMeterProvider();
    const tracer = makeInMemoryTracer();
    const sessionId = 'sess-noflush-stop';

    await within('UserPromptSubmit dispatch', dispatchCollectorEvent({
      event: 'UserPromptSubmit', input: { session_id: sessionId, cwd: '/tmp', prompt: 'go' },
      platform: 'claude-code', config: baseConfig, meterProvider: meter.provider,
      tracerProvider: tracer.provider, logsConfig,
    }));
    await within('PreToolUse dispatch', dispatchCollectorEvent({
      event: 'PreToolUse', input: toolPayload(sessionId), platform: 'claude-code',
      config: baseConfig, meterProvider: meter.provider,
      tracerProvider: tracer.provider, logsConfig,
    }));
    await within('PostToolUse dispatch', dispatchCollectorEvent({
      event: 'PostToolUse',
      input: { ...toolPayload(sessionId), tool_response: { output: 'hi' } },
      platform: 'claude-code', config: baseConfig, meterProvider: meter.provider,
      tracerProvider: tracer.provider, logsConfig,
    }));

    assert.ok(loadState(logsConfig)?.turn_trace_id, 'precondition: the turn is open');

    await within('Stop dispatch', dispatchCollectorEvent({
      event: 'Stop', input: { session_id: sessionId, cwd: '/tmp' },
      platform: 'claude-code', config: baseConfig, meterProvider: meter.provider,
      tracerProvider: tracer.provider, logsConfig,
    }));

    const spans = await tracer.flushed();
    assert.ok(
      spans.some((s) => s.name === 'invoke_agent UserPromptSubmit'),
      `the turn root must still be exported; got: ${spans.map((s) => s.name).join(', ')}`,
    );
    assert.equal(
      loadState(logsConfig)?.turn_trace_id, '',
      'the turn must still be closed in the persisted state',
    );
  });
});
