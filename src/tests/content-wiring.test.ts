// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Content pipeline → real logger provider, and the conversation source
 * wiring for all four platforms.
 *
 * What these tests are actually defending:
 *
 *  1. A content record without a usable (trace_id, span_id) is dead
 *     weight — nothing can join it back to the span it describes. Both
 *     the built-in OTLP fields AND the redundant `nio.*` string copies
 *     are asserted, because backends disagree on which of the two they
 *     expose (see content/emit.ts).
 *  2. The deferred state file must carry metadata only. The moment tool
 *     arguments / results creep back into `DeferredSpan.attributes`,
 *     every hook event in a long turn re-reads and re-writes them.
 *  3. Conversation content is emitted at end of turn, not "live" — the
 *     chat span id it must carry does not exist until then.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-node';
import type { ReadableLogRecord } from '@opentelemetry/sdk-logs';

import { dispatchCollectorEvent } from '../scripts/lib/collector-core.js';
import { statePath } from '../scripts/lib/traces-state-store.js';
import type { ResolvedMetricsConfig, CollectorLogsConfig } from '../adapters/common.js';
import { makeInMemoryTracer } from './helpers/tracer.js';
import { makeInMemoryLogger } from './helpers/logger.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'nio-content-wiring-'));
  return {
    dir,
    logsConfig: { enabled: true, local: true, path: join(dir, 'audit.jsonl'), max_size_mb: 100 },
  };
}

function attr(record: ReadableLogRecord, key: string): unknown {
  return (record.attributes as Record<string, unknown>)[key];
}

function contentRecords(records: readonly ReadableLogRecord[]): ReadableLogRecord[] {
  return records.filter((r) => attr(r, 'nio.content.type') !== undefined);
}

function byContentType(records: readonly ReadableLogRecord[], type: string): ReadableLogRecord[] {
  return contentRecords(records).filter((r) => attr(r, 'nio.content.type') === type);
}

function byName(spans: readonly ReadableSpan[], name: string): ReadableSpan[] {
  return spans.filter((s) => s.name === name);
}

/** One Claude Code transcript line (one LLM call) with configurable blocks. */
function transcriptLine(opts: {
  requestId: string;
  timestampMs: number;
  toolUseId: string;
  thinking?: string;
  text?: string;
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
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [
        { type: 'thinking', thinking: opts.thinking ?? 'weighing it up' },
        { type: 'text', text: opts.text ?? 'here goes' },
        { type: 'tool_use', id: opts.toolUseId, name: 'Bash', input: { command: 'ls' } },
      ],
    },
  });
}

async function runToolPair(
  logsConfig: CollectorLogsConfig,
  tracerProvider: unknown,
  loggerProvider: unknown,
  sessionId: string,
  toolUseId: string,
  output = 'ok',
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
    loggerProvider: loggerProvider as never,
    logsConfig,
  });
  await dispatchCollectorEvent({
    event: 'PostToolUse',
    input: { ...input, tool_response: { output } },
    platform: 'claude-code',
    config: baseConfig,
    meterProvider: null,
    tracerProvider: tracerProvider as never,
    loggerProvider: loggerProvider as never,
    logsConfig,
  });
}

// ── Chat content ↔ chat span association ───────────────────────────────

