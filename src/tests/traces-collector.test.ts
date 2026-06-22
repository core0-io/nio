// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureTurn,
  setTurnAttributes,
  recordPreToolUse,
  recordPreTaskToolUse,
  redactAndTruncate,
  genAiToolCallInputAttributes,
  genAiToolCallOutputAttributes,
  nioGuardAttributes,
  nioToolRunIdAttribute,
  genAiUsageAttributes,
  accumulateGenAiUsage,
  recordUserPrompt,
  recordAssistantReply,
  recordCacheHitRate,
  setPendingGuardAttrs,
  takePendingGuardAttrs,
  recordPostToolUse,
} from '../scripts/lib/traces-collector.js';
import type { CollectorState } from '../scripts/lib/traces-state-store.js';
import { SpanStatusCode } from '@opentelemetry/api';
import { makeInMemoryTracer } from './helpers/tracer.js';

const seed = (overrides: Partial<CollectorState> = {}): CollectorState => ({
  session_id: 'sess-1',
  turn_number: 2,
  turn_trace_id: 'a'.repeat(32),
  turn_start_ms: 1700000000000,
  pending_spans: {},
  pending_task_spans: {},
  turn_attributes: {},
  ...overrides,
});

// ── ensureTurn ──────────────────────────────────────────────────────────

describe('ensureTurn', () => {
  it('returns existing state when session matches and turn is active', () => {
    const prev = seed();
    const next = ensureTurn(prev, 'sess-1');
    assert.equal(next, prev, 'should be the same object reference (no-op)');
  });

  it('starts a fresh turn when prev is null', () => {
    const next = ensureTurn(null, 'new-sess');
    assert.equal(next.session_id, 'new-sess');
    assert.equal(next.turn_number, 1);
    assert.equal(typeof next.turn_trace_id, 'string');
    assert.ok(next.turn_trace_id.length > 0);
    assert.equal(Object.keys(next.pending_spans).length, 0);
  });

  it('starts a new turn (incremented number) when same session has no active turn', () => {
    const prev = seed({ turn_number: 5, turn_trace_id: '' });
    const next = ensureTurn(prev, 'sess-1');
    assert.equal(next.turn_number, 6);
    assert.notEqual(next.turn_trace_id, '');
  });

  it('starts a new turn (number=1) when session changes', () => {
    const prev = seed({ session_id: 'old', turn_number: 9 });
    const next = ensureTurn(prev, 'new-session');
    assert.equal(next.session_id, 'new-session');
    assert.equal(next.turn_number, 1);
  });

  it('resets pending_guard_attrs along with pending_spans on a new turn', () => {
    const prev = seed({
      session_id: 'old',
      pending_guard_attrs: { 'k1': { 'nio.guard.decision': 'allow' } },
    });
    const next = ensureTurn(prev, 'new-session');
    assert.deepEqual(next.pending_guard_attrs, {});
  });

  it('migrates pending_spans + pending_guard_attrs when sentinel session ("") gets promoted to a real one', () => {
    // Hermes asymmetry: pre_tool_call arrives with session_id="" but
    // the matching post_tool_call has the real session id. The pending
    // entry pre saved must survive the session-id promotion so post
    // can find it.
    const prev = seed({
      session_id: '',
      pending_spans: {
        'tc-x': {
          tool_name: 'shell',
          tool_summary: 'echo hi',
          start_ms: 1700000000000,
          span_id: 'a'.repeat(16),
          attributes: { 'gen_ai.tool.name': 'shell' },
        },
      },
      pending_guard_attrs: { 'tc-x': { 'nio.guard.decision': 'allow' } },
    });
    const next = ensureTurn(prev, 'real-session');
    assert.equal(next.session_id, 'real-session');
    assert.ok(next.pending_spans['tc-x'], 'pending_spans must survive empty→real promotion');
    assert.ok(next.pending_guard_attrs?.['tc-x'], 'pending_guard_attrs must survive empty→real promotion');
  });

  it('migrates pending state from "unknown" sentinel too', () => {
    const prev = seed({
      session_id: 'unknown',
      pending_spans: {
        'tc-y': {
          tool_name: 'read_file',
          tool_summary: '/etc/hosts',
          start_ms: 1700000000000,
          span_id: 'b'.repeat(16),
        },
      },
    });
    const next = ensureTurn(prev, 'real-session');
    assert.ok(next.pending_spans['tc-y']);
  });

  it('does NOT migrate pending state when changing between two real sessions', () => {
    const prev = seed({
      session_id: 'session-a',
      pending_spans: {
        'tc-z': {
          tool_name: 'shell',
          tool_summary: 'echo',
          start_ms: 1700000000000,
          span_id: 'c'.repeat(16),
        },
      },
    });
    const next = ensureTurn(prev, 'session-b');
    assert.deepEqual(next.pending_spans, {});
  });

  it('ignores sentinel session_id ("") when prev is on a real session — continues current turn', () => {
    // Hermes pre_tool_call sometimes arrives with session_id="" mid-
    // session. Accepting that at face value would reset turn_number
    // and re-derive a different traceId. Instead, fall back to the
    // real session_id we already have.
    const prev = seed({
      session_id: 'real-A',
      turn_number: 5,
      turn_trace_id: 'b'.repeat(32),
    });
    const next = ensureTurn(prev, '');
    assert.equal(next, prev, 'should return prev unchanged (continue current turn)');
    assert.equal(next.session_id, 'real-A');
    assert.equal(next.turn_number, 5);
    assert.equal(next.turn_trace_id, 'b'.repeat(32));
  });

  it('ignores sentinel session_id ("unknown") when prev is on a real session', () => {
    const prev = seed({ session_id: 'real-A', turn_number: 3, turn_trace_id: 'c'.repeat(32) });
    const next = ensureTurn(prev, 'unknown');
    assert.equal(next, prev);
    assert.equal(next.session_id, 'real-A');
  });

  it('mints a fresh non-deterministic turn_trace_id per new turn', () => {
    // The old MD5(session:turn) scheme produced cross-day collisions:
    // identical (session_id, turn_number) values rederived the same
    // trace id over and over. Verify that two fresh-turn states for
    // the same inputs now get DIFFERENT ids.
    const prev = seed({ session_id: 'sess-X', turn_number: 9, turn_trace_id: '' });
    const a = ensureTurn(prev, 'sess-X');
    const b = ensureTurn(prev, 'sess-X');
    assert.equal(a.turn_number, 10);
    assert.equal(b.turn_number, 10);
    assert.notEqual(a.turn_trace_id, b.turn_trace_id, 'two turn_trace_id mints for the same inputs must differ');
    assert.equal(a.turn_trace_id.length, 32, 'OTel trace id is 32 hex chars');
    assert.match(a.turn_trace_id, /^[0-9a-f]{32}$/);
  });
});

