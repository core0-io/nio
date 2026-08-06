// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-node';

import { buildSpanTree, chatSpanAttributes, chatSpanName } from '../scripts/lib/chat-span.js';
import type { ChatCall, ContentBlock } from '../scripts/lib/conversation/types.js';
import type { DeferredSpan } from '../scripts/lib/traces-state-store.js';
import { dispatchCollectorEvent } from '../scripts/lib/collector-core.js';
import type { ResolvedMetricsConfig, CollectorLogsConfig } from '../adapters/common.js';
import { trackTempDir } from './helpers/tmp-dirs.js';

// ── Builders ────────────────────────────────────────────────────────────

function toolUseBlock(index: number, id: string, name = 'Bash'): ContentBlock {
  return {
    type: 'tool_use',
    index,
    content: '{}',
    toolUse: { id, name, input: '{}' },
  };
}

function call(overrides: Partial<ChatCall> = {}): ChatCall {
  return {
    callId: 'req_1',
    model: 'claude-x',
    startMs: 1_000,
    endMs: 2_000,
    timing: 'exact',
    blocks: [],
    isSidechain: false,
    ...overrides,
  };
}

function deferred(overrides: Partial<DeferredSpan> = {}): DeferredSpan {
  return {
    kind: 'tool',
    name: 'execute_tool Bash',
    span_id: 'aaaaaaaaaaaaaaaa',
    start_ms: 1_500,
    end_ms: 1_600,
    attributes: {},
    ...overrides,
  };
}

// ── buildSpanTree: tool_use_id attribution (primary path) ───────────────

describe('buildSpanTree — tool_use_id attribution', () => {
  it('places each tool span under the call whose tool_use block declared it', () => {
    const calls = [
      call({ callId: 'c1', startMs: 1_000, endMs: 2_000, blocks: [toolUseBlock(0, 'toolu_a')] }),
      call({ callId: 'c2', startMs: 3_000, endMs: 4_000, blocks: [toolUseBlock(0, 'toolu_b')] }),
    ];
    // Deliberately reversed order + start times that would land BOTH spans
    // in the first call's window if time were the deciding factor.
    const spans = [
      deferred({ span_id: 'b0', tool_use_id: 'toolu_b', start_ms: 1_100 }),
      deferred({ span_id: 'a0', tool_use_id: 'toolu_a', start_ms: 1_200 }),
    ];

    const tree = buildSpanTree(calls, spans);

    assert.equal(tree.chats.length, 2);
    assert.deepEqual(tree.chats[0]!.tools.map((t) => t.span_id), ['a0']);
    assert.deepEqual(tree.chats[1]!.tools.map((t) => t.span_id), ['b0']);
    assert.deepEqual(tree.orphans, []);
  });

  it('mints a distinct span id per chat call', () => {
    const tree = buildSpanTree([call({ callId: 'c1' }), call({ callId: 'c2' })], []);
    assert.equal(tree.chats[0]!.span_id.length, 16);
    assert.match(tree.chats[0]!.span_id, /^[0-9a-f]{16}$/);
    assert.notEqual(tree.chats[0]!.span_id, tree.chats[1]!.span_id);
  });

  it('binds a tool_use_id repeated across calls to the first declaring call only', () => {
    // Synthetic timing so only the id path can place the span — a time
    // fallback would mask whether the id path did the work.
    const calls = [
      call({ callId: 'c1', timing: 'synthetic', startMs: 1_000, blocks: [toolUseBlock(0, 'toolu_dup')] }),
      call({ callId: 'c2', timing: 'synthetic', startMs: 3_000, blocks: [toolUseBlock(0, 'toolu_dup')] }),
    ];
    const tree = buildSpanTree(calls, [deferred({ span_id: 'd0', tool_use_id: 'toolu_dup' })]);

    assert.deepEqual(tree.chats[0]!.tools.map((t) => t.span_id), ['d0']);
    assert.deepEqual(tree.chats[1]!.tools, []);
    assert.deepEqual(tree.orphans, []);
    const placed = tree.chats.reduce((n, c) => n + c.tools.length, 0) + tree.orphans.length;
    assert.equal(placed, 1, 'the span must be placed exactly once');
  });

  it('falls through to time/orphan when the tool_use_id matches no call', () => {
    const calls = [call({ callId: 'c1', timing: 'synthetic', startMs: 1_000 })];
    const tree = buildSpanTree(calls, [deferred({ span_id: 'x0', tool_use_id: 'toolu_unknown' })]);

    assert.deepEqual(tree.chats[0]!.tools, []);
    assert.deepEqual(tree.orphans.map((o) => o.span_id), ['x0']);
  });
});