describe('content wiring: a turn\'s content records join back to their chat span', () => {
  it('stamps every record with the chat span it belongs to — built-in fields and the redundant attributes agree', async () => {
    const { dir, logsConfig } = freshFixture();
    const tracer = makeInMemoryTracer();
    const logger = makeInMemoryLogger();
    const sessionId = 'sess-content-assoc';

    await runToolPair(logsConfig, tracer.provider, logger.provider, sessionId, 'toolu_c1');
    await runToolPair(logsConfig, tracer.provider, logger.provider, sessionId, 'toolu_c2');

    const { loadState } = await import('../scripts/lib/traces-state-store.js');
    const turnStart = loadState(logsConfig)!.turn_start_ms;

    const transcriptPath = join(dir, 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      [
        transcriptLine({ requestId: 'req_1', timestampMs: turnStart + 10, toolUseId: 'toolu_c1', thinking: 'first thought' }),
        transcriptLine({ requestId: 'req_2', timestampMs: turnStart + 20, toolUseId: 'toolu_c2', thinking: 'second thought' }),
        '',
      ].join('\n'),
      'utf-8',
    );

    // Content for a chat call cannot exist before the chat span does.
    assert.equal(
      byContentType(logger.emitted(), 'thinking').length,
      0,
      'chat content must not go out before end of turn — the chat span id does not exist yet',
    );

    await dispatchCollectorEvent({
      event: 'Stop',
      input: { session_id: sessionId, cwd: '/tmp', transcript_path: transcriptPath },
      platform: 'claude-code',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: tracer.provider,
      loggerProvider: logger.provider,
      logsConfig,
    });

    const chatSpans = byName(tracer.finished(), 'chat claude-test-model');
    assert.equal(chatSpans.length, 2, 'two chat spans expected');
    const turnTraceId = chatSpans[0]!.spanContext().traceId;

    // One record per emittable block (thinking + text + tool_use) per call.
    const thinking = byContentType(logger.emitted(), 'thinking');
    const text = byContentType(logger.emitted(), 'text');
    assert.equal(thinking.length, 2);
    assert.equal(text.length, 2);

    // `tool_input` has two producers by design (see buildToolInputRecord):
    // the chat call's `tool_use` block, and PostToolUse's source-free
    // record. Only the former belongs to a chat span; split them by span
    // id so this test keeps asserting the chat-span association it is
    // about, rather than silently accepting either producer.
    const chatSpanIds = new Set(chatSpans.map((s) => s.spanContext().spanId));
    const allToolInput = byContentType(logger.emitted(), 'tool_input');
    const toolInput = allToolInput.filter((r) => chatSpanIds.has(r.spanContext!.spanId));
    assert.equal(toolInput.length, 2, 'one tool_use block record per chat call');
    assert.equal(
      allToolInput.length - toolInput.length,
      2,
      'and one source-free PostToolUse record per tool call, on the tool span',
    );

    const spanIds = chatSpanIds;
    for (const record of [...thinking, ...text, ...toolInput]) {
      // Built-in OTLP LogRecord fields — what a backend maps to trace_id / span_id.
      assert.ok(record.spanContext, 'record must carry a span context (emitAuditLog/emitContentRecords must pass one)');
      assert.equal(record.spanContext!.traceId, turnTraceId);
      assert.ok(
        spanIds.has(record.spanContext!.spanId),
        `record span id ${record.spanContext!.spanId} must be one of the chat span ids`,
      );
      // Redundant plain-string copies — the join key that works on every backend.
      assert.equal(attr(record, 'nio.trace_id'), record.spanContext!.traceId);
      assert.equal(attr(record, 'nio.span_id'), record.spanContext!.spanId);
    }

    // And the association is per-call, not "any chat span will do": the
    // record whose body is the first call's thinking must point at the
    // span whose gen_ai.response.id is that call.
    const chatByCallId = new Map(
      chatSpans.map((s) => [s.attributes['gen_ai.response.id'] as string, s.spanContext().spanId]),
    );
    const firstThinking = thinking.find((r) => String(r.body).includes('first thought'));
    const secondThinking = thinking.find((r) => String(r.body).includes('second thought'));
    assert.ok(firstThinking && secondThinking, 'both thinking records must be present');
    assert.equal(firstThinking!.spanContext!.spanId, chatByCallId.get('req_1'));
    assert.equal(secondThinking!.spanContext!.spanId, chatByCallId.get('req_2'));
    assert.notEqual(chatByCallId.get('req_1'), chatByCallId.get('req_2'));
  });

  it('redacts secrets and records the truncation verdict on the emitted record', async () => {
    const { dir, logsConfig } = freshFixture();
    const tracer = makeInMemoryTracer();
    const logger = makeInMemoryLogger();
    const sessionId = 'sess-content-redact';

    await runToolPair(logsConfig, tracer.provider, logger.provider, sessionId, 'toolu_r1');

    const { loadState } = await import('../scripts/lib/traces-state-store.js');
    const turnStart = loadState(logsConfig)!.turn_start_ms;

    const secret = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const transcriptPath = join(dir, 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      transcriptLine({
        requestId: 'req_1',
        timestampMs: turnStart + 10,
        toolUseId: 'toolu_r1',
        thinking: `the key is ${secret} and that is that`,
      }) + '\n',
      'utf-8',
    );

    await dispatchCollectorEvent({
      event: 'Stop',
      input: { session_id: sessionId, cwd: '/tmp', transcript_path: transcriptPath },
      platform: 'claude-code',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: tracer.provider,
      loggerProvider: logger.provider,
      logsConfig,
    });

    const thinking = byContentType(logger.emitted(), 'thinking');
    assert.equal(thinking.length, 1);
    const body = String(thinking[0]!.body);
    assert.ok(!body.includes(secret), 'the secret must not reach the wire');
    assert.match(body, /REDACTED/);
    assert.ok(
      (attr(thinking[0]!, 'nio.content.redactions') as number) >= 1,
      'the record must say how many secrets were replaced',
    );
  });

  it('truncates by the configured per-kind byte limit and flags it on the record', async () => {
    // loadContentLimits reads $NIO_HOME/config.yaml; the loader caches by
    // resolved path, so a fresh home is a fresh read.
    const home = mkdtempSync(join(tmpdir(), 'nio-content-limits-home-'));
    writeFileSync(
      join(home, 'config.yaml'),
      ['collector:', '  content_limits:', '    thinking: 64', ''].join('\n'),
      'utf-8',
    );
    const previousHome = process.env['NIO_HOME'];
    process.env['NIO_HOME'] = home;

    try {
      const { dir, logsConfig } = freshFixture();
      const tracer = makeInMemoryTracer();
      const logger = makeInMemoryLogger();
      const sessionId = 'sess-content-truncate';

      await runToolPair(logsConfig, tracer.provider, logger.provider, sessionId, 'toolu_t1');

      const { loadState } = await import('../scripts/lib/traces-state-store.js');
      const turnStart = loadState(logsConfig)!.turn_start_ms;

      const long = 'x'.repeat(4096);
      const transcriptPath = join(dir, 'transcript.jsonl');
      writeFileSync(
        transcriptPath,
        transcriptLine({
          requestId: 'req_1',
          timestampMs: turnStart + 10,
          toolUseId: 'toolu_t1',
          thinking: long,
        }) + '\n',
        'utf-8',
      );

      await dispatchCollectorEvent({
        event: 'Stop',
        input: { session_id: sessionId, cwd: '/tmp', transcript_path: transcriptPath },
        platform: 'claude-code',
        config: baseConfig,
        meterProvider: null,
        tracerProvider: tracer.provider,
        loggerProvider: logger.provider,
        logsConfig,
      });

      const thinking = byContentType(logger.emitted(), 'thinking');
      assert.equal(thinking.length, 1);
      const body = String(thinking[0]!.body);
      assert.ok(
        Buffer.byteLength(body, 'utf-8') <= 64,
        `body must respect the configured 64-byte cap, got ${Buffer.byteLength(body, 'utf-8')}`,
      );
      assert.equal(attr(thinking[0]!, 'nio.content.truncated'), true);
      assert.equal(attr(thinking[0]!, 'nio.content.original_bytes'), 4096);
    } finally {
      if (previousHome === undefined) delete process.env['NIO_HOME'];
      else process.env['NIO_HOME'] = previousHome;
    }
  });
});

