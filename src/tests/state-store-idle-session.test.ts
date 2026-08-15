// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Review finding I2: the sweep must not destroy a session that is merely
 * IDLE.
 *
 * `SHARD_STALE_MS` treats "no collector event for an hour" as "the host
 * died", and the earlier implementation acted on that by UNLINKING the
 * shard. mtime cannot tell the two apart: one `Bash` call that runs for
 * two hours, and a window left open overnight, both look exactly like a
 * crash. Deleting the shard cost the surviving session three things,
 * all measured on the pre-fix build:
 *
 *   1. `spans at PostToolUse: []` — the in-flight `pending_spans` entry
 *      was gone, so `deferPostToolUse` returned `durationMs: null` and
 *      emitted nothing at all for a tool call that completed normally;
 *   2. `session span emitted? false` — `session_trace_id` was gone, so
 *      `SessionEnd` skipped `emitSessionSpan` entirely;
 *   3. `turn_trace_id` was replaced and `turn_number` restarted, so one
 *      turn came out as two unlinked traces both claiming turn 1.
 *
 * The fix splits the sweep into a salvage leg (1h, takes only
 * `deferred_spans`) and a GC leg (7d, deletes). These tests pin the
 * salvage leg's promise: after it runs, an idle-but-alive session is
 * indistinguishable from one that was never swept, except that any
 * spans it found PARKED went out early tagged `nio.turn.incomplete`.
 *
 * Since tool spans became eager, a shard written by the current code
 * never has anything parked, so the salvage leg's normal outcome is now
 * "leave it completely alone" — which the first case pins. The leg
 * itself is still reachable from a shard written by the deferral path (a
 * nio that predates the switch, or `eagerToolSpans: false`), and the
 * second case constructs exactly that shard so the adoption machinery
 * does not rot.
 *
 * `state-store-session-isolation.test.ts` covers the two legs' timing;
 * this file covers what the live session sees.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchCollectorEvent } from '../scripts/lib/collector-core.js';
import { statePath, loadState, saveState } from '../scripts/lib/traces-state-store.js';
import { recordPreToolUse, deferPostToolUse } from '../scripts/lib/traces-collector.js';
import type { ResolvedMetricsConfig, CollectorLogsConfig } from '../adapters/common.js';
import { makeInMemoryTracer, type InMemoryTracer } from './helpers/tracer.js';
import { trackTempDir } from './helpers/tmp-dirs.js';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-node';

const baseConfig: ResolvedMetricsConfig = {
  endpoint: '', api_key: '', timeout: 5000, protocol: 'http',
  enabled: true, metrics_enabled: true, traces_enabled: true, logs_enabled: true,
};

function freshLogsConfig(): CollectorLogsConfig {
  const dir = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-idle-session-')));
  return { enabled: true, local: true, path: join(dir, 'audit.jsonl'), max_size_mb: 100 };
}

/** Backdate a shard so the sweep reads it as untouched for `ms`. */
function ageShard(logsConfig: CollectorLogsConfig, sessionId: string, ms: number): void {
  const when = new Date(Date.now() - ms);
  utimesSync(statePath(logsConfig, sessionId), when, when);
}

const TWO_HOURS = 2 * 60 * 60 * 1000;

function dispatcher(logsConfig: CollectorLogsConfig, tracer: InMemoryTracer) {
  return (event: string, input: Record<string, unknown>) => dispatchCollectorEvent({
    event,
    input,
    platform: 'claude-code',
    config: baseConfig,
    meterProvider: null,
    tracerProvider: tracer.provider,
    logsConfig,
  });
}

/** Another window starting up — the only thing that runs the sweep. */
function otherSessionStart(logsConfig: CollectorLogsConfig, tracer: InMemoryTracer, id: string) {
  return dispatcher(logsConfig, tracer)('SessionStart', { session_id: id });
}

const named = (spans: readonly ReadableSpan[], name: string) => spans.filter((s) => s.name === name);
const incompleteRoots = (spans: readonly ReadableSpan[]) =>
  spans.filter((s) => s.attributes['nio.turn.incomplete'] === true);