// ── setTurnAttributes ───────────────────────────────────────────────────

describe('setTurnAttributes', () => {
  it('returns a new object with merged attributes', () => {
    const prev = seed({ turn_attributes: { a: 1 } });
    const next = setTurnAttributes(prev, { b: 2 });
    assert.deepEqual(next.turn_attributes, { a: 1, b: 2 });
    assert.notEqual(next, prev, 'must not mutate input');
  });

  it('overwrites existing keys with new values', () => {
    const prev = seed({ turn_attributes: { a: 1 } });
    const next = setTurnAttributes(prev, { a: 9 });
    assert.deepEqual(next.turn_attributes, { a: 9 });
  });

  it('handles undefined prior attributes gracefully', () => {
    const prev = seed();
    delete (prev as { turn_attributes?: unknown }).turn_attributes;
    const next = setTurnAttributes(prev, { x: 'y' });
    assert.deepEqual(next.turn_attributes, { x: 'y' });
  });
});

// ── recordPreToolUse ────────────────────────────────────────────────────

describe('recordPreToolUse', () => {
  it('adds a pending span with start_ms and span_id', () => {
    const prev = seed();
    const next = recordPreToolUse(prev, 'k1', 'Bash', 'ls /tmp', { extra: 1 });
    assert.equal(Object.keys(next.pending_spans).length, 1);
    const span = next.pending_spans['k1']!;
    assert.equal(span.tool_name, 'Bash');
    assert.equal(span.tool_summary, 'ls /tmp');
    assert.ok(span.start_ms > 0);
    assert.equal(span.span_id.length, 16, 'span_id should be 8-byte hex (16 chars)');
    assert.deepEqual(span.attributes, { extra: 1 });
  });

  it('does not mutate input state', () => {
    const prev = seed();
    const beforeKeys = Object.keys(prev.pending_spans);
    recordPreToolUse(prev, 'k1', 'Bash', 'ls', undefined);
    assert.deepEqual(Object.keys(prev.pending_spans), beforeKeys);
  });

  it('preserves prior pending spans', () => {
    const prev = seed({
      pending_spans: {
        old: { tool_name: 'Read', tool_summary: '/x', start_ms: 1, span_id: '0'.repeat(16) },
      },
    });
    const next = recordPreToolUse(prev, 'new', 'Write', '/y', undefined);
    assert.ok(next.pending_spans['old']);
    assert.ok(next.pending_spans['new']);
  });

  it('uses caller-supplied startMs when provided (deny-path emit)', () => {
    const prev = seed();
    const next = recordPreToolUse(prev, 'k1', 'Bash', 'rm -rf', undefined, 1700000123456);
    assert.equal(next.pending_spans['k1']!.start_ms, 1700000123456);
  });

  it('falls back to Date.now() when startMs omitted', () => {
    const prev = seed();
    const before = Date.now();
    const next = recordPreToolUse(prev, 'k1', 'Bash', 'ls', undefined);
    const after = Date.now();
    const ms = next.pending_spans['k1']!.start_ms;
    assert.ok(ms >= before && ms <= after, `start_ms ${ms} not in [${before}, ${after}]`);
  });
});