// ── Tool output content ↔ tool span association ────────────────────────

describe('content wiring: tool output rides the logs signal, keyed to its tool span', () => {
  it('emits the result at PostToolUse under the span id the tool span is later exported with', async () => {
    const { logsConfig } = freshFixture();
    const tracer = makeInMemoryTracer();
    const logger = makeInMemoryLogger();
    const sessionId = 'sess-tool-output';

    await runToolPair(
      logsConfig, tracer.provider, logger.provider, sessionId, 'toolu_o1',
      'total 0\ndrwxr-xr-x  2 nobody nobody 64 Aug  5 10:00 .',
    );

    const outputs = byContentType(logger.emitted(), 'tool_output');
    assert.equal(outputs.length, 1, 'the tool result must be captured exactly once');
    assert.match(String(outputs[0]!.body), /drwxr-xr-x/);
    assert.equal(attr(outputs[0]!, 'gen_ai.tool.call.id'), 'toolu_o1');
    const recordSpanId = outputs[0]!.spanContext!.spanId;
    assert.ok(recordSpanId && recordSpanId !== '0'.repeat(16), 'record must carry a real span id');

    // Close the turn — the tool span goes out now, and must carry the
    // very same span id the content record was stamped with.
    await dispatchCollectorEvent({
      event: 'Stop',
      input: { session_id: sessionId, cwd: '/tmp' },
      platform: 'claude-code',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: tracer.provider,
      loggerProvider: logger.provider,
      logsConfig,
    });

    const toolSpans = byName(tracer.finished(), 'execute_tool Bash');
    assert.equal(toolSpans.length, 1);
    assert.equal(
      toolSpans[0]!.spanContext().spanId,
      recordSpanId,
      'the tool output record and the tool span must share a span id, or they can never be joined',
    );
    assert.equal(toolSpans[0]!.spanContext().traceId, outputs[0]!.spanContext!.traceId);
  });
});

// ── Tool arguments survive the degraded (no ConversationSource) path ───

