// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Where a piece of conversation content ends up: on the span, or in the
 * logs signal.
 *
 * The split is by SIZE (see `content/span-content.ts`): small bodies
 * ride on the span, large ones stay in logs, and nothing is ever on the
 * wire twice. What these tests defend:
 *
 *  1. A short reply is readable from the trace alone, and is NOT also a
 *     log record.
 *  2. A reply too big for the span budget keeps its full-fidelity log
 *     record, and the span says so via `nio.content.truncated`.
 *  3. The same two rules for tool arguments, on the tool span — with the
 *     log-side copy owned by the site that EMITS that span.
 *  4. `tool_output` never reaches a span.
 *  5. Redaction runs BEFORE truncation. A secret straddling the cut
 *     point must not survive as a half-credential on the span attribute.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-node';
import type { ReadableLogRecord } from '@opentelemetry/sdk-logs';

import { endTurn, type CollectorState } from '../scripts/lib/traces-collector.js';
import { dispatchCollectorEvent } from '../scripts/lib/collector-core.js';
import { createContentSink } from '../scripts/lib/content/sink.js';
import { DEFAULT_CONTENT_LIMITS } from '../scripts/lib/content/truncate.js';
import { SPAN_CONTENT_LIMIT } from '../scripts/lib/content/span-content.js';
import type { ChatCall, ContentBlock } from '../scripts/lib/conversation/types.js';
import type { ResolvedMetricsConfig, CollectorLogsConfig } from '../adapters/common.js';
import { makeInMemoryTracer } from './helpers/tracer.js';
import { makeInMemoryLogger } from './helpers/logger.js';
import { trackTempDir } from './helpers/tmp-dirs.js';

const TRACE_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const baseConfig: ResolvedMetricsConfig = {
  endpoint: '', api_key: '', timeout: 5000, protocol: 'http',
  enabled: true, metrics_enabled: true, traces_enabled: true, logs_enabled: true,
};

// ── Builders ────────────────────────────────────────────────────────────

function textBlock(index: number, content: string): ContentBlock {
  return { type: 'text', index, content };
}

function toolUseBlock(index: number, id: string, input: string): ContentBlock {
  return { type: 'tool_use', index, content: input, toolUse: { id, name: 'Bash', input } };
}

function call(blocks: ContentBlock[]): ChatCall {
  return {
    callId: 'req_1', model: 'claude-x', startMs: 1_000, endMs: 2_000,
    timing: 'exact', blocks, isSidechain: false,
  };
}

function turnState(): CollectorState {
  return {
    session_id: 'sess-placement',
    turn_number: 1,
    turn_trace_id: TRACE_ID,
    turn_start_ms: 1_000,
    pending_spans: {},
    pending_task_spans: {},
    pending_guard_attrs: {},
    turn_attributes: {},
  };
}

interface Emitted {
  spans: readonly ReadableSpan[];
  records: readonly ReadableLogRecord[];
}

/**
 * Drive a whole turn through the real `endTurn` + the real content sink,
 * against in-memory tracer/logger providers. Nothing is stubbed between
 * the span layer and the placement decision — that join is the thing
 * under test.
 */
async function runTurn(calls: ChatCall[]): Promise<Emitted> {
  const tracer = makeInMemoryTracer();
  const logger = makeInMemoryLogger();
  try {
    const sink = createContentSink(logger.provider, DEFAULT_CONTENT_LIMITS);
    await endTurn(tracer.provider, turnState(), null, null, calls, sink);
    return { spans: tracer.finished(), records: await logger.flushed() };
  } finally {
    await tracer.shutdown();
    await logger.shutdown();
  }
}

/**
 * Drive one PreToolUse → PostToolUse pair through the real dispatch.
 * The tool span leaves at PostToolUse, so this is the site that owns the
 * span/logs placement decision for a tool call's arguments.
 */