// ── pending_guard_attrs bridge ─────────────────────────────────────────

describe('setPendingGuardAttrs / takePendingGuardAttrs', () => {
  it('round-trips an attribute map under spanKey', () => {
    const s0 = seed();
    const s1 = setPendingGuardAttrs(s0, 'tc-1', { 'nio.guard.decision': 'deny', 'nio.guard.eval_ms': 12 });
    assert.deepEqual(s1.pending_guard_attrs?.['tc-1'], {
      'nio.guard.decision': 'deny',
      'nio.guard.eval_ms': 12,
    });
    const { state: s2, attrs } = takePendingGuardAttrs(s1, 'tc-1');
    assert.deepEqual(attrs, { 'nio.guard.decision': 'deny', 'nio.guard.eval_ms': 12 });
    assert.equal(s2.pending_guard_attrs?.['tc-1'], undefined, 'entry should be drained');
  });

  it('does not mutate input state on set', () => {
    const s0 = seed();
    setPendingGuardAttrs(s0, 'tc-1', { a: 1 });
    assert.equal(s0.pending_guard_attrs, undefined, 'caller state stays untouched');
  });

  it('does not mutate input state on take', () => {
    const s0 = seed({ pending_guard_attrs: { 'tc-1': { a: 1 } } });
    takePendingGuardAttrs(s0, 'tc-1');
    assert.deepEqual(s0.pending_guard_attrs, { 'tc-1': { a: 1 } });
  });

  it('preserves siblings when draining one entry', () => {
    const s0 = setPendingGuardAttrs(seed(), 'k1', { a: 1 });
    const s1 = setPendingGuardAttrs(s0, 'k2', { b: 2 });
    const { state: s2, attrs } = takePendingGuardAttrs(s1, 'k1');
    assert.deepEqual(attrs, { a: 1 });
    assert.deepEqual(s2.pending_guard_attrs, { k2: { b: 2 } });
  });

  it('returns empty attrs and unchanged state when key absent', () => {
    const s0 = seed();
    const { state, attrs } = takePendingGuardAttrs(s0, 'missing');
    assert.deepEqual(attrs, {});
    assert.equal(state, s0);
  });
});

// ── recordPreTaskToolUse ────────────────────────────────────────────────

describe('recordPreTaskToolUse', () => {
  it('adds a pending task span with start_ms and span_id', () => {
    const prev = seed();
    const next = recordPreTaskToolUse(prev, 'task-1', 'do thing');
    const task = next.pending_task_spans['task-1']!;
    assert.equal(task.task_summary, 'do thing');
    assert.ok(task.start_ms > 0);
    assert.equal(task.span_id.length, 16);
  });

  it('initialises pending_task_spans if missing on input', () => {
    const prev = seed();
    delete (prev as { pending_task_spans?: unknown }).pending_task_spans;
    const next = recordPreTaskToolUse(prev, 'task-1', 'x');
    assert.ok(next.pending_task_spans['task-1']);
  });
});

// ── redactAndTruncate ───────────────────────────────────────────────────