describe('content wiring: tool arguments do not depend on a ConversationSource', () => {
  it('emits the arguments at PostToolUse even with no transcript to replay', async () => {
    // The degraded path: no transcript_path, so createSourceForPlatform
    // yields nothing, endTurn falls back to the flat `turn → tool` shape
    // and no chat call — hence no `tool_use` block — ever exists. Since
    // PreToolUse parks identity only (genAiToolCallIdAttributes), this
    // record is the ONLY place the arguments can still be found.
    const { logsConfig } = freshFixture();
    const tracer = makeInMemoryTracer();
    const logger = makeInMemoryLogger();
    const sessionId = 'sess-tool-input-degraded';

    const command = `grep -rn "needle-${'q'.repeat(400)}" /some/haystack`;
    const input = {
      tool_name: 'Bash',
      tool_input: { command, timeout: 120000 },
      tool_use_id: 'toolu_deg1',
      session_id: sessionId,
      cwd: '/tmp',
    };
    for (const event of ['PreToolUse', 'PostToolUse'] as const) {
      await dispatchCollectorEvent({
        event,
        input: event === 'PostToolUse' ? { ...input, tool_response: { output: 'ok' } } : input,
        platform: 'claude-code',
        config: baseConfig,
        meterProvider: null,
        tracerProvider: tracer.provider,
        loggerProvider: logger.provider,
        logsConfig,
      });
    }

    const inputs = byContentType(logger.emitted(), 'tool_input');
    assert.equal(inputs.length, 1, 'the arguments must be captured even without a source');
    const body = String(inputs[0]!.body);
    assert.ok(
      body.includes(`needle-${'q'.repeat(400)}`),
      'the full argument payload must survive, not just the 300-char nio.tool_summary prefix',
    );
    assert.ok(body.includes('120000'), 'non-primary argument keys must survive too');
    assert.equal(attr(inputs[0]!, 'gen_ai.tool.call.id'), 'toolu_deg1');

    const recordSpanId = inputs[0]!.spanContext!.spanId;
    assert.ok(recordSpanId && recordSpanId !== '0'.repeat(16), 'record must carry a real span id');

    // Close the turn with no transcript: the degradation must be
    // structural only. No chat span, and the tool span still carries the
    // id the argument record was stamped with.
    await dispatchCollectorEvent({
      event: 'Stop',
      input: { session_id: sessionId, cwd: '/tmp' },
      platform: 'claude-code',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: tracer.provider,
      loggerProvider: logger.provider,
      logsConfig,
    });

    assert.equal(
      tracer.finished().filter((s) => s.name.startsWith('chat ')).length,
      0,
      'this test is only meaningful while the degraded path really produces no chat span',
    );
    const toolSpans = byName(tracer.finished(), 'execute_tool Bash');
    assert.equal(toolSpans.length, 1);
    assert.equal(
      toolSpans[0]!.spanContext().spanId,
      recordSpanId,
      'the argument record and the tool span must share a span id, or they can never be joined',
    );

    // And the span itself still carries no arguments attribute — the
    // record above is genuinely the only carrier, not a belt-and-braces
    // copy of something still on the span.
    assert.equal(
      toolSpans[0]!.attributes['gen_ai.tool.call.arguments'],
      undefined,
      'arguments must ride the logs signal, not the span attributes',
    );
  });

  it('redacts and truncates the arguments like every other content record', async () => {
    const { logsConfig } = freshFixture();
    const tracer = makeInMemoryTracer();
    const logger = makeInMemoryLogger();
    const sessionId = 'sess-tool-input-redact';

    const secret = 'sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const input = {
      tool_name: 'Bash',
      tool_input: { command: `curl -H "x: ${secret}" https://example.invalid` },
      tool_use_id: 'toolu_deg2',
      session_id: sessionId,
      cwd: '/tmp',
    };
    for (const event of ['PreToolUse', 'PostToolUse'] as const) {
      await dispatchCollectorEvent({
        event,
        input: event === 'PostToolUse' ? { ...input, tool_response: { output: 'ok' } } : input,
        platform: 'claude-code',
        config: baseConfig,
        meterProvider: null,
        tracerProvider: tracer.provider,
        loggerProvider: logger.provider,
        logsConfig,
      });
    }

    const inputs = byContentType(logger.emitted(), 'tool_input');
    assert.equal(inputs.length, 1);
    const body = String(inputs[0]!.body);
    assert.ok(!body.includes(secret), 'the secret must not reach the wire');
    assert.match(body, /REDACTED/);
    assert.ok((attr(inputs[0]!, 'nio.content.redactions') as number) >= 1);
  });

  it('emits nothing when the tool took no arguments', async () => {
    const { logsConfig } = freshFixture();
    const tracer = makeInMemoryTracer();
    const logger = makeInMemoryLogger();
    const sessionId = 'sess-tool-input-empty';

    const input = {
      tool_name: 'Bash',
      tool_input: {},
      tool_use_id: 'toolu_deg3',
      session_id: sessionId,
      cwd: '/tmp',
    };
    for (const event of ['PreToolUse', 'PostToolUse'] as const) {
      await dispatchCollectorEvent({
        event,
        input: event === 'PostToolUse' ? { ...input, tool_response: { output: 'ok' } } : input,
        platform: 'claude-code',
        config: baseConfig,
        meterProvider: null,
        tracerProvider: tracer.provider,
        loggerProvider: logger.provider,
        logsConfig,
      });
    }

    assert.equal(
      byContentType(logger.emitted(), 'tool_input').length,
      0,
      'an empty argument object is not worth a record',
    );
  });
});

// ── Audit records join the turn they were written during ───────────────