async function runToolCall(
  toolInput: Record<string, unknown>,
  output = 'ok',
): Promise<Emitted> {
  const dir = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-placement-')));
  const logsConfig: CollectorLogsConfig = {
    enabled: true, local: true, path: join(dir, 'audit.jsonl'), max_size_mb: 100,
  };
  const tracer = makeInMemoryTracer();
  const logger = makeInMemoryLogger();
  try {
    const input = {
      tool_name: 'Bash', tool_input: toolInput, tool_use_id: 'toolu_a',
      session_id: 'sess-placement-tool', cwd: '/tmp',
    };
    for (const event of ['PreToolUse', 'PostToolUse'] as const) {
      await dispatchCollectorEvent({
        event,
        input: event === 'PostToolUse' ? { ...input, tool_response: { output } } : input,
        platform: 'claude-code',
        config: baseConfig,
        meterProvider: null,
        tracerProvider: tracer.provider,
        loggerProvider: logger.provider,
        logsConfig,
      });
    }
    return { spans: tracer.finished(), records: await logger.flushed() };
  } finally {
    await tracer.shutdown();
    await logger.shutdown();
  }
}

function spanNamed(spans: readonly ReadableSpan[], name: string): ReadableSpan {
  const found = spans.filter((s) => s.name === name);
  assert.equal(found.length, 1, `expected exactly one '${name}' span, got ${found.length}`);
  return found[0]!;
}

function recordsOfType(records: readonly ReadableLogRecord[], type: string): ReadableLogRecord[] {
  return records.filter(
    (r) => (r.attributes as Record<string, unknown>)['nio.content.type'] === type,
  );
}

/** A body of exactly `bytes` ASCII characters, so byte length is predictable. */
function filler(bytes: number, ch = 'x'): string {
  return ch.repeat(bytes);
}

// ── Assistant reply ─────────────────────────────────────────────────────

describe('assistant reply placement', () => {
  it('carries a short reply on the chat span and does NOT repeat it in logs', async () => {
    const reply = 'Done — the build is green.';
    const { spans, records } = await runTurn([call([textBlock(0, reply)])]);

    const chat = spanNamed(spans, 'chat claude-x');
    assert.equal(
      chat.attributes['nio.chat.reply'], reply,
      'a reply this small must be readable from the trace alone',
    );
    assert.equal(chat.attributes['nio.content.truncated'], undefined);

    assert.deepEqual(
      recordsOfType(records, 'text').map((r) => r.body), [],
      'the span owns this body in full; a log record would be the same bytes twice',
    );
  });

  it('joins several text blocks into one reply attribute', async () => {
    const { spans } = await runTurn([call([textBlock(0, 'first'), textBlock(1, 'second')])]);
    assert.equal(spanNamed(spans, 'chat claude-x').attributes['nio.chat.reply'], 'first\nsecond');
  });

  it('truncates an oversized reply on the span and keeps the full copy in logs', async () => {
    const reply = filler(SPAN_CONTENT_LIMIT * 2);
    const { spans, records } = await runTurn([call([textBlock(0, reply)])]);

    const chat = spanNamed(spans, 'chat claude-x');
    const onSpan = chat.attributes['nio.chat.reply'] as string;
    assert.ok(
      Buffer.byteLength(onSpan, 'utf-8') <= SPAN_CONTENT_LIMIT,
      `span copy must respect the ${SPAN_CONTENT_LIMIT}-byte budget, got ` +
      `${Buffer.byteLength(onSpan, 'utf-8')}`,
    );
    assert.equal(chat.attributes['nio.content.truncated'], true);
    assert.equal(chat.attributes['nio.content.original_bytes'], reply.length);

    const logged = recordsOfType(records, 'text');
    assert.equal(logged.length, 1, 'logs stay authoritative for a body the span could not hold');
    assert.equal(logged[0]!.body, reply);
  });

  it('invents no reply attribute for a call that said nothing', async () => {
    const { spans } = await runTurn([call([])]);
    assert.equal(spanNamed(spans, 'chat claude-x').attributes['nio.chat.reply'], undefined);
  });
});

// ── Tool arguments ──────────────────────────────────────────────────────