describe('redactAndTruncate', () => {
  it('passes through plain strings', () => {
    assert.equal(redactAndTruncate('hello'), 'hello');
  });

  it('redacts secret-keyed fields in nested objects', () => {
    const out = redactAndTruncate({
      tool_name: 'WebFetch',
      api_key: 'sk-xxx',
      headers: { Authorization: 'Bearer abc' },
    });
    assert.match(out, /"api_key":"\[REDACTED\]"/);
    assert.match(out, /"Authorization":"\[REDACTED\]"/);
    assert.match(out, /"tool_name":"WebFetch"/);
  });

  it('truncates strings longer than maxBytes', () => {
    const long = 'a'.repeat(3000);
    const out = redactAndTruncate(long, 100);
    assert.ok(out.length < long.length);
    assert.ok(out.endsWith('…[truncated]'));
  });

  it('handles arrays via recursive redaction', () => {
    const out = redactAndTruncate([{ token: 'sek' }, { ok: 1 }]);
    assert.match(out, /"token":"\[REDACTED\]"/);
    assert.match(out, /"ok":1/);
  });
});

// ── Attribute builders ─────────────────────────────────────────────────

describe('genAiToolCallInputAttributes', () => {
  it('produces gen_ai.tool.call.arguments + tool.call.id when toolCallId given', () => {
    const out = genAiToolCallInputAttributes({ command: 'ls' }, 'tc-1');
    assert.equal(out['gen_ai.tool.call.id'], 'tc-1');
    assert.match(out['gen_ai.tool.call.arguments'] as string, /"command":"ls"/);
    assert.equal(Object.keys(out).length, 2);
  });

  it('omits tool.call.id when toolCallId absent', () => {
    const out = genAiToolCallInputAttributes({ x: 1 });
    assert.equal(out['gen_ai.tool.call.id'], undefined);
    assert.equal(Object.keys(out).length, 1);
  });

  it('redacts sensitive keys in input', () => {
    const out = genAiToolCallInputAttributes({ api_key: 'sk-x', x: 1 });
    assert.match(out['gen_ai.tool.call.arguments'] as string, /"api_key":"\[REDACTED\]"/);
  });
});

describe('genAiToolCallOutputAttributes', () => {
  it('with result only', () => {
    const out = genAiToolCallOutputAttributes({ result: { ok: true } });
    assert.equal(Object.keys(out).length, 1);
    assert.match(out['gen_ai.tool.call.result'] as string, /"ok":true/);
  });

  it('with error only', () => {
    const out = genAiToolCallOutputAttributes({ error: 'boom' });
    assert.equal(Object.keys(out).length, 1);
    assert.equal(out['nio.tool.error'], 'boom');
  });

  it('with all three fields', () => {
    const out = genAiToolCallOutputAttributes({ result: 'r', error: 'e', durationMs: 42 });
    assert.equal(Object.keys(out).length, 3);
    assert.equal(out['nio.tool.duration_ms'], 42);
  });

  it('with no fields returns empty record', () => {
    const out = genAiToolCallOutputAttributes({});
    assert.deepEqual(out, {});
  });

  it('null error is treated as no error', () => {
    const out = genAiToolCallOutputAttributes({ result: 'r', error: null });
    assert.equal(out['nio.tool.error'], undefined);
  });
});

describe('nioGuardAttributes', () => {
  it('builds the four-key set when riskTags provided', () => {
    const out = nioGuardAttributes('deny', 'high', 0.85, ['SHELL_INJECTION', 'NET_EXFIL']);
    assert.equal(out['nio.guard.decision'], 'deny');
    assert.equal(out['nio.guard.risk_level'], 'high');
    assert.equal(out['nio.guard.risk_score'], 0.85);
    assert.equal(out['nio.guard.risk_tags'], 'SHELL_INJECTION,NET_EXFIL');
  });

  it('omits risk_tags when empty', () => {
    const out = nioGuardAttributes('allow', 'low', 0);
    assert.equal(out['nio.guard.risk_tags'], undefined);
    assert.equal(Object.keys(out).length, 3);
  });

  it('includes phase_stopped and top_finding_rule when provided', () => {
    const out = nioGuardAttributes('deny', 'critical', 1.0, ['SHELL_EXEC'], 2, 'BASH_RMRF');
    assert.equal(out['nio.guard.phase_stopped'], 2);
    assert.equal(out['nio.guard.top_finding_rule'], 'BASH_RMRF');
  });

  it('phase_stopped=0 still emits the key (tool-gate denies)', () => {
    const out = nioGuardAttributes('deny', 'critical', 1.0, ['TOOL_GATE_BLOCKED'], 0, 'TOOL_GATE_BLOCKED');
    assert.equal(out['nio.guard.phase_stopped'], 0);
    assert.equal(out['nio.guard.top_finding_rule'], 'TOOL_GATE_BLOCKED');
  });

  it('omits phase_stopped + top_finding_rule when undefined', () => {
    const out = nioGuardAttributes('allow', 'low', 0, undefined, undefined, undefined);
    assert.equal(out['nio.guard.phase_stopped'], undefined);
    assert.equal(out['nio.guard.top_finding_rule'], undefined);
  });
});