describe('audit log records carry the turn they belong to', () => {
  it('stamps hook audit records with the active turn\'s trace and span ids', async () => {
    const { logsConfig } = freshFixture();
    const tracer = makeInMemoryTracer();
    const logger = makeInMemoryLogger();
    const sessionId = 'sess-audit-context';

    await runToolPair(logsConfig, tracer.provider, logger.provider, sessionId, 'toolu_a1');

    await dispatchCollectorEvent({
      event: 'Stop',
      input: { session_id: sessionId, cwd: '/tmp' },
      platform: 'claude-code',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: tracer.provider,
      loggerProvider: logger.provider,
      logsConfig,
    });

    const turn = byName(tracer.finished(), 'invoke_agent UserPromptSubmit')[0]!;
    const post = logger.emitted().find((r) => attr(r, 'nio.event') === 'PostToolUse');
    assert.ok(post, 'the PostToolUse audit record must have been exported');
    assert.ok(
      post!.spanContext,
      'emitAuditLog must be given a span context — nio never has an ambient one, so without it the record\'s trace_id / span_id stay empty',
    );
    assert.equal(post!.spanContext!.traceId, turn.spanContext().traceId);
    assert.equal(post!.spanContext!.spanId, turn.spanContext().spanId);
  });
});

// ── State hygiene: metadata only ───────────────────────────────────────

describe('deferred state carries metadata only', () => {
  it('never parks tool arguments or results in the state file', async () => {
    const { logsConfig } = freshFixture();
    const tracer = makeInMemoryTracer();
    const logger = makeInMemoryLogger();
    const sessionId = 'sess-state-hygiene';

    const marker = 'SENTINEL_ARGUMENT_VALUE';
    const resultMarker = 'SENTINEL_RESULT_VALUE';
    // The marker lives OUTSIDE the field `toolSummary` extracts, so its
    // presence can only mean the full argument object was serialised.
    const input = {
      tool_name: 'Bash',
      tool_input: { command: 'ls -la', extra_arg: marker },
      tool_use_id: 'toolu_state_1',
      session_id: sessionId,
      cwd: '/tmp',
    };

    await dispatchCollectorEvent({
      event: 'PreToolUse',
      input,
      platform: 'claude-code',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: tracer.provider,
      loggerProvider: logger.provider,
      logsConfig,
    });

    const afterPre = readFileSync(statePath(logsConfig), 'utf-8');
    assert.ok(
      !afterPre.includes('gen_ai.tool.call.arguments'),
      'PreToolUse must not park the tool arguments in the state file',
    );

    await dispatchCollectorEvent({
      event: 'PostToolUse',
      input: { ...input, tool_response: { output: resultMarker } },
      platform: 'claude-code',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: tracer.provider,
      loggerProvider: logger.provider,
      logsConfig,
    });

    const afterPost = readFileSync(statePath(logsConfig), 'utf-8');
    assert.ok(
      !afterPost.includes('gen_ai.tool.call.result'),
      'PostToolUse must not park the tool result in the state file',
    );
    assert.ok(
      !afterPost.includes(resultMarker),
      'the result payload itself must not reach the state file — every hook event rewrites it whole',
    );
    assert.ok(
      !afterPost.includes(marker),
      'the argument payload itself must not reach the state file',
    );

    // …but the metadata that makes the span readable is still there.
    const parsed = JSON.parse(afterPost) as {
      deferred_spans?: Array<{ attributes: Record<string, unknown> }>;
    };
    assert.equal(parsed.deferred_spans?.length, 1);
    const attrs = parsed.deferred_spans![0]!.attributes;
    assert.equal(attrs['gen_ai.tool.name'], 'Bash');
    assert.equal(attrs['gen_ai.tool.call.id'], 'toolu_state_1');
    assert.equal(
      attrs['nio.tool_summary'],
      'ls -la',
      'the short summary stays on the span — it is what makes a trace list scannable',
    );
  });
});

// ── The /nio-monitor master switch ─────────────────────────────────────

describe('content capture is gated by the monitor master switch', () => {
  it('emits no content when the session has no logger provider (unmonitored)', async () => {
    const { dir, logsConfig } = freshFixture();
    const tracer = makeInMemoryTracer();
    // A logger exists in the test, but the dispatch is told there is
    // none — exactly what collector-hook / hook-cli pass for a session
    // that /nio-monitor never armed.
    const logger = makeInMemoryLogger();
    const sessionId = 'sess-unmonitored';

    await runToolPair(logsConfig, tracer.provider, null, sessionId, 'toolu_u1');

    const { loadState } = await import('../scripts/lib/traces-state-store.js');
    const turnStart = loadState(logsConfig)!.turn_start_ms;
    const transcriptPath = join(dir, 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      transcriptLine({ requestId: 'req_1', timestampMs: turnStart + 10, toolUseId: 'toolu_u1' }) + '\n',
      'utf-8',
    );

    await dispatchCollectorEvent({
      event: 'Stop',
      input: { session_id: sessionId, cwd: '/tmp', transcript_path: transcriptPath },
      platform: 'claude-code',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: tracer.provider,
      loggerProvider: null,
      logsConfig,
    });

    assert.equal(contentRecords(logger.emitted()).length, 0, 'an unarmed session must emit no content');
    // The trace structure is unaffected — gating content must not gate spans.
    assert.equal(byName(tracer.finished(), 'chat claude-test-model').length, 1);
  });

  it('createContentSink returns nothing without a provider', async () => {
    const { createContentSink } = await import('../scripts/lib/content/sink.js');
    const { DEFAULT_CONTENT_LIMITS } = await import('../scripts/lib/content/truncate.js');
    assert.equal(createContentSink(null, DEFAULT_CONTENT_LIMITS), undefined);
    assert.equal(createContentSink(undefined, DEFAULT_CONTENT_LIMITS), undefined);
  });
});