// ── buildSpanTree: time attribution (secondary path) ────────────────────

describe('buildSpanTree — time attribution', () => {
  it('places a tool span in the [call.startMs, next.startMs) window of a non-synthetic call', () => {
    const calls = [
      call({ callId: 'c1', timing: 'exact', startMs: 1_000, endMs: 1_400 }),
      call({ callId: 'c2', timing: 'exact', startMs: 2_000, endMs: 2_400 }),
    ];
    const spans = [
      deferred({ span_id: 'in_first', start_ms: 1_500 }),
      deferred({ span_id: 'in_second', start_ms: 2_500 }),
      deferred({ span_id: 'at_second_boundary', start_ms: 2_000 }),
    ];

    const tree = buildSpanTree(calls, spans);

    assert.deepEqual(tree.chats[0]!.tools.map((t) => t.span_id), ['in_first']);
    assert.deepEqual(
      tree.chats[1]!.tools.map((t) => t.span_id),
      ['in_second', 'at_second_boundary'],
      'the window is half-open: a span starting exactly at the next call belongs to that next call',
    );
    assert.deepEqual(tree.orphans, []);
  });

  it('orphans a tool span that started before the first call', () => {
    const calls = [call({ callId: 'c1', timing: 'exact', startMs: 1_000 })];
    const tree = buildSpanTree(calls, [deferred({ span_id: 'early', start_ms: 500 })]);

    assert.deepEqual(tree.chats[0]!.tools, []);
    assert.deepEqual(tree.orphans.map((o) => o.span_id), ['early']);
  });

  it("accepts 'inferred' timing — only 'synthetic' is disqualified", () => {
    const calls = [call({ callId: 'c1', timing: 'inferred', startMs: 1_000, endMs: 2_000 })];
    const tree = buildSpanTree(calls, [deferred({ span_id: 'i0', start_ms: 1_500 })]);

    assert.deepEqual(tree.chats[0]!.tools.map((t) => t.span_id), ['i0']);
    assert.deepEqual(tree.orphans, []);
  });

  it("NEVER uses time when the call's timing is 'synthetic' — the span is orphaned, not guessed", () => {
    // Only a time match could place these: no tool_use_id anywhere. The
    // timestamps are fabricated (Hermes stamps a whole payload with one
    // Date.now(); OpenClaw uses Date.now() + array index), so a window
    // hit here is coincidence, not evidence.
    const calls = [
      call({ callId: 'c1', timing: 'synthetic', startMs: 1_000, endMs: 1_000 }),
      call({ callId: 'c2', timing: 'synthetic', startMs: 1_001, endMs: 1_001 }),
    ];
    const spans = [
      deferred({ span_id: 's0', start_ms: 1_000 }),
      deferred({ span_id: 's1', start_ms: 1_002 }),
    ];

    const tree = buildSpanTree(calls, spans);

    assert.deepEqual(tree.chats[0]!.tools, [], 'synthetic call must not adopt a tool by time');
    assert.deepEqual(tree.chats[1]!.tools, [], 'synthetic call must not adopt a tool by time');
    assert.deepEqual(tree.orphans.map((o) => o.span_id), ['s0', 's1']);
  });

  it('skips a synthetic call but still uses a trustworthy one alongside it', () => {
    const calls = [
      call({ callId: 'c1', timing: 'synthetic', startMs: 1_000 }),
      call({ callId: 'c2', timing: 'exact', startMs: 2_000 }),
    ];
    const tree = buildSpanTree(calls, [
      deferred({ span_id: 'in_synthetic_window', start_ms: 1_500 }),
      deferred({ span_id: 'in_exact_window', start_ms: 2_500 }),
    ]);

    assert.deepEqual(tree.chats[0]!.tools, []);
    assert.deepEqual(tree.chats[1]!.tools.map((t) => t.span_id), ['in_exact_window']);
    assert.deepEqual(tree.orphans.map((o) => o.span_id), ['in_synthetic_window']);
  });
});