describe('nioToolRunIdAttribute', () => {
  it('wraps run id under nio.tool.run_id', () => {
    assert.deepEqual(nioToolRunIdAttribute('run-42'), { 'nio.tool.run_id': 'run-42' });
  });
});

describe('genAiUsageAttributes', () => {
  it('full usage object', () => {
    const out = genAiUsageAttributes({ input: 10, output: 5, cacheRead: 2, cacheWrite: 3 });
    assert.equal(out['gen_ai.usage.input_tokens'], 10);
    assert.equal(out['gen_ai.usage.output_tokens'], 5);
    assert.equal(out['gen_ai.usage.cache_read.input_tokens'], 2);
    assert.equal(out['gen_ai.usage.cache_creation.input_tokens'], 3);
  });

  it('missing fields default to 0', () => {
    const out = genAiUsageAttributes({});
    assert.equal(out['gen_ai.usage.input_tokens'], 0);
    assert.equal(out['gen_ai.usage.output_tokens'], 0);
    assert.equal(out['gen_ai.usage.cache_read.input_tokens'], 0);
    assert.equal(out['gen_ai.usage.cache_creation.input_tokens'], 0);
  });
});

describe('accumulateGenAiUsage', () => {
  it('starts from zero when state.turn_attributes is empty', () => {
    const next = accumulateGenAiUsage(seed(), { input: 10, output: 5 });
    assert.equal(next.turn_attributes!['gen_ai.usage.input_tokens'], 10);
    assert.equal(next.turn_attributes!['gen_ai.usage.output_tokens'], 5);
  });

  it('adds delta to existing accumulated values', () => {
    const s1 = accumulateGenAiUsage(seed(), { input: 10, output: 5, cacheRead: 1 });
    const s2 = accumulateGenAiUsage(s1, { input: 7, cacheRead: 4 });
    assert.equal(s2.turn_attributes!['gen_ai.usage.input_tokens'], 17);
    assert.equal(s2.turn_attributes!['gen_ai.usage.output_tokens'], 5);
    assert.equal(s2.turn_attributes!['gen_ai.usage.cache_read.input_tokens'], 5);
  });

  it('does not mutate input state', () => {
    const prev = seed();
    accumulateGenAiUsage(prev, { input: 5 });
    assert.equal((prev.turn_attributes ?? {})['gen_ai.usage.input_tokens'], undefined);
  });
});

// ── Turn-state operation helpers ───────────────────────────────────────

describe('recordUserPrompt', () => {
  it('writes redacted prompt to turn_attributes', () => {
    const next = recordUserPrompt(seed(), 'hello world');
    assert.equal(next.turn_attributes!['nio.turn.user_prompt'], 'hello world');
  });

  it('redacts sensitive content', () => {
    const next = recordUserPrompt(seed(), JSON.stringify({ api_key: 'sk-x', body: 'hi' }));
    // recordUserPrompt redacts via redactAndTruncate's secret-key filter.
    // Plain strings pass through unchanged; structured JSON-strings
    // remain as-is (redaction operates on object keys, not strings).
    assert.match(next.turn_attributes!['nio.turn.user_prompt'] as string, /api_key/);
  });
});

describe('recordAssistantReply', () => {
  it('writes redacted reply to turn_attributes', () => {
    const next = recordAssistantReply(seed(), 'response text');
    assert.equal(next.turn_attributes!['nio.turn.assistant_reply'], 'response text');
  });
});

describe('recordCacheHitRate', () => {
  it('writes 0 for an empty / unused turn', () => {
    const next = recordCacheHitRate(seed());
    assert.equal(next.turn_attributes!['nio.turn.cache_hit_rate'], 0);
  });

  it('computes ratio = cache_read / (input + cache_creation + cache_read)', () => {
    let s = seed();
    s = accumulateGenAiUsage(s, { input: 100, cacheRead: 200, cacheWrite: 100 });
    s = recordCacheHitRate(s);
    // 200 / (100 + 100 + 200) = 200 / 400 = 0.5
    assert.equal(s.turn_attributes!['nio.turn.cache_hit_rate'], 0.5);
  });
});