describe('tool argument placement', () => {
  it('carries small arguments on the tool span and does NOT repeat them in logs', async () => {
    const { spans, records } = await runToolCall({ command: 'pnpm test' });

    const tool = spanNamed(spans, 'execute_tool Bash');
    assert.equal(tool.attributes['gen_ai.tool.call.arguments'], '{"command":"pnpm test"}');
    assert.equal(tool.attributes['nio.content.truncated'], undefined);

    assert.deepEqual(
      recordsOfType(records, 'tool_input').map((r) => r.body), [],
      'the tool span owns these arguments in full',
    );
  });

  it('pairs a truncated span attribute with one full-fidelity record on the same span', async () => {
    // What a consumer must be able to do: read the truncated preview off
    // the span, see `nio.content.truncated`, and find the whole body in
    // logs under the SAME span id.
    const command = filler(SPAN_CONTENT_LIMIT * 3);
    const { spans, records } = await runToolCall({ command });

    const tool = spanNamed(spans, 'execute_tool Bash');
    const onSpan = tool.attributes['gen_ai.tool.call.arguments'] as string;
    assert.ok(
      Buffer.byteLength(onSpan, 'utf-8') <= SPAN_CONTENT_LIMIT,
      `span copy must respect the ${SPAN_CONTENT_LIMIT}-byte budget, got ` +
      `${Buffer.byteLength(onSpan, 'utf-8')}`,
    );
    assert.equal(tool.attributes['nio.content.truncated'], true);

    const logged = recordsOfType(records, 'tool_input');
    assert.equal(logged.length, 1, 'exactly one full copy — not one per producer');
    assert.ok(String(logged[0]!.body).includes(command), 'the record keeps the whole body');
    assert.equal(
      logged[0]!.spanContext!.spanId, tool.spanContext().spanId,
      'the record must name the tool span whose attribute it completes',
    );
  });

  it('keeps the chat call → tool call edge on the chat span, not in a log record', async () => {
    // What a `tool_use` content record would uniquely carry is
    // attribution: which LLM call decided on this tool. That is a list
    // of ids on the chat span, not a duplicate of the arguments.
    const args = '{"command":"rm -rf /"}';
    const { spans, records } = await runTurn([call([toolUseBlock(0, 'toolu_a', args)])]);

    assert.deepEqual(recordsOfType(records, 'tool_input').map((r) => r.body), []);
    assert.deepEqual(
      spanNamed(spans, 'chat claude-x').attributes['nio.chat.tool_call_ids'],
      ['toolu_a'],
    );
  });
});

// ── Tool results stay off the span ──────────────────────────────────────

describe('tool output placement', () => {
  it('never puts a tool result on a span', async () => {
    const result = filler(20_000, 'r');
    const { spans, records } = await runToolCall({ command: 'cat big' }, result);

    for (const span of spans) {
      for (const [key, value] of Object.entries(span.attributes)) {
        assert.ok(
          typeof value !== 'string' || !value.includes('rrrr'),
          `tool results must not reach a span; found one under '${key}' on '${span.name}'`,
        );
      }
    }

    const output = recordsOfType(records, 'tool_output');
    assert.equal(output.length, 1, 'the result belongs to the logs signal');
    assert.equal(output[0]!.body, result);
  });
});

// ── Redaction ordering ──────────────────────────────────────────────────

describe('span content redaction', () => {
  it('redacts a secret that straddles the truncation cut point', async () => {
    // Positioned so the key BEGINS just inside the budget and ENDS past
    // it. Truncate-then-redact would leave the leading half of a live
    // credential on the span; redact-then-truncate cannot.
    const secret = `sk-ant-${filler(40, 'A')}`;
    const command = `${filler(SPAN_CONTENT_LIMIT - 50)}${secret}`;
    const args = JSON.stringify({ command });
    assert.ok(
      args.indexOf(secret) < SPAN_CONTENT_LIMIT
      && args.indexOf(secret) + secret.length > SPAN_CONTENT_LIMIT,
      'fixture must actually straddle the cut point or the test proves nothing',
    );

    const { spans } = await runToolCall({ command });

    const onSpan = spanNamed(spans, 'execute_tool Bash')
      .attributes['gen_ai.tool.call.arguments'] as string;
    assert.ok(
      !onSpan.includes('sk-ant-'),
      'half a credential is still a credential — redaction must run before truncation',
    );
    assert.ok(onSpan.includes('[REDACTED]'));
  });
});