// ── buildSpanTree: degenerate inputs ────────────────────────────────────

describe('buildSpanTree — degenerate inputs', () => {
  it('returns every deferred span as an orphan when there are no calls', () => {
    const spans = [
      deferred({ span_id: 'o0', tool_use_id: 'toolu_a' }),
      deferred({ span_id: 'o1' }),
    ];
    const tree = buildSpanTree([], spans);

    assert.deepEqual(tree.chats, []);
    assert.deepEqual(tree.orphans.map((o) => o.span_id), ['o0', 'o1']);
  });

  it('returns chats with empty tool lists when there are no deferred spans', () => {
    const tree = buildSpanTree([call({ callId: 'c1' }), call({ callId: 'c2' })], []);

    assert.equal(tree.chats.length, 2);
    assert.deepEqual(tree.chats[0]!.tools, []);
    assert.deepEqual(tree.chats[1]!.tools, []);
    assert.deepEqual(tree.orphans, []);
  });

  it('returns an empty tree for empty inputs', () => {
    assert.deepEqual(buildSpanTree([], []), { chats: [], orphans: [] });
  });
});

// ── chat span attributes ────────────────────────────────────────────────

describe('chatSpanAttributes', () => {
  it('carries the full GenAI + nio attribute set', () => {
    const c = call({
      callId: 'req_abc',
      model: 'claude-opus-5',
      stopReason: 'tool_use',
      isSidechain: true,
      timing: 'inferred',
      usage: { input: 11, output: 22, cacheRead: 33, cacheWrite: 44, reasoning: 55 },
      blocks: [
        { type: 'thinking', index: 0, content: 'abcde', fidelity: 'full' },
        { type: 'text', index: 1, content: 'hi' },
        toolUseBlock(2, 'toolu_a'),
      ],
    });

    assert.deepEqual(chatSpanAttributes(c), {
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'claude-opus-5',
      'gen_ai.response.id': 'req_abc',
      'gen_ai.usage.input_tokens': 11,
      'gen_ai.usage.output_tokens': 22,
      'gen_ai.usage.cache_read.input_tokens': 33,
      'gen_ai.usage.cache_creation.input_tokens': 44,
      'gen_ai.response.finish_reasons': 'tool_use',
      'nio.content.thinking_chars': 5,
      'nio.content.text_chars': 2,
      'nio.content.blocks': 3,
      'nio.chat.is_sidechain': true,
      'nio.chat.timing': 'inferred',
      // Small enough for the span budget, so the trace is readable on its
      // own and no `text` content record is emitted — see
      // content/span-content.ts.
      'nio.chat.reply': 'hi',
    });
  });

  it('omits absent optional fields but always reports timing', () => {
    const attrs = chatSpanAttributes(call({ callId: 'bare', model: undefined, timing: 'synthetic' }));

    assert.equal(attrs['gen_ai.request.model'], undefined);
    assert.equal(attrs['gen_ai.usage.input_tokens'], undefined);
    assert.equal(attrs['gen_ai.response.finish_reasons'], undefined);
    assert.equal(attrs['nio.chat.timing'], 'synthetic', 'timing must always be transmitted');
    assert.equal(attrs['nio.content.blocks'], 0);
  });

  it('names the span after the model when known', () => {
    assert.equal(chatSpanName(call({ model: 'claude-opus-5' })), 'chat claude-opus-5');
    assert.equal(chatSpanName(call({ model: undefined })), 'chat');
  });
});

// ── End-to-end: a whole turn through the collector ──────────────────────

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