describe('an idle-but-alive session survives another session\'s SessionStart sweep', () => {
  it('a tool call still in flight across the sweep still produces its span', async () => {
    const logsConfig = freshLogsConfig();
    const tracer = makeInMemoryTracer();
    const send = dispatcher(logsConfig, tracer);
    const LIVE = 'sess-live-long-tool';

    await send('SessionStart', { session_id: LIVE });
    await send('UserPromptSubmit', { session_id: LIVE, prompt: 'do the slow thing' });
    // A finished tool call, so the shard has something to salvage…
    await send('PreToolUse', {
      session_id: LIVE, tool_name: 'Read', tool_use_id: 'call-done',
      tool_input: { file_path: '/x' }, cwd: '/tmp',
    });
    await send('PostToolUse', {
      session_id: LIVE, tool_name: 'Read', tool_use_id: 'call-done',
      tool_input: { file_path: '/x' }, tool_response: { output: 'ok' }, cwd: '/tmp',
    });
    // …and one still running: this is the two-hour Bash call.
    await send('PreToolUse', {
      session_id: LIVE, tool_name: 'Bash', tool_use_id: 'call-slow',
      tool_input: { command: 'sleep 7200' }, cwd: '/tmp',
    });

    const before = loadState(logsConfig, LIVE);
    assert.ok(before?.pending_spans['call-slow'], 'precondition: the slow call is pending');
    assert.deepEqual(
      before?.deferred_spans ?? [], [],
      'precondition: nothing is parked — the finished Read span left at PostToolUse',
    );
    assert.equal(
      named(tracer.finished(), 'execute_tool Read').length, 1,
      'precondition: …and it is already on the wire, so the sweep cannot cost it anything',
    );
    const turnTraceId = before!.turn_trace_id;
    const sessionTraceId = before!.session_trace_id;
    assert.ok(turnTraceId && sessionTraceId);

    ageShard(logsConfig, LIVE, TWO_HOURS);
    await otherSessionStart(logsConfig, tracer, 'sess-new-window');

    assert.ok(
      existsSync(statePath(logsConfig, LIVE)),
      'the live session\'s shard must still exist — everything below follows from this',
    );
    const swept = loadState(logsConfig, LIVE);
    assert.ok(
      swept?.pending_spans['call-slow'],
      'the in-flight pending entry was destroyed: PostToolUse will find nothing, get ' +
      'durationMs: null, and emit no span for a tool call that completed normally',
    );
    assert.equal(swept?.turn_trace_id, turnTraceId, 'the turn must not be restarted');
    assert.equal(swept?.turn_number, before!.turn_number, 'turn_number must not be reused');
    assert.equal(swept?.session_trace_id, sessionTraceId, 'the session trace must survive');
    assert.deepEqual(swept?.deferred_spans ?? [], [], 'and still nothing parked');

    // Under eager export the salvage leg finds nothing to take, so it
    // must leave the shard completely alone — no early flush, no
    // detached root. `hasOrphanedDeferredTree` is gated on a non-empty
    // `deferred_spans`, so this is the shape for every shard written by
    // the current code; the salvage itself is still pinned, against a
    // shard written by the deferral path, in the case below.
    assert.equal(
      incompleteRoots(tracer.finished()).length, 0,
      'nothing was parked, so nothing may be flushed early and tagged nio.turn.incomplete',
    );

    // The slow call finally returns.
    await send('PostToolUse', {
      session_id: LIVE, tool_name: 'Bash', tool_use_id: 'call-slow',
      tool_input: { command: 'sleep 7200' }, tool_response: { output: 'done' }, cwd: '/tmp',
    });
    await send('Stop', { session_id: LIVE, cwd: '/tmp' });

    const bashSpans = named(tracer.finished(), 'execute_tool Bash');
    assert.equal(bashSpans.length, 1, 'the tool call that spanned the sweep must still be exported');
    assert.equal(
      bashSpans[0]!.spanContext().traceId, turnTraceId,
      'and it must land on the turn it actually belonged to',
    );
  });

  it('the turn root emitted at Stop does not collide with the salvage root', async () => {
    const logsConfig = freshLogsConfig();
    const tracer = makeInMemoryTracer();
    const send = dispatcher(logsConfig, tracer);
    const LIVE = 'sess-live-root-collision';

    await send('SessionStart', { session_id: LIVE });
    await send('UserPromptSubmit', { session_id: LIVE, prompt: 'hello' });

    // A shard carrying a PARKED span. Nothing on the eager default
    // produces one, so the salvage leg is now reachable only from a
    // shard written by the deferral path — a nio that predates the
    // switch, or a runtime configured with `eagerToolSpans: false`.
    // Those shards outlive the upgrade that stopped producing them, so
    // the machinery that adopts them stays, and stays under test.
    {
      let parked = loadState(logsConfig, LIVE)!;
      parked = recordPreToolUse(
        parked, 'c1', 'Read', '/x', { 'gen_ai.tool.call.id': 'c1' },
      );
      parked = deferPostToolUse(parked, 'c1', '/tmp').state;
      assert.equal(parked.deferred_spans?.length, 1, 'precondition: the shard has a parked span');
      saveState(logsConfig, parked, LIVE);
    }

    ageShard(logsConfig, LIVE, TWO_HOURS);
    await otherSessionStart(logsConfig, tracer, 'sess-new-window-2');
    await send('Stop', { session_id: LIVE, cwd: '/tmp' });

    const roots = named(tracer.finished(), 'invoke_agent UserPromptSubmit');
    assert.equal(roots.length, 2, 'one salvage root and one real turn close');
    const [a, b] = roots;
    assert.equal(
      a!.spanContext().traceId, b!.spanContext().traceId,
      'both belong to the same turn, so both keep the turn trace id',
    );
    assert.notEqual(
      a!.spanContext().spanId, b!.spanContext().spanId,
      'the salvage root must be detached: sharing (trace id, span id) with the real turn ' +
      'close makes backends merge or duplicate two genuinely different spans',
    );
  });

  it('a session idle BETWEEN turns still emits its session span at SessionEnd', async () => {
    // The common case from the review: nothing is in flight, the shard
    // holds only session identity, and the old GC leg deleted it anyway.
    const logsConfig = freshLogsConfig();
    const tracer = makeInMemoryTracer();
    const send = dispatcher(logsConfig, tracer);
    const LIVE = 'sess-live-overnight';

    await send('SessionStart', { session_id: LIVE });
    await send('UserPromptSubmit', { session_id: LIVE, prompt: 'turn one' });
    await send('Stop', { session_id: LIVE, cwd: '/tmp' });

    const before = loadState(logsConfig, LIVE);
    assert.ok(before?.session_trace_id, 'precondition: a session trace exists');
    assert.equal(before?.turn_trace_id, '', 'precondition: no turn in progress');
    assert.equal(before?.deferred_spans?.length ?? 0, 0, 'precondition: nothing parked');

    ageShard(logsConfig, LIVE, TWO_HOURS);
    await otherSessionStart(logsConfig, tracer, 'sess-new-window-3');

    assert.ok(
      existsSync(statePath(logsConfig, LIVE)),
      'a shard with nothing to salvage and nothing wrong with it must be left completely alone',
    );
    assert.equal(
      loadState(logsConfig, LIVE)?.session_trace_id, before!.session_trace_id,
    );

    // Back in the morning: a second turn, then the window closes.
    await send('UserPromptSubmit', { session_id: LIVE, prompt: 'turn two' });
    await send('Stop', { session_id: LIVE, cwd: '/tmp' });
    await send('SessionEnd', { session_id: LIVE, cwd: '/tmp' });

    const sessionSpans = named(tracer.finished(), 'session');
    assert.equal(
      sessionSpans.length, 1,
      'the session root span was silently never exported — SessionEnd found no ' +
      'session_trace_id because the sweep had deleted the shard',
    );
    assert.equal(sessionSpans[0]!.spanContext().traceId, before!.session_trace_id);
  });

  it('a session that keeps working through the sweep keeps ONE turn numbering', async () => {
    const logsConfig = freshLogsConfig();
    const tracer = makeInMemoryTracer();
    const send = dispatcher(logsConfig, tracer);
    const LIVE = 'sess-live-turn-numbers';

    await send('SessionStart', { session_id: LIVE });
    await send('UserPromptSubmit', { session_id: LIVE, prompt: 'one' });
    await send('Stop', { session_id: LIVE, cwd: '/tmp' });
    await send('UserPromptSubmit', { session_id: LIVE, prompt: 'two' });
    await send('PreToolUse', {
      session_id: LIVE, tool_name: 'Read', tool_use_id: 'c2',
      tool_input: { file_path: '/y' }, cwd: '/tmp',
    });
    await send('PostToolUse', {
      session_id: LIVE, tool_name: 'Read', tool_use_id: 'c2',
      tool_input: { file_path: '/y' }, tool_response: { output: 'ok' }, cwd: '/tmp',
    });

    const before = loadState(logsConfig, LIVE);
    assert.equal(before?.turn_number, 2, 'precondition: this is the second turn');

    ageShard(logsConfig, LIVE, TWO_HOURS);
    await otherSessionStart(logsConfig, tracer, 'sess-new-window-4');

    await send('Stop', { session_id: LIVE, cwd: '/tmp' });
    await send('UserPromptSubmit', { session_id: LIVE, prompt: 'three' });

    assert.equal(
      loadState(logsConfig, LIVE)?.turn_number, 3,
      'turn numbering restarted: the sweep dropped the counter and the session now ' +
      'reports two different turns under the same number',
    );
  });
});