// ── Platform wiring: each entry point reaches its ConversationSource ────

describe('platform wiring: every platform reaches a conversation source', () => {
  it('claude-code and codex build theirs from transcript_path', async () => {
    for (const platform of ['claude-code', 'codex'] as const) {
      const { dir, logsConfig } = freshFixture();
      const tracer = makeInMemoryTracer();
      const logger = makeInMemoryLogger();
      const sessionId = `sess-wiring-${platform}`;

      await dispatchCollectorEvent({
        event: 'PreToolUse',
        input: {
          tool_name: 'Bash', tool_input: { command: 'ls' },
          tool_use_id: 'toolu_w1', session_id: sessionId, cwd: '/tmp',
        },
        platform,
        config: baseConfig,
        meterProvider: null,
        tracerProvider: tracer.provider,
        loggerProvider: logger.provider,
        logsConfig,
      });

      const { loadState } = await import('../scripts/lib/traces-state-store.js');
      const turnStart = loadState(logsConfig)!.turn_start_ms;

      const sessionFile = join(dir, platform === 'codex' ? 'rollout.jsonl' : 'transcript.jsonl');
      writeFileSync(
        sessionFile,
        platform === 'codex'
          ? JSON.stringify({
              timestamp: new Date(turnStart + 10).toISOString(),
              type: 'response_item',
              payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'codex says hello' }],
              },
            }) + '\n'
          : transcriptLine({ requestId: 'req_1', timestampMs: turnStart + 10, toolUseId: 'toolu_w1' }) + '\n',
        'utf-8',
      );

      await dispatchCollectorEvent({
        event: 'Stop',
        input: { session_id: sessionId, cwd: '/tmp', transcript_path: sessionFile },
        platform,
        config: baseConfig,
        meterProvider: null,
        tracerProvider: tracer.provider,
        loggerProvider: logger.provider,
        logsConfig,
      });

      const chats = tracer.finished().filter((s) => s.name.startsWith('chat'));
      assert.ok(chats.length >= 1, `${platform}: expected at least one chat span`);
      assert.ok(
        contentRecords(logger.emitted()).some((r) => attr(r, 'nio.content.type') === 'text'),
        `${platform}: expected the assistant text to reach the logs signal`,
      );
    }
  });

  it('hermes builds its source from the raw post_llm_call envelope, not from a file', async () => {
    const { logsConfig } = freshFixture();
    const tracer = makeInMemoryTracer();
    const logger = makeInMemoryLogger();
    const sessionId = 'sess-wiring-hermes';

    // Open a turn (Hermes: pre_llm_call → UserPromptSubmit).
    await dispatchCollectorEvent({
      event: 'UserPromptSubmit',
      input: { session_id: sessionId, cwd: '/tmp', prompt: 'do the thing' },
      platform: 'hermes',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: tracer.provider,
      loggerProvider: logger.provider,
      logsConfig,
    });

    const envelope = {
      session_id: sessionId,
      extra: {
        model: 'gpt-test',
        assistant_response: 'hermes assistant reply',
        conversation_history: [
          { role: 'user', content: 'do the thing' },
          {
            role: 'assistant',
            content: 'hermes assistant reply',
            finish_reason: 'stop',
          },
        ],
      },
    };

    await dispatchCollectorEvent({
      event: 'Stop',
      input: { session_id: sessionId, cwd: '/tmp' },
      platform: 'hermes',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: tracer.provider,
      loggerProvider: logger.provider,
      logsConfig,
      conversationInput: { payload: envelope },
    });

    const chats = tracer.finished().filter((s) => s.name.startsWith('chat'));
    assert.equal(chats.length, 1, 'the assistant message in the envelope must become a chat span');
    const texts = byContentType(logger.emitted(), 'text');
    assert.ok(
      texts.some((r) => String(r.body).includes('hermes assistant reply')),
      'the assistant reply must reach the logs signal',
    );
    assert.equal(texts[0]!.spanContext!.spanId, chats[0]!.spanContext().spanId);
  });

  it('openclaw builds its source from the events its daemon accumulated', async () => {
    // OpenClaw is a daemon with no session file and no whole-conversation
    // payload, so the only way to reach a chat span is the event array the
    // plugin keeps itself. Exercised through the real plugin against a
    // loopback OTLP sink — the provider it builds exports to the wire,
    // which is the only place its output is observable.
    const home = mkdtempSync(join(tmpdir(), 'nio-content-oc-'));
    const received: Array<{ url: string; body: string }> = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({ url: req.url ?? '', body: Buffer.concat(chunks).toString('utf-8') });
        res.writeHead(200);
        res.end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;

    writeFileSync(
      join(home, 'config.yaml'),
      `collector:\n  endpoint: "http://127.0.0.1:${port}"\n`,
      'utf-8',
    );
    const logsConfig = { path: join(home, 'audit.jsonl') } as CollectorLogsConfig;
    const previousHome = process.env['NIO_HOME'];
    process.env['NIO_HOME'] = home;

    try {
      const { saveMonitorStore } = await import('../scripts/lib/monitor-store.js');
      const sessionId = 'oc-content-armed';
      saveMonitorStore(logsConfig, {
        sessions: { [sessionId]: { armed_at: Date.now(), cwd: process.cwd() } },
      });

      const { registerOpenClawPlugin } = await import('../adapters/openclaw-plugin.js');
      const handlers = new Map<string, (e: unknown, c?: unknown) => Promise<unknown> | unknown>();
      registerOpenClawPlugin({
        on(name: string, h: (e: unknown, c?: unknown) => Promise<unknown> | unknown) {
          handlers.set(name, h);
        },
      });

      const ctx = { sessionKey: sessionId };
      await handlers.get('before_agent_reply')!({ cleanedBody: 'do the thing' }, ctx);
      await handlers.get('llm_output')!(
        {
          runId: 'run-content-1',
          callId: 'call-content-1',
          provider: 'anthropic',
          model: 'oc-test-model',
          outcome: 'ok',
          durationMs: 12,
          assistantTexts: ['openclaw assistant reply'],
          usage: { input: 5, output: 3 },
        },
        ctx,
      );
      await handlers.get('agent_end')!({}, ctx);
      await new Promise<void>((r) => setTimeout(r, 400));

      const traceBodies = received.filter((r) => r.url === '/v1/traces').map((r) => r.body).join('');
      const logBodies = received.filter((r) => r.url === '/v1/logs').map((r) => r.body).join('');
      assert.ok(
        traceBodies.includes('chat oc-test-model'),
        'the accumulated llm_output event must become a chat span',
      );
      assert.ok(
        logBodies.includes('openclaw assistant reply'),
        'the assistant text must reach the logs signal as content',
      );
      assert.ok(logBodies.includes('nio.span_id'), 'content records must carry the join key');
    } finally {
      if (previousHome === undefined) delete process.env['NIO_HOME'];
      else process.env['NIO_HOME'] = previousHome;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('openclaw emits chat and tool spans as SIBLINGS under the turn — the documented platform exception', async () => {
    // Every other platform nests `execute_tool` under the `chat` span
    // that issued it. OpenClaw cannot, and this test pins that so the
    // exception stays a documented fact rather than an unexplained
    // difference someone later "fixes" by rearranging the plugin.
    //
    // The cause is NOT that the plugin exports tool spans eagerly. Both
    // of buildSpanTree's attribution channels are unavailable on this
    // platform: createOpenClawSource never emits a `tool_use` block (its
    // own documented known gap — see conversation-cross-source.test.ts),
    // and its calls are `timing: 'synthetic'`, which the time-window
    // fallback skips by design. So every tool span is an orphan and
    // lands on the turn root no matter when it is emitted. Verified by
    // running this exact scenario against a deferred variant of the
    // plugin: the parent stayed the turn root.
    //
    // To close it, openclaw-source.ts has to reconstruct tool_use; until
    // then, deferring here would only trade crash-resilience and prompt
    // visibility for nothing.
    const home = mkdtempSync(join(tmpdir(), 'nio-content-oc-sib-'));
    const received: Array<{ url: string; body: string }> = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({ url: req.url ?? '', body: Buffer.concat(chunks).toString('utf-8') });
        res.writeHead(200);
        res.end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;

    writeFileSync(
      join(home, 'config.yaml'),
      `collector:\n  endpoint: "http://127.0.0.1:${port}"\n`,
      'utf-8',
    );
    const logsConfig = { path: join(home, 'audit.jsonl') } as CollectorLogsConfig;
    const previousHome = process.env['NIO_HOME'];
    process.env['NIO_HOME'] = home;

    try {
      const { saveMonitorStore } = await import('../scripts/lib/monitor-store.js');
      const sessionId = 'oc-sibling-shape';
      saveMonitorStore(logsConfig, {
        sessions: { [sessionId]: { armed_at: Date.now(), cwd: process.cwd() } },
      });

      const { registerOpenClawPlugin } = await import('../adapters/openclaw-plugin.js');
      const handlers = new Map<string, (e: unknown, c?: unknown) => Promise<unknown> | unknown>();
      registerOpenClawPlugin({
        on(name: string, h: (e: unknown, c?: unknown) => Promise<unknown> | unknown) {
          handlers.set(name, h);
        },
      });

      const ctx = { sessionKey: sessionId };
      await handlers.get('before_agent_reply')!({ cleanedBody: 'do the thing' }, ctx);
      await handlers.get('llm_output')!(
        {
          runId: 'run-sib-1', callId: 'call-sib-1', provider: 'anthropic',
          model: 'oc-sibling-model', outcome: 'tool_use', durationMs: 10,
          assistantTexts: ['about to run a command'], usage: { input: 5, output: 3 },
        },
        ctx,
      );
      await handlers.get('before_tool_call')!(
        { toolName: 'exec', params: { command: 'echo hi' }, toolCallId: 'tc-sib-1', runId: sessionId },
        ctx,
      );
      await handlers.get('after_tool_call')!(
        {
          toolName: 'exec', params: { command: 'echo hi' }, toolCallId: 'tc-sib-1',
          runId: sessionId, result: 'hi', durationMs: 4,
        },
        ctx,
      );
      await handlers.get('agent_end')!({}, ctx);
      await new Promise<void>((r) => setTimeout(r, 400));

      // The OTLP HTTP trace exporter posts uncompressed JSON, so the
      // parent links can be read straight off the request bodies.
      const spans: Array<{ name: string; spanId: string; parentSpanId?: string }> = [];
      for (const rec of received.filter((r) => r.url === '/v1/traces')) {
        const parsed = JSON.parse(rec.body) as {
          resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: Array<{ name: string; spanId: string; parentSpanId?: string }> }> }>;
        };
        for (const rs of parsed.resourceSpans ?? []) {
          for (const ss of rs.scopeSpans ?? []) {
            for (const s of ss.spans ?? []) spans.push(s);
          }
        }
      }

      const chat = spans.find((s) => s.name.startsWith('chat '));
      const tool = spans.find((s) => s.name.startsWith('execute_tool '));
      const turn = spans.find((s) => s.name === 'invoke_agent UserPromptSubmit');
      assert.ok(chat, 'the llm_output event must have produced a chat span');
      assert.ok(tool, 'the tool call must have produced a tool span');
      assert.ok(turn, 'the turn root must have been exported');

      assert.equal(chat!.parentSpanId, turn!.spanId, 'the chat span hangs off the turn root');
      assert.equal(
        tool!.parentSpanId,
        turn!.spanId,
        'and so does the tool span — on OpenClaw the two are siblings, not parent and child',
      );
      assert.notEqual(
        tool!.parentSpanId,
        chat!.spanId,
        'stated as an inequality too: if this ever goes red, OpenClaw gained tool attribution and the docs must follow',
      );
    } finally {
      if (previousHome === undefined) delete process.env['NIO_HOME'];
      else process.env['NIO_HOME'] = previousHome;
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('hermes without conversationInput degrades to the flat turn → tool shape', async () => {
    const { logsConfig } = freshFixture();
    const tracer = makeInMemoryTracer();
    const logger = makeInMemoryLogger();
    const sessionId = 'sess-wiring-hermes-degraded';

    await dispatchCollectorEvent({
      event: 'PreToolUse',
      input: {
        tool_name: 'terminal', tool_input: { command: 'ls' },
        session_id: sessionId, cwd: '/tmp',
      },
      platform: 'hermes',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: tracer.provider,
      loggerProvider: logger.provider,
      logsConfig,
    });
    await dispatchCollectorEvent({
      event: 'PostToolUse',
      input: {
        tool_name: 'terminal', tool_input: { command: 'ls' },
        session_id: sessionId, cwd: '/tmp', tool_response: { output: 'ok' },
      },
      platform: 'hermes',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: tracer.provider,
      loggerProvider: logger.provider,
      logsConfig,
    });
    await dispatchCollectorEvent({
      event: 'Stop',
      input: { session_id: sessionId, cwd: '/tmp' },
      platform: 'hermes',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: tracer.provider,
      loggerProvider: logger.provider,
      logsConfig,
    });

    const spans = tracer.finished();
    const turn = byName(spans, 'invoke_agent UserPromptSubmit')[0];
    const tool = byName(spans, 'execute_tool terminal')[0];
    assert.ok(turn && tool, 'both spans must still be exported');
    assert.equal(spans.filter((s) => s.name.startsWith('chat')).length, 0, 'no source → no chat layer');
    assert.equal(
      tool!.parentSpanContext?.spanId,
      turn!.spanContext().spanId,
      'the tool span falls back to hanging off the turn',
    );
    // Tool output still goes out — it never depended on the chat layer.
    assert.equal(byContentType(logger.emitted(), 'tool_output').length, 1);
  });
});