function freshFixture(): { dir: string; logsConfig: CollectorLogsConfig } {
  const dir = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-chat-span-')));
  return {
    dir,
    logsConfig: { enabled: true, local: true, path: join(dir, 'audit.jsonl'), max_size_mb: 100 },
  };
}

function parentOf(span: ReadableSpan): string | undefined {
  return span.parentSpanContext?.spanId;
}

function byName(spans: readonly ReadableSpan[], name: string): ReadableSpan[] {
  return spans.filter((s) => s.name === name);
}

/** One Claude Code transcript line per assistant turn (one LLM call). */
function transcriptLine(opts: {
  requestId: string;
  timestampMs: number;
  toolUseId: string;
  model?: string;
}): string {
  return JSON.stringify({
    type: 'assistant',
    requestId: opts.requestId,
    timestamp: new Date(opts.timestampMs).toISOString(),
    message: {
      id: opts.requestId,
      model: opts.model ?? 'claude-test-model',
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 },
      content: [
        { type: 'thinking', thinking: 'weighing it up' },
        { type: 'tool_use', id: opts.toolUseId, name: 'Bash', input: { command: 'ls' } },
      ],
    },
  });
}

async function runToolPair(
  logsConfig: CollectorLogsConfig,
  tracerProvider: unknown,
  sessionId: string,
  toolUseId: string,
): Promise<void> {
  const input = {
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_use_id: toolUseId,
    session_id: sessionId,
    cwd: '/tmp',
  };
  await dispatchCollectorEvent({
    event: 'PreToolUse',
    input,
    platform: 'claude-code',
    config: baseConfig,
    meterProvider: null,
    tracerProvider: tracerProvider as never,
    logsConfig,
  });
  await dispatchCollectorEvent({
    event: 'PostToolUse',
    input: { ...input, tool_response: { output: 'ok' } },
    platform: 'claude-code',
    config: baseConfig,
    meterProvider: null,
    tracerProvider: tracerProvider as never,
    logsConfig,
  });
}

