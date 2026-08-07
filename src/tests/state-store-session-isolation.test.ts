// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * `traces-state-store.json` is sharded per session.
 *
 * Before sharding, all four platforms shared ONE fixed filename under
 * `~/.nio`. Two host windows open at once are two independent sessions
 * writing that one file, and the damage is not lost data — it is
 * MIS-ATTRIBUTED data:
 *
 *   - `dispatchCollectorEvent`'s Stop branch loads the state and hands it
 *     straight to `endTurn` with NO session check. Session A's Stop, run
 *     after session B's last write, exports A's conversation content
 *     (A's transcript, A's cwd, A's tool results) under B's
 *     `turn_trace_id` and with B's `gen_ai.conversation.id` on the root.
 *   - `ensureTurn` sees a session change and mints a fresh turn, so the
 *     interleaved session's pending + deferred spans are discarded
 *     wholesale rather than merely delayed.
 *
 * The first `describe` below is the cross-session reproduction: it was
 * written against the pre-shard implementation and failed there (both
 * cases), which is what makes it a regression pin rather than a
 * tautology. The second pins the sanitisation contract — the shard key
 * comes from host-controlled input, so it must not be able to escape the
 * state directory.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { dispatchCollectorEvent } from '../scripts/lib/collector-core.js';
import {
  statePath, loadState, saveState, discardState, takeAbandonedShards,
  type CollectorState,
} from '../scripts/lib/traces-state-store.js';
import type { ResolvedMetricsConfig, CollectorLogsConfig } from '../adapters/common.js';
import { makeInMemoryTracer } from './helpers/tracer.js';
import { trackTempDir } from './helpers/tmp-dirs.js';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-node';

function freshLogsConfig(): CollectorLogsConfig {
  const dir = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-state-isolation-')));
  return { enabled: true, local: true, path: join(dir, 'audit.jsonl'), max_size_mb: 100 };
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

function turnRoots(spans: readonly ReadableSpan[]): readonly ReadableSpan[] {
  return spans.filter((s) => s.attributes['gen_ai.operation.name'] === 'invoke_agent');
}

// ── Cross-session isolation ───────────────────────────────────────────

describe('traces state store: two concurrent sessions do not cross-contaminate', () => {
  it('each session closes its own turn, with its own trace id and conversation id', async () => {
    const logsConfig = freshLogsConfig();
    const tracer = makeInMemoryTracer();
    const common = {
      platform: 'claude-code',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: tracer.provider,
      logsConfig,
    } as const;

    // Interleaved exactly the way two host windows interleave: each
    // session opens a turn, then each closes it.
    await dispatchCollectorEvent({
      ...common,
      event: 'UserPromptSubmit',
      input: { session_id: 'sess-A', cwd: '/tmp/a', prompt: 'prompt from A' },
    });
    await dispatchCollectorEvent({
      ...common,
      event: 'UserPromptSubmit',
      input: { session_id: 'sess-B', cwd: '/tmp/b', prompt: 'prompt from B' },
    });

    const traceA = loadState(logsConfig, 'sess-A')?.turn_trace_id;
    const traceB = loadState(logsConfig, 'sess-B')?.turn_trace_id;
    assert.ok(traceA, 'session A must have an open turn of its own');
    assert.ok(traceB, 'session B must have an open turn of its own');
    assert.notEqual(traceA, traceB, 'the two sessions must not share a turn trace id');

    await dispatchCollectorEvent({
      ...common,
      event: 'Stop',
      input: { session_id: 'sess-A', cwd: '/tmp/a' },
    });
    await dispatchCollectorEvent({
      ...common,
      event: 'Stop',
      input: { session_id: 'sess-B', cwd: '/tmp/b' },
    });

    const roots = turnRoots(tracer.finished());
    assert.equal(roots.length, 2, `expected exactly one turn root per session, got ${roots.length}`);

    const rootA = roots.find((s) => s.attributes['gen_ai.conversation.id'] === 'sess-A');
    const rootB = roots.find((s) => s.attributes['gen_ai.conversation.id'] === 'sess-B');
    assert.ok(rootA, 'session A must export a turn root carrying its OWN conversation id');
    assert.ok(rootB, 'session B must export a turn root carrying its OWN conversation id');

    // The mis-attribution this whole change exists to prevent: A's turn
    // must go out on A's trace, not on whichever session wrote the
    // shared file last.
    assert.equal(rootA.spanContext().traceId, traceA, 'A\'s turn root must use A\'s trace id');
    assert.equal(rootB.spanContext().traceId, traceB, 'B\'s turn root must use B\'s trace id');
    assert.equal(
      rootA.attributes['nio.turn.user_prompt'], 'prompt from A',
      'A\'s turn root must carry A\'s prompt, not the other session\'s',
    );
    assert.equal(rootB.attributes['nio.turn.user_prompt'], 'prompt from B');
  });

  it('an interleaved session does not discard the other session\'s pending tool span', async () => {
    const logsConfig = freshLogsConfig();
    const tracer = makeInMemoryTracer();
    const common = {
      platform: 'claude-code',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: tracer.provider,
      logsConfig,
    } as const;

    await dispatchCollectorEvent({
      ...common,
      event: 'PreToolUse',
      input: {
        session_id: 'sess-A', cwd: '/tmp/a',
        tool_name: 'Bash', tool_input: { command: 'echo a' }, tool_use_id: 'call-a',
      },
    });
    // B interleaves between A's pre and A's post — the shared-file
    // failure mode: ensureTurn saw a session change and reset
    // pending_spans, so A's post could never find its pending entry.
    await dispatchCollectorEvent({
      ...common,
      event: 'PreToolUse',
      input: {
        session_id: 'sess-B', cwd: '/tmp/b',
        tool_name: 'Read', tool_input: { file_path: '/x' }, tool_use_id: 'call-b',
      },
    });
    await dispatchCollectorEvent({
      ...common,
      event: 'PostToolUse',
      input: {
        session_id: 'sess-A', cwd: '/tmp/a',
        tool_name: 'Bash', tool_input: { command: 'echo a' },
        tool_use_id: 'call-a', tool_response: { output: 'a' },
      },
    });

    // A's post must have FOUND A's pending entry. The probe is the
    // exported span: with the shared file, `ensureTurn` saw a session
    // change on B's event and reset `pending_spans`, so A's post got
    // `durationMs: null` and emitted nothing at all.
    const toolSpansA = tracer.finished().filter((s) => s.name === 'execute_tool Bash');
    assert.equal(
      toolSpansA.length, 1,
      'A\'s closed tool span must be exported off A\'s own state, not lost to B\'s reset',
    );
    assert.equal(
      toolSpansA[0]!.attributes['gen_ai.tool.call.id'], 'call-a',
      'and it must be A\'s call, not B\'s',
    );
    assert.deepEqual(
      loadState(logsConfig, 'sess-A')?.deferred_spans ?? [], [],
      'nothing is parked: the span left at PostToolUse (see eager-tool-spans.test.ts)',
    );

    // And B's own pending span is untouched by A's post.
    const stateB = loadState(logsConfig, 'sess-B');
    assert.ok(stateB?.pending_spans['call-b'], 'B\'s pending span must survive A\'s PostToolUse');
  });
});

// ── Shard-key sanitisation ────────────────────────────────────────────

describe('statePath: the session id is untrusted input', () => {
  const cfg: CollectorLogsConfig = { path: '/tmp/nio-shard-fixture/audit.jsonl' };
  const STATE_DIR = '/tmp/nio-shard-fixture';

  const hostile = [
    '../../../etc/passwd',
    '..',
    '.',
    'a/b/c',
    '/absolute/id',
    'id\0.json',
    'id\nwith\nnewlines',
    'id with spaces',
    '~',
    'C:\\windows\\system32',
    '\u202e' + 'gnp.exe',
    'x'.repeat(4096),
    '',
  ];

  for (const id of hostile) {
    it(`keeps ${JSON.stringify(id.slice(0, 32))} inside the state directory`, () => {
      const p = statePath(cfg, id);
      assert.equal(dirname(p), STATE_DIR, `path escaped the state dir: ${p}`);
      assert.match(
        basename(p),
        /^traces-state-store-[A-Za-z0-9_-]*-[0-9a-f]{12}\.json$/,
        `unexpected shard filename: ${basename(p)}`,
      );
      // A filesystem cannot hold a NUL in a name; if one survived
      // sanitisation every write for that session would throw.
      assert.ok(!p.includes('\0'), 'NUL byte survived sanitisation');
      assert.ok(basename(p).length <= 255, 'shard filename exceeds the POSIX NAME_MAX');
    });
  }

  it('is stable for one id and distinct across ids', () => {
    assert.equal(statePath(cfg, 'sess-1'), statePath(cfg, 'sess-1'));
    assert.notEqual(statePath(cfg, 'sess-1'), statePath(cfg, 'sess-2'));
  });

  it('distinguishes ids that sanitise to the same slug', () => {
    // `a/b` and `a:b` both slug to `a_b`; the digest suffix is what
    // stops them colliding onto one file.
    assert.notEqual(statePath(cfg, 'a/b'), statePath(cfg, 'a:b'));
  });
});

// ── Legacy (unsharded) file migration ─────────────────────────────────

describe('traces state store: the pre-shard traces-state-store.json', () => {
  function legacyPath(logsConfig: CollectorLogsConfig): string {
    return join(dirname(logsConfig.path!), 'traces-state-store.json');
  }

  const legacyState = (sessionId: string): CollectorState => ({
    session_id: sessionId,
    turn_number: 2,
    turn_trace_id: 'd'.repeat(32),
    turn_start_ms: 1700000000000,
    pending_spans: { 'call-legacy': { tool_name: 'Bash', tool_summary: 'ls', start_ms: 1, span_id: 'e'.repeat(16) } },
    pending_task_spans: {},
  });

  it('is adopted once by the session that owns it, then removed', () => {
    const logsConfig = freshLogsConfig();
    writeFileSync(legacyPath(logsConfig), JSON.stringify(legacyState('sess-owner')), 'utf-8');

    const loaded = loadState(logsConfig, 'sess-owner');
    assert.equal(loaded?.turn_trace_id, 'd'.repeat(32), 'the in-flight turn must survive the upgrade');
    assert.ok(loaded?.pending_spans['call-legacy'], 'the pending pre/post bridge must survive too');
    assert.ok(!existsSync(legacyPath(logsConfig)), 'the legacy file must be removed once adopted');

    // Adoption is one-shot: a second read comes from the shard (still
    // empty until something saves), never from the legacy file again.
    assert.equal(loadState(logsConfig, 'sess-owner'), null);
  });

  it('is never adopted by a different session, and is left in place for its owner', () => {
    const logsConfig = freshLogsConfig();
    writeFileSync(legacyPath(logsConfig), JSON.stringify(legacyState('sess-owner')), 'utf-8');

    assert.equal(
      loadState(logsConfig, 'sess-other'), null,
      'adopting another session\'s legacy state would re-create the exact mixing sharding removes',
    );
    assert.ok(
      existsSync(legacyPath(logsConfig)),
      'a legacy file that was not adopted must be left for the session that owns it',
    );
  });

  it('does not shadow a shard that already exists', () => {
    const logsConfig = freshLogsConfig();
    saveState(logsConfig, { ...legacyState('sess-owner'), turn_number: 99 }, 'sess-owner');
    writeFileSync(legacyPath(logsConfig), JSON.stringify(legacyState('sess-owner')), 'utf-8');

    assert.equal(loadState(logsConfig, 'sess-owner')?.turn_number, 99);
    assert.ok(existsSync(legacyPath(logsConfig)), 'an unread legacy file must not be deleted');
  });

  it('survives a corrupt legacy file without throwing', () => {
    const logsConfig = freshLogsConfig();
    writeFileSync(legacyPath(logsConfig), '{not json', 'utf-8');
    assert.equal(loadState(logsConfig, 'sess-owner'), null);
  });
});

// ── Shard lifecycle ───────────────────────────────────────────────────
//
// Sharding replaces one reused file with one file per session, so
// something has to collect them or `~/.nio` grows without bound. Two
// legs: `discardState` for sessions that end cleanly (SessionEnd), and
// `takeAbandonedShards` for the ones whose host was killed first.

describe('traces state store: shards are not left behind forever', () => {
  const blank = (sessionId: string): CollectorState => ({
    session_id: sessionId,
    turn_number: 1,
    turn_trace_id: '',
    turn_start_ms: 0,
    pending_spans: {},
    pending_task_spans: {},
  });

  function shardCount(logsConfig: CollectorLogsConfig): number {
    return readdirSync(dirname(logsConfig.path!))
      .filter((f) => f.startsWith('traces-state-store-')).length;
  }

  it('discardState removes exactly the named session\'s shard', () => {
    const logsConfig = freshLogsConfig();
    saveState(logsConfig, blank('sess-x'), 'sess-x');
    saveState(logsConfig, blank('sess-y'), 'sess-y');
    assert.equal(shardCount(logsConfig), 2);

    discardState(logsConfig, 'sess-x');

    assert.ok(!existsSync(statePath(logsConfig, 'sess-x')), 'the named shard must go');
    assert.ok(existsSync(statePath(logsConfig, 'sess-y')), 'no other shard may be touched');
  });

  it('SessionEnd drops the session\'s shard rather than leaving it behind', async () => {
    const logsConfig = freshLogsConfig();
    const tracer = makeInMemoryTracer();
    const common = {
      platform: 'claude-code', config: baseConfig, meterProvider: null,
      tracerProvider: tracer.provider, logsConfig,
    } as const;

    await dispatchCollectorEvent({
      ...common, event: 'SessionStart', input: { session_id: 'sess-end-gc' },
    });
    assert.equal(shardCount(logsConfig), 1, 'SessionStart must create the shard');

    await dispatchCollectorEvent({
      ...common, event: 'SessionEnd', input: { session_id: 'sess-end-gc', cwd: '/tmp' },
    });
    assert.equal(shardCount(logsConfig), 0, 'a cleanly-ended session must not leave a shard behind');
  });

  it('an hour of silence salvages nothing and DELETES nothing — that leg is the 7-day GC', () => {
    const logsConfig = freshLogsConfig();
    saveState(logsConfig, blank('sess-idle'), 'sess-idle');
    saveState(logsConfig, blank('sess-live'), 'sess-live');
    saveState(logsConfig, blank('sess-me'), 'sess-me');

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(statePath(logsConfig, 'sess-idle'), twoHoursAgo, twoHoursAgo);
    // 'sess-me' is stale too, to prove the current session is excluded by
    // identity rather than merely by being freshly written.
    utimesSync(statePath(logsConfig, 'sess-me'), twoHoursAgo, twoHoursAgo);

    const claimed = takeAbandonedShards(logsConfig, 'sess-me');

    assert.deepEqual(claimed, [], 'these shards carry no deferred spans, so nothing is salvaged');
    assert.ok(
      existsSync(statePath(logsConfig, 'sess-idle')),
      'an hour of silence is not proof of death — deleting here is what cost idle-but-alive ' +
      'sessions their session_trace_id and their turn continuity',
    );
    assert.ok(existsSync(statePath(logsConfig, 'sess-live')), 'a live shard must survive');
    assert.ok(existsSync(statePath(logsConfig, 'sess-me')), 'the caller\'s own shard is never claimed');
  });

  it('a shard untouched for a week is garbage-collected', () => {
    const logsConfig = freshLogsConfig();
    saveState(logsConfig, blank('sess-ancient'), 'sess-ancient');
    saveState(logsConfig, blank('sess-recent'), 'sess-recent');

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(statePath(logsConfig, 'sess-ancient'), eightDaysAgo, eightDaysAgo);
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
    utimesSync(statePath(logsConfig, 'sess-recent'), sixDaysAgo, sixDaysAgo);

    takeAbandonedShards(logsConfig, 'sess-me');

    assert.ok(
      !existsSync(statePath(logsConfig, 'sess-ancient')),
      'without a GC leg the state directory grows one file per session forever',
    );
    assert.ok(
      existsSync(statePath(logsConfig, 'sess-recent')),
      'six days is inside the GC window',
    );
  });

  it('garbage-collects a corrupt shard once it is a week old, but not before', () => {
    const logsConfig = freshLogsConfig();
    saveState(logsConfig, blank('sess-corrupt-old'), 'sess-corrupt-old');
    saveState(logsConfig, blank('sess-corrupt-new'), 'sess-corrupt-new');
    writeFileSync(statePath(logsConfig, 'sess-corrupt-old'), '{ not json', 'utf-8');
    writeFileSync(statePath(logsConfig, 'sess-corrupt-new'), '{ not json', 'utf-8');

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(statePath(logsConfig, 'sess-corrupt-old'), eightDaysAgo, eightDaysAgo);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(statePath(logsConfig, 'sess-corrupt-new'), twoHoursAgo, twoHoursAgo);

    takeAbandonedShards(logsConfig, 'sess-me');

    assert.ok(!existsSync(statePath(logsConfig, 'sess-corrupt-old')));
    assert.ok(
      existsSync(statePath(logsConfig, 'sess-corrupt-new')),
      'an unparseable shard an hour old may simply be a live session caught mid-write',
    );
  });
});
