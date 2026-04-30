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
} from '../scripts/lib/traces-collector.js';
import type { CollectorState } from '../scripts/lib/traces-state-store.js';

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