describe('end-to-end: turn → chat → tool', () => {
  it('nests each tool span under the chat call that issued it, chats under the turn', async () => {
    const { makeInMemoryTracer } = await import('./helpers/tracer.js');
    const { loadState } = await import('../scripts/lib/traces-state-store.js');
    const { dir, logsConfig } = freshFixture();
    const tracer = makeInMemoryTracer();
    const sessionId = 'sess-chat-span-e2e';

    await runToolPair(logsConfig, tracer.provider, sessionId, 'toolu_e2e_1');
    await runToolPair(logsConfig, tracer.provider, sessionId, 'toolu_e2e_2');

    assert.equal(
      tracer.finished().length,
      0,
      'tool spans must be held back until the turn ends — attribution is not knowable at PostToolUse time',
    );

    const mid = loadState(logsConfig, sessionId);
    assert.equal(mid?.deferred_spans?.length, 2, 'both finished tool spans park in deferred_spans');

    // Transcript is written after the turn started so both calls pass the
    // `callsSince(turn_start_ms)` filter.
    const turnStart = mid!.turn_start_ms;
    const transcriptPath = join(dir, 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      [
        transcriptLine({ requestId: 'req_1', timestampMs: turnStart + 10, toolUseId: 'toolu_e2e_1' }),
        transcriptLine({ requestId: 'req_2', timestampMs: turnStart + 20, toolUseId: 'toolu_e2e_2' }),
        '',
      ].join('\n'),
      'utf-8',
    );

    await dispatchCollectorEvent({
      event: 'Stop',
      input: { session_id: sessionId, cwd: '/tmp', transcript_path: transcriptPath },
      platform: 'claude-code',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: tracer.provider,
      logsConfig,
    });

    const spans = tracer.finished();
    assert.equal(spans.length, 5, 'expected 2 chat + 2 tool + 1 turn spans');

    const turnSpans = byName(spans, 'invoke_agent UserPromptSubmit');
    const chatSpans = byName(spans, 'chat claude-test-model');
    const toolSpans = byName(spans, 'execute_tool Bash');
    assert.equal(turnSpans.length, 1);
    assert.equal(chatSpans.length, 2);
    assert.equal(toolSpans.length, 2);

    const turn = turnSpans[0]!;
    assert.equal(parentOf(turn), undefined, 'the turn span is the trace root');

    // Every chat hangs off the turn.
    for (const chat of chatSpans) {
      assert.equal(parentOf(chat), turn.spanContext().spanId, 'chat span must be a child of the turn');
      assert.equal(chat.spanContext().traceId, turn.spanContext().traceId);
    }

    // Each tool hangs off ITS OWN chat — not the turn, and not the other chat.
    const chatByCallId = new Map(
      chatSpans.map((c) => [c.attributes['gen_ai.response.id'] as string, c]),
    );
    const toolByCallId = new Map(
      toolSpans.map((t) => [t.attributes['gen_ai.tool.call.id'] as string, t]),
    );

    for (const [reqId, toolUseId] of [['req_1', 'toolu_e2e_1'], ['req_2', 'toolu_e2e_2']] as const) {
      const chat = chatByCallId.get(reqId);
      const tool = toolByCallId.get(toolUseId);
      assert.ok(chat, `chat span for ${reqId} missing`);
      assert.ok(tool, `tool span for ${toolUseId} missing`);
      assert.equal(
        parentOf(tool!),
        chat!.spanContext().spanId,
        `${toolUseId} must hang off ${reqId}, not off the turn or the other chat`,
      );
      assert.notEqual(parentOf(tool!), turn.spanContext().spanId);
    }

    // Chat attributes survive the trip through OTEL.
    const first = chatByCallId.get('req_1')!;
    assert.equal(first.attributes['gen_ai.operation.name'], 'chat');
    assert.equal(first.attributes['gen_ai.request.model'], 'claude-test-model');
    assert.equal(first.attributes['gen_ai.usage.input_tokens'], 10);
    assert.equal(first.attributes['gen_ai.usage.output_tokens'], 5);
    assert.equal(first.attributes['gen_ai.response.finish_reasons'], 'tool_use');
    assert.equal(first.attributes['nio.content.blocks'], 2);
    assert.equal(first.attributes['nio.content.thinking_chars'], 'weighing it up'.length);
    assert.equal(first.attributes['nio.chat.is_sidechain'], false);
    assert.equal(
      first.attributes['nio.chat.timing'],
      'inferred',
      'nio.chat.timing must reach the span — it is how a consumer knows whether the duration means anything',
    );
    assert.equal(
      chatByCallId.get('req_2')!.attributes['nio.chat.timing'],
      'synthetic',
      'the last call of a Claude Code transcript has no successor to borrow an end time from',
    );

    const after = loadState(logsConfig, sessionId);
    assert.deepEqual(after?.deferred_spans, [], 'deferred_spans must drain at end of turn');
  });

  it('degrades to turn → tool when no conversation calls are available', async () => {
    const { makeInMemoryTracer } = await import('./helpers/tracer.js');
    const { logsConfig } = freshFixture();
    const tracer = makeInMemoryTracer();
    const sessionId = 'sess-chat-span-degraded';

    await runToolPair(logsConfig, tracer.provider, sessionId, 'toolu_deg_1');
    await runToolPair(logsConfig, tracer.provider, sessionId, 'toolu_deg_2');

    // No transcript_path → createSourceForPlatform returns null → no calls.
    await dispatchCollectorEvent({
      event: 'Stop',
      input: { session_id: sessionId, cwd: '/tmp' },
      platform: 'claude-code',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: tracer.provider,
      logsConfig,
    });

    const spans = tracer.finished();
    assert.equal(spans.length, 3, 'expected 2 tool + 1 turn spans and no chat layer');
    assert.equal(byName(spans, 'chat claude-test-model').length, 0);

    const turn = byName(spans, 'invoke_agent UserPromptSubmit')[0]!;
    const tools = byName(spans, 'execute_tool Bash');
    assert.equal(tools.length, 2);
    for (const tool of tools) {
      assert.equal(parentOf(tool), turn.spanContext().spanId, 'orphan tool spans hang off the turn');
      assert.equal(tool.spanContext().traceId, turn.spanContext().traceId);
    }
  });
});
