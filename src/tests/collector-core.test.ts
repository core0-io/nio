// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  dispatchCollectorEvent,
  toolSummary,
  spanKey,
  type HookStdinPayload,
} from '../scripts/lib/collector-core.js';
import type { ResolvedMetricsConfig, CollectorLogsConfig } from '../adapters/common.js';
import type { MeterProvider } from '@opentelemetry/sdk-metrics';

// Each test gets its own tmpdir + audit file; we never delete — OS reaps
// /tmp. Keeps the test file free of fs-destructive calls that Nio's own
// Phase 4 behavioural analyser would (correctly) flag.

function freshFixture(): { auditPath: string; logsConfig: CollectorLogsConfig } {
  const dir = mkdtempSync(join(tmpdir(), 'nio-collector-core-'));
  const auditPath = join(dir, 'audit.jsonl');
  return {
    auditPath,
    logsConfig: { enabled: true, local: true, path: auditPath, max_size_mb: 100 },
  };
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

function readEntries(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * Close the turn so the deferred tool spans are exported.
 *
 * Tool spans are held in `deferred_spans` until end of turn — they can
 * only be nested under the LLM call that issued them, and that is not
 * knowable at PostToolUse time. Every assertion about an exported tool
 * span therefore has to run a turn boundary first.
 */
async function flushTurn(
  sessionId: string,
  platform: string,
  logsConfig: CollectorLogsConfig,
  tracerProvider: unknown,
): Promise<void> {
  await dispatchCollectorEvent({
    event: 'Stop',
    input: { session_id: sessionId },
    platform,
    config: baseConfig,
    meterProvider: null,
    tracerProvider: tracerProvider as never,
    logsConfig,
  });
}

/** Exported tool spans only — drops the turn root emitted by `flushTurn`. */
function toolSpans<T extends { name: string }>(spans: readonly T[]): T[] {
  return spans.filter((s) => s.name.startsWith('execute_tool '));
}

// ── toolSummary — cross-platform tool-name recognition ────────────────

describe('collector-core: toolSummary', () => {
  it('extracts command for Claude Code Bash', () => {
    assert.equal(toolSummary('Bash', { command: 'ls /tmp' }), 'ls /tmp');
  });

  it('extracts file_path for Claude Code Write / Edit', () => {
    assert.equal(toolSummary('Write', { file_path: '/x.js' }), '/x.js');
    assert.equal(toolSummary('Edit', { path: '/y.js' }), '/y.js');
  });

  it('extracts url for Claude Code WebFetch / WebSearch', () => {
    assert.equal(toolSummary('WebFetch', { url: 'https://example.com' }), 'https://example.com');
    assert.equal(toolSummary('WebSearch', { query: 'nio' }), 'nio');
  });

  it('extracts command for Hermes terminal / exec / shell', () => {
    assert.equal(toolSummary('terminal', { command: 'ls' }), 'ls');
    assert.equal(toolSummary('exec', { command: 'ls' }), 'ls');
    assert.equal(toolSummary('shell', { command: 'ls' }), 'ls');
  });

  it('extracts path for Hermes write_file / patch / read_file', () => {
    assert.equal(toolSummary('write_file', { path: '/x.py' }), '/x.py');
    assert.equal(toolSummary('patch', { file_path: '/y.py' }), '/y.py');
    assert.equal(toolSummary('read_file', { path: '/z.py' }), '/z.py');
  });

  it('extracts url for Hermes fetch / http_request', () => {
    assert.equal(toolSummary('fetch', { url: 'https://api.example.com' }), 'https://api.example.com');
  });

  it('falls back to JSON for unknown tools', () => {
    const s = toolSummary('mystery_tool', { foo: 'bar', n: 1 });
    assert.ok(s.includes('foo') && s.includes('bar'));
  });

  it('truncates long summaries to 300 chars', () => {
    const long = 'x'.repeat(500);
    assert.equal(toolSummary('Bash', { command: long }).length, 300);
  });
});

// ── spanKey ────────────────────────────────────────────────────────────

describe('collector-core: spanKey', () => {
  it('prefers tool_use_id when provided', () => {
    const key = spanKey({ tool_use_id: 'tc-123', tool_name: 'Bash' } as HookStdinPayload);
    assert.equal(key, 'tc-123');
  });

  it('falls back to tool_name:tool_summary when tool_use_id absent', () => {
    const k = spanKey({ tool_name: 'Bash', tool_input: { command: 'ls /tmp' } } as HookStdinPayload);
    assert.equal(k, 'Bash:ls /tmp');
  });

  it('fallback is DETERMINISTIC — same inputs produce the same key', () => {
    // Pre/post bridge depends on this. Old impl used Date.now() so the
    // fallback diverged between pre and post invocations.
    const a = spanKey({ tool_name: 'terminal', tool_input: { command: 'date -u' } } as HookStdinPayload);
    const b = spanKey({ tool_name: 'terminal', tool_input: { command: 'date -u' } } as HookStdinPayload);
    assert.equal(a, b);
  });

  it('handles fully empty input', () => {
    const k = spanKey({} as HookStdinPayload);
    assert.ok(k.startsWith('unknown:'));
  });
});

// ── dispatchCollectorEvent — audit routing (no OTLP) ───────────────────

describe('collector-core: dispatchCollectorEvent → audit.jsonl', () => {
  it('writes a PreToolUse audit entry tagged with platform', async () => {
    const { auditPath, logsConfig } = freshFixture();
    await dispatchCollectorEvent({
      event: 'PreToolUse',
      input: {
        tool_name: 'terminal',
        tool_input: { command: 'ls' },
        session_id: 'sess-a',
        tool_use_id: 'call-1',
        cwd: '/tmp',
      },
      platform: 'hermes',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: null,
      logsConfig,
    });
    const entries = readEntries(auditPath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!['platform'], 'hermes');
    assert.equal(entries[0]!['event'], 'PreToolUse');
    assert.equal(entries[0]!['tool_name'], 'terminal');
    assert.equal(entries[0]!['tool_summary'], 'ls');
    assert.equal(entries[0]!['session_id'], 'sess-a');
    assert.equal(entries[0]!['tool_use_id'], 'call-1');
  });

  it('writes a PostToolUse audit entry', async () => {
    const { auditPath, logsConfig } = freshFixture();
    await dispatchCollectorEvent({
      event: 'PostToolUse',
      input: {
        tool_name: 'terminal',
        tool_input: { command: 'ls' },
        session_id: 'sess-a',
        tool_use_id: 'call-1',
        tool_response: { output: 'ok' },
      },
      platform: 'hermes',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: null,
      logsConfig,
    });
    const entries = readEntries(auditPath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!['event'], 'PostToolUse');
  });

  it('writes a TaskCreated audit entry with task_id and task_summary', async () => {
    const { auditPath, logsConfig } = freshFixture();
    await dispatchCollectorEvent({
      event: 'TaskCreated',
      input: {
        session_id: 'sess-a',
        task_id: 'task-1',
        task_input: { prompt: 'do a thing' },
      },
      platform: 'claude-code',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: null,
      logsConfig,
    });
    const entries = readEntries(auditPath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!['event'], 'TaskCreated');
    assert.equal(entries[0]!['task_id'], 'task-1');
    assert.equal(entries[0]!['task_summary'], 'do a thing');
  });

  it('writes a TaskCompleted audit entry with task_id', async () => {
    const { auditPath, logsConfig } = freshFixture();
    await dispatchCollectorEvent({
      event: 'TaskCompleted',
      input: { session_id: 'sess-a', task_id: 'task-1' },
      platform: 'claude-code',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: null,
      logsConfig,
    });
    const entries = readEntries(auditPath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!['event'], 'TaskCompleted');
    assert.equal(entries[0]!['task_id'], 'task-1');
  });

  it('writes a Stop audit entry with session_id', async () => {
    const { auditPath, logsConfig } = freshFixture();
    await dispatchCollectorEvent({
      event: 'Stop',
      input: { session_id: 'sess-stop', cwd: '/tmp' },
      platform: 'hermes',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: null,
      logsConfig,
    });
    const entries = readEntries(auditPath);
    assert.equal(entries[0]!['event'], 'Stop');
    assert.equal(entries[0]!['session_id'], 'sess-stop');
    assert.equal(entries[0]!['platform'], 'hermes');
  });

  it('SessionEnd is accepted as a canonical event (Hermes-driven)', async () => {
    const { auditPath, logsConfig } = freshFixture();
    await dispatchCollectorEvent({
      event: 'SessionEnd',
      input: { session_id: 'sess-end' },
      platform: 'hermes',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: null,
      logsConfig,
    });
    const entries = readEntries(auditPath);
    assert.equal(entries[0]!['event'], 'SessionEnd');
  });

  it('SessionStart is accepted as a canonical event', async () => {
    const { auditPath, logsConfig } = freshFixture();
    await dispatchCollectorEvent({
      event: 'SessionStart',
      input: { session_id: 'sess-start' },
      platform: 'claude-code',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: null,
      logsConfig,
    });
    const entries = readEntries(auditPath);
    assert.equal(entries[0]!['event'], 'SessionStart');
  });

  it('silently ignores unknown event names (forward-compat)', async () => {
    const { auditPath, logsConfig } = freshFixture();
    await dispatchCollectorEvent({
      event: 'HypotheticalFutureEvent',
      input: { session_id: 'sess-x' },
      platform: 'hermes',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: null,
      logsConfig,
    });
    const entries = readEntries(auditPath);
    assert.equal(entries.length, 0, 'unknown event must not be persisted');
  });

  it('never throws on malformed input', async () => {
    const { auditPath, logsConfig } = freshFixture();
    await dispatchCollectorEvent({
      event: 'PreToolUse',
      input: {} as HookStdinPayload,
      platform: 'hermes',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: null,
      logsConfig,
    });
    const entries = readEntries(auditPath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!['session_id'], 'unknown');
  });

  it('does not create a sibling metrics.jsonl (regression: writeToLog removed)', async () => {
    const { auditPath, logsConfig } = freshFixture();
    const legacyMetrics = join(dirname(auditPath), 'metrics.jsonl');
    await dispatchCollectorEvent({
      event: 'PreToolUse',
      input: { tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 's1' },
      platform: 'claude-code',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: null,
      logsConfig,
    });
    assert.equal(existsSync(legacyMetrics), false,
      'hook events must not flow into the misnamed metrics.jsonl any more');
    assert.ok(existsSync(auditPath));
  });
});

// ── PostToolUse drains pending_guard_attrs onto the closing span ────────

describe('collector-core: PostToolUse drains pending_guard_attrs', () => {
  it('merges guard attrs parked by the guard-hook process into the tool span', async () => {
    const { makeInMemoryTracer } = await import('./helpers/tracer.js');
    const { setPendingGuardAttrs, ensureTurn } = await import('../scripts/lib/traces-collector.js');
    const { loadState, saveState } = await import('../scripts/lib/traces-state-store.js');
    const { spanKey: spanKeyFn } = await import('../scripts/lib/collector-core.js');

    const { auditPath, logsConfig } = freshFixture();
    const tracer = makeInMemoryTracer();

    const sessionId = 'sess-guard-bridge';
    const toolUseId = 'tc-guard-1';
    const preInput: HookStdinPayload = {
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
      session_id: sessionId,
      tool_use_id: toolUseId,
      cwd: '/tmp',
    };

    // Pre: open the pending span via the real collector path.
    await dispatchCollectorEvent({
      event: 'PreToolUse',
      input: preInput,
      platform: 'claude-code',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: tracer.provider,
      logsConfig,
    });

    // Simulate the separate guard-hook process parking guard attrs.
    const key = spanKeyFn(preInput);
    let s = ensureTurn(loadState(logsConfig), sessionId);
    s = setPendingGuardAttrs(s, key, {
      'nio.guard.decision': 'allow',
      'nio.guard.risk_level': 'medium',
      'nio.guard.risk_score': 0.4,
      'nio.guard.eval_ms': 7,
    });
    saveState(logsConfig, s);

    // Post: close the span. Guard attrs should be drained + merged in.
    await dispatchCollectorEvent({
      event: 'PostToolUse',
      input: {
        ...preInput,
        tool_response: { output: 'hi' },
      },
      platform: 'claude-code',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: tracer.provider,
      logsConfig,
    });

    assert.equal(tracer.finished().length, 0, 'the tool span waits for the turn to end');
    await flushTurn(sessionId, 'claude-code', logsConfig, tracer.provider);

    const spans = toolSpans(tracer.finished());
    assert.equal(spans.length, 1, 'exactly one tool span exported');
    const attrs = spans[0]!.attributes as Record<string, unknown>;
    assert.equal(attrs['nio.guard.decision'], 'allow');
    assert.equal(attrs['nio.guard.risk_level'], 'medium');
    assert.equal(attrs['nio.guard.risk_score'], 0.4);
    assert.equal(attrs['nio.guard.eval_ms'], 7);

    // And the state file should no longer carry the drained entry.
    const after = loadState(logsConfig);
    assert.equal(after?.pending_guard_attrs?.[key], undefined);

    // Do NOT shutdown — the global tracer is shared across tests, and
    // shutting it down here would break later tests that re-register.

    void auditPath;
  });

  it('PostToolUse falls back to composite key when pre saved without tool_use_id (Hermes asymmetry)', async () => {
    // Hermes ships `pre_tool_call` without `tool_call_id` (its
    // invoke_tool() path forgets to thread it). post_tool_call DOES
    // include the real tool_call_id. Without composite-fallback, the
    // post side computes spanKey(tool_use_id="call_xyz") and misses
    // the pre's entry under spanKey="terminal:date -u".
    const { makeInMemoryTracer } = await import('./helpers/tracer.js');
    const { auditPath, logsConfig } = freshFixture();
    const tracer = makeInMemoryTracer();

    const sessionId = 'hermes-async-sess';

    // PRE: simulate Hermes payload — has tool_name + tool_input but NO tool_use_id.
    await dispatchCollectorEvent({
      event: 'PreToolUse',
      input: {
        tool_name: 'terminal',
        tool_input: { command: 'date -u' },
        session_id: sessionId,
        // tool_use_id intentionally absent
      },
      platform: 'hermes',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: tracer.provider,
      logsConfig,
    });

    // POST: simulate Hermes post_tool_call payload — now WITH tool_use_id.
    await dispatchCollectorEvent({
      event: 'PostToolUse',
      input: {
        tool_name: 'terminal',
        tool_input: { command: 'date -u' },
        session_id: sessionId,
        tool_use_id: 'call_LLMassigned',  // present here but not in pre
        tool_response: { output: '2026-05-28T11:00:00Z' },
      },
      platform: 'hermes',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: tracer.provider,
      logsConfig,
    });

    await flushTurn(sessionId, 'hermes', logsConfig, tracer.provider);

    const spans = toolSpans(tracer.finished());
    assert.equal(spans.length, 1, 'one execute_tool span should be emitted via composite fallback');
    assert.equal(spans[0]!.name, 'execute_tool terminal');

    void auditPath;
  });
});

// ── Deny-path one-shot emit (guard-hook / hermes hook-cli pattern) ─────

describe('deny-path one-shot span emit', () => {
  it('emits a complete tool span with ERROR status, deny attrs, guard.eval_ms, and a real start time', async () => {
    const { makeInMemoryTracer } = await import('./helpers/tracer.js');
    const {
      ensureTurn, recordPreToolUse, recordPostToolUse,
      nioGuardAttributes, genAiToolCallInputAttributes,
    } = await import('../scripts/lib/traces-collector.js');

    const tracer = makeInMemoryTracer();

    // Simulate what guard-hook does on deny: time eval, build guardAttrs,
    // open + close + flush a single span with the real eval-start time.
    const evalStartMs = Date.now() - 50;  // pretend eval took ~50 ms
    const evalMs = Date.now() - evalStartMs;
    const guardAttrs = {
      ...nioGuardAttributes('deny', 'critical', 1.0, ['BASH_RMRF'], 2, 'BASH_RMRF'),
      'nio.guard.eval_ms': evalMs,
    };

    let state = ensureTurn(null, 'sess-deny');
    const key = 'tc-deny-1';
    state = recordPreToolUse(
      state, key, 'Bash', 'rm -rf /',
      genAiToolCallInputAttributes({ command: 'rm -rf /' }, key),
      evalStartMs,
    );
    const r = await recordPostToolUse(
      tracer.provider, state, key, '/tmp',
      guardAttrs,
      'Blocked by Nio: critical risk',
    );
    state = r.state;

    const spans = tracer.finished();
    assert.equal(spans.length, 1);
    const span = spans[0]!;
    assert.equal(span.name, 'execute_tool Bash');
    assert.equal(span.status.code, 2, 'span status should be ERROR (SpanStatusCode.ERROR=2)');
    assert.match(String(span.status.message), /Blocked by Nio/);

    const attrs = span.attributes as Record<string, unknown>;
    assert.equal(attrs['nio.guard.decision'], 'deny');
    assert.equal(attrs['nio.guard.risk_level'], 'critical');
    assert.equal(attrs['nio.guard.risk_score'], 1.0);
    assert.equal(attrs['nio.guard.risk_tags'], 'BASH_RMRF');
    assert.equal(attrs['nio.guard.phase_stopped'], 2);
    assert.equal(attrs['nio.guard.top_finding_rule'], 'BASH_RMRF');
    assert.ok(typeof attrs['nio.guard.eval_ms'] === 'number' && (attrs['nio.guard.eval_ms'] as number) >= 0);

    // Wall-clock should reflect the real eval window (start at evalStartMs).
    // hrTime is [sec, nanos] — convert to ms.
    const spanStartMs = span.startTime[0] * 1000 + Math.round(span.startTime[1] / 1_000_000);
    assert.ok(
      Math.abs(spanStartMs - evalStartMs) <= 5,
      `span start (${spanStartMs}) should be within ~5ms of evalStartMs (${evalStartMs})`,
    );

    // Pending entry should have been drained.
    assert.equal(state.pending_spans[key], undefined);

    // Do NOT shutdown — the global tracer is shared across tests, and
    // shutting it down here would break later tests that re-register.
  });
});

// ── SessionEnd after Stop must not mint a phantom empty turn ──────────
//
// Regression test for a bug introduced (and fixed in the same pass) while
// wiring SessionEnd cleanup: Stop / SubagentStop / SessionEnd share one
// branch in dispatchCollectorEvent. That branch used to call
// `ensureTurn(prev, sessionId)` unconditionally — which MINTS a fresh
// turn when the previous one was already closed (turn_trace_id === '').
// On any platform that fires more than one of these events for the same
// session (Claude Code fires both Stop and SessionEnd), the second event
// would manufacture an empty turn and `endTurn` would immediately export
// it as a real "invoke_agent UserPromptSubmit" span with no children and
// no user prompt, plus an extra `nio.turn.count` increment. Neither
// represents a real turn boundary.

describe('collector-core: SessionEnd after Stop does not mint a phantom turn', () => {
  it('SessionEnd immediately following Stop on the same session emits no extra span and does not bump nio.turn.count', async () => {
    const { makeInMemoryTracer } = await import('./helpers/tracer.js');
    const { logsConfig } = freshFixture();
    const tracer = makeInMemoryTracer();

    const sessionId = 'sess-phantom-turn';

    // Fake meter that only counts adds against the turn-count instrument
    // by name — recordToolUse (fired by PreToolUse below) creates its own
    // separate 'nio.tool_use.count' counter and must not be conflated
    // with 'nio.turn.count'.
    let turnCounterAdds = 0;
    const fakeMeterProvider = {
      getMeter: () => ({
        createCounter: (name: string) => ({
          add: (n: number) => {
            if (name === 'nio.turn.count') turnCounterAdds += n;
          },
        }),
        createHistogram: () => ({ record: () => {} }),
      }),
      forceFlush: async () => {},
    } as unknown as MeterProvider;

    // PreToolUse opens a turn (real activity) but is never closed by a
    // matching PostToolUse before Stop fires — mirrors the review's own
    // repro (PreToolUse → Stop → SessionEnd).
    await dispatchCollectorEvent({
      event: 'PreToolUse',
      input: {
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
        session_id: sessionId,
        tool_use_id: 'call-1',
        cwd: '/tmp',
      },
      platform: 'claude-code',
      config: baseConfig,
      meterProvider: fakeMeterProvider,
      tracerProvider: tracer.provider,
      logsConfig,
    });

    // Stop closes the real turn: exactly one span, one turn-count tick.
    await dispatchCollectorEvent({
      event: 'Stop',
      input: { session_id: sessionId, cwd: '/tmp' },
      platform: 'claude-code',
      config: baseConfig,
      meterProvider: fakeMeterProvider,
      tracerProvider: tracer.provider,
      logsConfig,
    });

    const spansAfterStop = tracer.finished().length;
    const turnCountAfterStop = turnCounterAdds;
    assert.equal(spansAfterStop, 1, 'Stop should close exactly one turn span');
    assert.equal(turnCountAfterStop, 1, 'Stop should bump nio.turn.count exactly once');

    // SessionEnd fires right after, same session, no activity in between
    // (Claude Code's hooks.json now registers both Stop and SessionEnd
    // pointing at collector-hook.js).
    await dispatchCollectorEvent({
      event: 'SessionEnd',
      input: { session_id: sessionId, cwd: '/tmp' },
      platform: 'claude-code',
      config: baseConfig,
      meterProvider: fakeMeterProvider,
      tracerProvider: tracer.provider,
      logsConfig,
    });

    assert.equal(
      tracer.finished().length, spansAfterStop,
      'SessionEnd after an already-closed turn must not emit a phantom empty turn span',
    );
    assert.equal(
      turnCounterAdds, turnCountAfterStop,
      'SessionEnd after an already-closed turn must not bump nio.turn.count',
    );

    // Do NOT shutdown — the global tracer is shared across tests, and
    // shutting it down here would break later tests that re-register.
  });
});

// ── resolveSpanKey — concurrent same-signature composite calls ────────
//
// Two or more in-flight calls that share tool_name + tool_summary (the
// Hermes composite-key case: pre lacks tool_use_id, post has one but it
// was never recorded against any pending entry) get suffixed keys from
// allocateSpanKey (`terminal:ls`, `terminal:ls#2`, …). resolveSpanKey
// must be able to find the `#N` entries too, not just the unsuffixed
// base — see review I1.
//
// No id crosses the pre/post boundary in this fallback path, so nothing
// here can recover which physical call a given post response *truly*
// belongs to when completion order doesn't match allocation order. The
// guaranteed contract is narrower than "always correct": every post, in
// any arrival order, resolves to a DIFFERENT still-open entry — no span
// is silently dropped, and pending_spans always drains back to empty.

describe('collector-core: resolveSpanKey — concurrent same-signature composite calls', () => {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  function pre(sessionId: string): HookStdinPayload {
    return {
      tool_name: 'terminal',
      tool_input: { command: 'ls' },
      session_id: sessionId,
      // tool_use_id intentionally absent — mirrors Hermes's pre_tool_call.
    };
  }

  function post(sessionId: string, tag: string): HookStdinPayload {
    return {
      tool_name: 'terminal',
      tool_input: { command: 'ls' },
      session_id: sessionId,
      // Present here (mirrors Hermes's post_tool_call), but unrelated to
      // any pending key since pre never recorded one.
      tool_use_id: `call_${tag}`,
      tool_response: { output: tag },
    };
  }

  function spanStartMs(span: { startTime: readonly [number, number] }): number {
    return span.startTime[0] * 1000 + Math.round(span.startTime[1] / 1_000_000);
  }

  it('FIFO completion: both concurrent spans are emitted with correct, distinct durations; pending_spans drains empty', async () => {
    const { makeInMemoryTracer } = await import('./helpers/tracer.js');
    const { loadState } = await import('../scripts/lib/traces-state-store.js');
    const { logsConfig } = freshFixture();
    const tracer = makeInMemoryTracer();
    const sessionId = 'sess-fifo';

    await dispatchCollectorEvent({
      event: 'PreToolUse', input: pre(sessionId), platform: 'hermes',
      config: baseConfig, meterProvider: null, tracerProvider: tracer.provider, logsConfig,
    });
    await sleep(5);
    await dispatchCollectorEvent({
      event: 'PreToolUse', input: pre(sessionId), platform: 'hermes',
      config: baseConfig, meterProvider: null, tracerProvider: tracer.provider, logsConfig,
    });

    const mid = loadState(logsConfig);
    assert.equal(Object.keys(mid!.pending_spans).length, 2, 'two concurrent pending entries expected');
    assert.ok('terminal:ls' in mid!.pending_spans && 'terminal:ls#2' in mid!.pending_spans);

    // FIFO: the first call's post arrives first.
    await dispatchCollectorEvent({
      event: 'PostToolUse', input: post(sessionId, 'first'), platform: 'hermes',
      config: baseConfig, meterProvider: null, tracerProvider: tracer.provider, logsConfig,
    });
    await dispatchCollectorEvent({
      event: 'PostToolUse', input: post(sessionId, 'second'), platform: 'hermes',
      config: baseConfig, meterProvider: null, tracerProvider: tracer.provider, logsConfig,
    });

    const mid2 = loadState(logsConfig);
    assert.deepEqual(mid2!.pending_spans, {}, 'pending_spans must drain empty — no leaked #N entry');

    await flushTurn(sessionId, 'hermes', logsConfig, tracer.provider);
    const spans = toolSpans(tracer.finished());
    assert.equal(spans.length, 2, 'both concurrent calls must produce a span (regression: 2nd used to vanish)');

    const starts = spans.map(spanStartMs).sort((a, b) => a - b);
    assert.ok(starts[1]! > starts[0]!, 'the two spans must carry distinct start times — one per pre entry, none reused');

    const after = loadState(logsConfig);
    assert.deepEqual(after!.deferred_spans, [], 'deferred_spans must drain empty at end of turn');
  });

  it('LIFO completion: the later-processed post is not dropped, and no start time is reused across the two spans', async () => {
    const { makeInMemoryTracer } = await import('./helpers/tracer.js');
    const { loadState } = await import('../scripts/lib/traces-state-store.js');
    const { logsConfig } = freshFixture();
    const tracer = makeInMemoryTracer();
    const sessionId = 'sess-lifo';

    await dispatchCollectorEvent({
      event: 'PreToolUse', input: pre(sessionId), platform: 'hermes',
      config: baseConfig, meterProvider: null, tracerProvider: tracer.provider, logsConfig,
    });
    await sleep(5);
    await dispatchCollectorEvent({
      event: 'PreToolUse', input: pre(sessionId), platform: 'hermes',
      config: baseConfig, meterProvider: null, tracerProvider: tracer.provider, logsConfig,
    });

    // LIFO: the second call's post arrives (is processed) before the first's.
    await dispatchCollectorEvent({
      event: 'PostToolUse', input: post(sessionId, 'second'), platform: 'hermes',
      config: baseConfig, meterProvider: null, tracerProvider: tracer.provider, logsConfig,
    });
    await dispatchCollectorEvent({
      event: 'PostToolUse', input: post(sessionId, 'first'), platform: 'hermes',
      config: baseConfig, meterProvider: null, tracerProvider: tracer.provider, logsConfig,
    });

    const mid = loadState(logsConfig);
    assert.deepEqual(mid!.pending_spans, {}, 'pending_spans must drain empty even under out-of-order completion');

    await flushTurn(sessionId, 'hermes', logsConfig, tracer.provider);
    const spans = toolSpans(tracer.finished());
    assert.equal(spans.length, 2,
      'out-of-order completion must not drop the later-processed post (regression: old code returned durationMs:null for it)');

    const starts = spans.map(spanStartMs).sort((a, b) => a - b);
    assert.notEqual(starts[0], starts[1],
      'the second-processed post must not be matched onto the same start time already consumed by the first');
  });

  it('three concurrent same-signature calls all resolve to distinct spans in FIFO order', async () => {
    const { makeInMemoryTracer } = await import('./helpers/tracer.js');
    const { loadState } = await import('../scripts/lib/traces-state-store.js');
    const { logsConfig } = freshFixture();
    const tracer = makeInMemoryTracer();
    const sessionId = 'sess-triple';

    for (let i = 0; i < 3; i++) {
      await dispatchCollectorEvent({
        event: 'PreToolUse', input: pre(sessionId), platform: 'hermes',
        config: baseConfig, meterProvider: null, tracerProvider: tracer.provider, logsConfig,
      });
      await sleep(5);
    }

    const mid = loadState(logsConfig);
    assert.deepEqual(
      Object.keys(mid!.pending_spans).sort(),
      ['terminal:ls', 'terminal:ls#2', 'terminal:ls#3'],
    );

    for (const tag of ['a', 'b', 'c']) {
      await dispatchCollectorEvent({
        event: 'PostToolUse', input: post(sessionId, tag), platform: 'hermes',
        config: baseConfig, meterProvider: null, tracerProvider: tracer.provider, logsConfig,
      });
    }

    const after = loadState(logsConfig);
    assert.deepEqual(after!.pending_spans, {}, 'pending_spans must drain empty for three concurrent calls too');

    await flushTurn(sessionId, 'hermes', logsConfig, tracer.provider);
    const spans = toolSpans(tracer.finished());
    assert.equal(spans.length, 3, 'all three concurrent calls must each produce a span');

    const starts = spans.map(spanStartMs);
    assert.equal(new Set(starts).size, 3, 'all three spans must carry distinct start times');
  });
});