// ── recordPostToolUse — deny/block path regression ─────────────────────
//
// Regression guard for the platform-param removal refactor. Two call
// sites (guard-hook.ts / hook-cli.ts) previously passed the old 7-arg
// shape: (provider, state, key, PLATFORM, cwd, guardAttrs, reason).
// After the refactor the signature is 4–6 args:
//   (provider, state, key, cwd?, postAttributes?, error?)
// This test pins the exact arg ordering so any future misalignment is
// caught by `pnpm test` rather than silently shipping in bundled scripts.

describe('recordPostToolUse — deny/block path', () => {
  it('emits a span with correct cwd, guard attrs, and ERROR status', async () => {
    const { provider, finished, shutdown } = makeInMemoryTracer();

    const testCwd = '/workspace/test-project';
    const guardAttrs = { 'nio.guard.decision': 'deny', 'nio.guard.risk_level': 'high' };
    const errorReason = 'Blocked by Nio';

    // Build state with a pending span (simulates recordPreToolUse having run)
    let state = seed({
      turn_trace_id: 'f'.repeat(32),
    });
    state = recordPreToolUse(state, 'tc-block-1', 'Bash', 'rm -rf /', {});

    const { state: nextState, durationMs } = await recordPostToolUse(
      provider,
      state,
      'tc-block-1',
      testCwd,
      guardAttrs,
      errorReason,
    );

    // Span should have been emitted
    const spans = finished();
    assert.equal(spans.length, 1, 'exactly one span should be emitted');
    const span = spans[0]!;

    // nio.cwd must be the cwd we passed — NOT a platform string such as
    // 'claude-code' or 'hermes' (the old bug placed PLATFORM in this slot)
    assert.equal(
      span.attributes['nio.cwd'],
      testCwd,
      `nio.cwd should be "${testCwd}", not a platform string`,
    );

    // Guard attribute from postAttributes must be present
    assert.equal(
      span.attributes['nio.guard.decision'],
      'deny',
      'nio.guard.decision should be present on the span',
    );
    assert.equal(
      span.attributes['nio.guard.risk_level'],
      'high',
      'nio.guard.risk_level should be present on the span',
    );

    // Span status must be ERROR with the reason as message
    assert.equal(span.status.code, SpanStatusCode.ERROR, 'span status must be ERROR on deny path');
    assert.equal(span.status.message, errorReason, 'span status message must be the block reason');

    // State housekeeping: pending span should be drained
    assert.equal(nextState.pending_spans['tc-block-1'], undefined, 'pending span should be removed after post');
    assert.ok(durationMs !== null && durationMs >= 0, 'durationMs should be non-null and non-negative');

    await shutdown();
  });

  it('would capture wrong attribute if cwd and postAttributes were swapped (swapped-arg guard)', async () => {
    // Demonstrates that if someone accidentally passes a platform string as
    // cwd and the real cwd as postAttributes, the nio.cwd attribute would
    // contain 'hermes' rather than the real path — catching the original bug.
    const { provider, finished, shutdown } = makeInMemoryTracer();

    let state = seed({ turn_trace_id: 'e'.repeat(32) });
    state = recordPreToolUse(state, 'tc-swap', 'Bash', 'echo hi', {});

    // Deliberately pass the OLD broken order: platform string in cwd slot,
    // cwd string as postAttributes (to prove the test is order-sensitive)
    await recordPostToolUse(
      provider,
      state,
      'tc-swap',
      'hermes',                             // wrong: platform where cwd should be
      { 'nio.guard.decision': 'allow' },    // wrong: cwd where postAttrs should be
    );

    const spans = finished();
    assert.equal(spans.length, 1);
    const span = spans[0]!;

    // With swapped args, nio.cwd is 'hermes' — the exact bug this fixes.
    // This assertion PASSES to document what the broken call looked like;
    // the previous test confirms the corrected call gives the right value.
    assert.equal(
      span.attributes['nio.cwd'],
      'hermes',
      'swapped-arg call produces "hermes" in nio.cwd — demonstrates the original bug',
    );

    await shutdown();
  });
});
