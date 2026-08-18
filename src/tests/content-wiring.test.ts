// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * The content pipeline against a real logger provider, driven through
 * the hook dispatch rather than through the builders.
 *
 * What these tests defend:
 *
 *  1. A content record without a usable (trace_id, span_id) is dead
 *     weight — nothing can join it back to the span it describes. Both
 *     the built-in OTLP fields AND the redundant `nio.*` string copies
 *     are asserted, because backends disagree on which of the two they
 *     expose (see content/emit.ts).
 *  2. The state file must carry metadata only. The moment tool
 *     arguments / results creep back into it, every hook event in a long
 *     turn re-reads and re-writes them.
 *  3. Chat content is emitted at end of turn, not "live" — the chat span
 *     id it must carry does not exist until then.
 *  4. No logger provider means no content at all: that is the
 *     `/nio-monitor` master switch.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-node';
import type { ReadableLogRecord } from '@opentelemetry/sdk-logs';

import { dispatchCollectorEvent } from '../scripts/lib/collector-core.js';
import { loadState, statePath } from '../scripts/lib/traces-state-store.js';
import { createContentSink } from '../scripts/lib/content/sink.js';
import { DEFAULT_CONTENT_LIMITS } from '../scripts/lib/content/truncate.js';
import type { ResolvedMetricsConfig, CollectorLogsConfig } from '../adapters/common.js';
import { makeInMemoryTracer, type InMemoryTracer } from './helpers/tracer.js';
import { makeInMemoryLogger, type InMemoryLogger } from './helpers/logger.js';
import { trackTempDir } from './helpers/tmp-dirs.js';

const baseConfig: ResolvedMetricsConfig = {
  endpoint: '', api_key: '', timeout: 5000, protocol: 'http',
  enabled: true, metrics_enabled: true, traces_enabled: true, logs_enabled: true,
};

interface Fixture {
  dir: string;
  logsConfig: CollectorLogsConfig;
  tracer: InMemoryTracer;
  logger: InMemoryLogger;
}

function freshFixture(): Fixture {
  const dir = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-content-wiring-')));
  return {
    dir,
    logsConfig: { enabled: true, local: true, path: join(dir, 'audit.jsonl'), max_size_mb: 100 },
    tracer: makeInMemoryTracer(),
    logger: makeInMemoryLogger(),
  };
}

function attr(record: ReadableLogRecord, key: string): unknown {
  return (record.attributes as Record<string, unknown>)[key];
}

function byContentType(records: readonly ReadableLogRecord[], type: string): ReadableLogRecord[] {
  return records.filter((r) => attr(r, 'nio.content.type') === type);
}

function anyContent(records: readonly ReadableLogRecord[]): ReadableLogRecord[] {
  return records.filter((r) => attr(r, 'nio.content.type') !== undefined);
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
}): string {
  return JSON.stringify({
    type: 'assistant',
    requestId: opts.requestId,
    timestamp: new Date(opts.timestampMs).toISOString(),
    message: {
      id: opts.requestId,
      model: 'claude-test-model',
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

/** Dispatch one event with this fixture's providers. `logger: null` simulates an unarmed session. */
async function dispatch(
  f: Fixture,
  event: string,
  input: Record<string, unknown>,
  opts: { logger?: InMemoryLogger | null; platform?: string } = {},
): Promise<void> {
  const logger = opts.logger === undefined ? f.logger : opts.logger;
  await dispatchCollectorEvent({
    event,
    input,
    platform: opts.platform ?? 'claude-code',
    config: baseConfig,
    meterProvider: null,
    tracerProvider: f.tracer.provider,
    loggerProvider: logger ? logger.provider : null,
    logsConfig: f.logsConfig,
  });
}

/** One PreToolUse → PostToolUse pair. */
async function toolPair(
  f: Fixture,
  sessionId: string,
  toolUseId: string,
  opts: { toolInput?: Record<string, unknown>; output?: string; logger?: InMemoryLogger | null } = {},
): Promise<void> {
  const input = {
    tool_name: 'Bash',
    tool_input: opts.toolInput ?? { command: 'ls' },
    tool_use_id: toolUseId,
    session_id: sessionId,
    cwd: '/tmp',
  };
  const dispatchOpts = opts.logger === undefined ? {} : { logger: opts.logger };
  await dispatch(f, 'PreToolUse', input, dispatchOpts);
  await dispatch(
    f, 'PostToolUse', { ...input, tool_response: { output: opts.output ?? 'ok' } }, dispatchOpts,
  );
}

/** Write a transcript stamped inside the open turn, then close the turn. */
async function closeTurnWithTranscript(
  f: Fixture,
  sessionId: string,
  lines: (turnStart: number) => string[],
): Promise<string> {
  const turnStart = loadState(f.logsConfig)!.turn_start_ms;
  const transcriptPath = join(f.dir, 'transcript.jsonl');
  writeFileSync(transcriptPath, lines(turnStart).join('\n') + '\n', 'utf-8');
  await dispatch(f, 'Stop', { session_id: sessionId, cwd: '/tmp', transcript_path: transcriptPath });
  return transcriptPath;
}

// ── Chat content ↔ chat span association ───────────────────────────────

describe('content records join back to their chat span', () => {
  it('stamps each record with ITS OWN call\'s span — built-in fields and the redundant attributes agree', async () => {
    const f = freshFixture();
    const sessionId = 'sess-content-assoc';
    await toolPair(f, sessionId, 'toolu_c1');
    await toolPair(f, sessionId, 'toolu_c2');

    // Chat content cannot exist before the chat span does.
    assert.equal(byContentType(await f.logger.flushed(), 'thinking').length, 0);

    await closeTurnWithTranscript(f, sessionId, (t) => [
      transcriptLine({ requestId: 'req_1', timestampMs: t + 10, toolUseId: 'toolu_c1', thinking: 'first thought' }),
      transcriptLine({ requestId: 'req_2', timestampMs: t + 20, toolUseId: 'toolu_c2', thinking: 'second thought' }),
    ]);

    const chats = byName(f.tracer.finished(), 'chat claude-test-model');
    const spanIdByCall = new Map(
      chats.map((s) => [s.attributes['gen_ai.response.id'] as string, s.spanContext().spanId]),
    );
    const thinking = byContentType(await f.logger.flushed(), 'thinking');
    assert.equal(thinking.length, 2, 'one thinking record per call');

    for (const [callId, body] of [['req_1', 'first thought'], ['req_2', 'second thought']]) {
      const record = thinking.find((r) => String(r.body).includes(body!))!;
      assert.ok(record, `no record for ${callId}`);
      // Built-in OTLP fields — what a backend maps to trace_id / span_id.
      assert.equal(record.spanContext!.traceId, chats[0]!.spanContext().traceId);
      assert.equal(record.spanContext!.spanId, spanIdByCall.get(callId!));
      // Redundant plain-string copies — the join key that works everywhere.
      assert.equal(attr(record, 'nio.trace_id'), record.spanContext!.traceId);
      assert.equal(attr(record, 'nio.span_id'), record.spanContext!.spanId);
    }
    assert.notEqual(spanIdByCall.get('req_1'), spanIdByCall.get('req_2'));
  });

  it('redacts secrets in the emitted body and counts the replacements', async () => {
    const f = freshFixture();
    const sessionId = 'sess-content-redact';
    const secret = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    await toolPair(f, sessionId, 'toolu_r1');
    await closeTurnWithTranscript(f, sessionId, (t) => [
      transcriptLine({
        requestId: 'req_1', timestampMs: t + 10, toolUseId: 'toolu_r1',
        thinking: `the key is ${secret} and that is that`,
      }),
    ]);

    const thinking = byContentType(await f.logger.flushed(), 'thinking');
    assert.equal(thinking.length, 1);
    assert.ok(!String(thinking[0]!.body).includes(secret), 'the secret must not reach the wire');
    assert.match(String(thinking[0]!.body), /REDACTED/);
    assert.ok((attr(thinking[0]!, 'nio.content.redactions') as number) >= 1);
  });

  it('truncates by the configured per-kind byte limit and flags it on the record', async () => {
    const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-content-limits-home-')));
    writeFileSync(
      join(home, 'config.yaml'),
      ['collector:', '  content_limits:', '    thinking: 64', ''].join('\n'),
      'utf-8',
    );
    const previousHome = process.env['NIO_HOME'];
    process.env['NIO_HOME'] = home;
    try {
      const f = freshFixture();
      const sessionId = 'sess-content-truncate';
      await toolPair(f, sessionId, 'toolu_t1');
      await closeTurnWithTranscript(f, sessionId, (t) => [
        transcriptLine({
          requestId: 'req_1', timestampMs: t + 10, toolUseId: 'toolu_t1',
          thinking: 'x'.repeat(4096),
        }),
      ]);

      const thinking = byContentType(await f.logger.flushed(), 'thinking');
      assert.equal(thinking.length, 1);
      assert.ok(
        Buffer.byteLength(String(thinking[0]!.body), 'utf-8') <= 64,
        'the body must respect the configured 64-byte cap',
      );
      assert.equal(attr(thinking[0]!, 'nio.content.truncated'), true);
      assert.equal(attr(thinking[0]!, 'nio.content.original_bytes'), 4096);
    } finally {
      if (previousHome === undefined) delete process.env['NIO_HOME'];
      else process.env['NIO_HOME'] = previousHome;
    }
  });
});

// ── Tool content ↔ tool span association ───────────────────────────────

describe('tool content rides the logs signal, keyed to its tool span', () => {
  it('emits the result at PostToolUse under the id the tool span is exported with', async () => {
    const f = freshFixture();
    await toolPair(f, 'sess-tool-output', 'toolu_o1', { output: 'total 0\ndrwxr-xr-x 2 nobody' });

    const outputs = byContentType(await f.logger.flushed(), 'tool_output');
    assert.equal(outputs.length, 1, 'the tool result must be captured exactly once');
    assert.match(String(outputs[0]!.body), /drwxr-xr-x/);
    assert.equal(attr(outputs[0]!, 'gen_ai.tool.call.id'), 'toolu_o1');

    const tool = byName(f.tracer.finished(), 'execute_tool Bash')[0]!;
    assert.equal(
      outputs[0]!.spanContext!.spanId, tool.spanContext().spanId,
      'record and span must share a span id, or they can never be joined',
    );
    assert.equal(outputs[0]!.spanContext!.traceId, tool.spanContext().traceId);
  });

  it('emits oversized arguments with no transcript to replay', async () => {
    // The degraded path: no transcript_path, so no chat call and no
    // `tool_use` block ever exists. PreToolUse parks identity only, so
    // this record is the ONLY place the full arguments can be found.
    const f = freshFixture();
    const needle = `needle-${'q'.repeat(3_000)}`;
    await toolPair(f, 'sess-tool-input-degraded', 'toolu_deg1', {
      toolInput: { command: `grep -rn "${needle}" /haystack`, timeout: 120000 },
    });

    const inputs = byContentType(await f.logger.flushed(), 'tool_input');
    assert.equal(inputs.length, 1, 'the arguments must be captured even without a source');
    assert.ok(String(inputs[0]!.body).includes(needle), 'the full payload must survive');
    assert.ok(String(inputs[0]!.body).includes('120000'), 'non-primary keys must survive too');
    assert.equal(attr(inputs[0]!, 'gen_ai.tool.call.id'), 'toolu_deg1');

    const tool = byName(f.tracer.finished(), 'execute_tool Bash')[0]!;
    assert.equal(inputs[0]!.spanContext!.spanId, tool.spanContext().spanId);
    assert.equal(
      tool.attributes['nio.content.truncated'], true,
      'without this flag a consumer would read the span preview as the whole payload',
    );
  });

  it('redacts and truncates the arguments like every other content record', async () => {
    const f = freshFixture();
    const secret = 'sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    await toolPair(f, 'sess-tool-input-redact', 'toolu_deg2', {
      // Past the span budget, which is what routes the arguments to a
      // record at all; the redaction rule is the same on both sides.
      toolInput: { command: `curl -H "x: ${secret}" https://example.invalid/${'p'.repeat(2_500)}` },
    });

    const inputs = byContentType(await f.logger.flushed(), 'tool_input');
    assert.equal(inputs.length, 1);
    assert.ok(!String(inputs[0]!.body).includes(secret), 'the secret must not reach the wire');
    assert.match(String(inputs[0]!.body), /REDACTED/);
    assert.ok((attr(inputs[0]!, 'nio.content.redactions') as number) >= 1);
  });

  it('emits nothing when the tool took no arguments', async () => {
    const f = freshFixture();
    await toolPair(f, 'sess-tool-input-empty', 'toolu_deg3', { toolInput: {} });
    assert.equal(
      byContentType(await f.logger.flushed(), 'tool_input').length, 0,
      'an empty argument object is not worth a record',
    );
  });
});

// ── The user prompt is free text too ───────────────────────────────────

describe('the user prompt is scanned for secrets', () => {
  it('redacts a pasted credential before it reaches the turn span', async () => {
    // `redactAndTruncate` only scans JSON key names, so a string prompt
    // passes straight through it. The prompt is the likeliest place for
    // a pasted credential, so the free-text scanner runs first.
    const f = freshFixture();
    const secret = 'sk-ant-api03-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
    const sessionId = 'sess-prompt-redact';
    await dispatch(f, 'UserPromptSubmit', {
      session_id: sessionId, cwd: '/tmp', prompt: `use ${secret} to call the api`,
    });
    await dispatch(f, 'Stop', { session_id: sessionId, cwd: '/tmp' });

    const turn = byName(f.tracer.finished(), 'invoke_agent UserPromptSubmit')[0]!;
    const prompt = String(turn.attributes['nio.turn.user_prompt']);
    assert.ok(!prompt.includes(secret), 'the pasted key must not reach the span');
    assert.match(prompt, /REDACTED/);
  });
});

// ── State hygiene: metadata only ───────────────────────────────────────

describe('the state file carries metadata only', () => {
  it('never parks tool arguments or results in it', async () => {
    const f = freshFixture();
    // The markers live OUTSIDE the field `toolSummary` extracts, so
    // their presence can only mean the whole payload was serialised.
    const marker = 'SENTINEL_ARGUMENT_VALUE';
    const resultMarker = 'SENTINEL_RESULT_VALUE';
    const input = {
      tool_name: 'Bash',
      tool_input: { command: 'ls -la', extra_arg: marker },
      tool_use_id: 'toolu_state_1',
      session_id: 'sess-state-hygiene',
      cwd: '/tmp',
    };

    await dispatch(f, 'PreToolUse', input);
    const afterPre = readFileSync(statePath(f.logsConfig), 'utf-8');
    assert.ok(!afterPre.includes('gen_ai.tool.call.arguments'), 'PreToolUse must not park the arguments');
    assert.ok(!afterPre.includes(marker), 'nor the argument payload itself');

    await dispatch(f, 'PostToolUse', { ...input, tool_response: { output: resultMarker } });
    const afterPost = readFileSync(statePath(f.logsConfig), 'utf-8');
    assert.ok(!afterPost.includes('gen_ai.tool.call.result'), 'PostToolUse must not park the result');
    assert.ok(!afterPost.includes(resultMarker), 'nor the result payload — every event rewrites this file whole');
    assert.ok(!afterPost.includes(marker));

    // …and the payload still rode out on the span, straight from the
    // hook payload to the exporter with no stop on disk.
    const tool = byName(f.tracer.finished(), 'execute_tool Bash')[0]!;
    assert.equal(tool.attributes['gen_ai.tool.call.id'], 'toolu_state_1');
    assert.equal(tool.attributes['nio.tool_summary'], 'ls -la');
    assert.ok(String(tool.attributes['gen_ai.tool.call.arguments']).includes(marker));
  });
});

// ── The /nio-monitor master switch ─────────────────────────────────────

describe('content capture is gated by the monitor master switch', () => {
  it('emits no content when the session has no logger provider', async () => {
    // A logger exists in the test, but the dispatch is told there is
    // none — what collector-hook / hook-cli pass for an unarmed session.
    const f = freshFixture();
    const sessionId = 'sess-unmonitored';
    await toolPair(f, sessionId, 'toolu_u1', { logger: null });

    const turnStart = loadState(f.logsConfig)!.turn_start_ms;
    const transcriptPath = join(f.dir, 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      transcriptLine({ requestId: 'req_1', timestampMs: turnStart + 10, toolUseId: 'toolu_u1' }) + '\n',
      'utf-8',
    );
    await dispatch(
      f, 'Stop', { session_id: sessionId, cwd: '/tmp', transcript_path: transcriptPath },
      { logger: null },
    );

    assert.equal(anyContent(await f.logger.flushed()).length, 0, 'an unarmed session emits no content');
    // Gating content must not gate spans.
    assert.equal(byName(f.tracer.finished(), 'chat claude-test-model').length, 1);
  });

  it('createContentSink returns nothing without a provider', () => {
    assert.equal(createContentSink(null, DEFAULT_CONTENT_LIMITS), undefined);
    assert.equal(createContentSink(undefined, DEFAULT_CONTENT_LIMITS), undefined);
  });
});

// ── Platform wiring ────────────────────────────────────────────────────

describe('the replay platforms reach a conversation source', () => {
  it('claude-code and codex carry the reply on the chat span', async () => {
    for (const platform of ['claude-code', 'codex'] as const) {
      const f = freshFixture();
      const sessionId = `sess-wiring-${platform}`;
      await dispatch(f, 'PreToolUse', {
        tool_name: 'Bash', tool_input: { command: 'ls' },
        tool_use_id: 'toolu_w1', session_id: sessionId, cwd: '/tmp',
      }, { platform });

      const turnStart = loadState(f.logsConfig)!.turn_start_ms;
      const sessionFile = join(f.dir, 'session.jsonl');
      writeFileSync(sessionFile, platform === 'codex'
        ? JSON.stringify({
            timestamp: new Date(turnStart + 10).toISOString(),
            type: 'response_item',
            payload: {
              type: 'message', role: 'assistant',
              content: [{ type: 'output_text', text: 'codex says hello' }],
            },
          }) + '\n'
        : transcriptLine({ requestId: 'req_1', timestampMs: turnStart + 10, toolUseId: 'toolu_w1' }) + '\n',
        'utf-8');

      await dispatch(
        f, 'Stop', { session_id: sessionId, cwd: '/tmp', transcript_path: sessionFile },
        { platform },
      );

      const chats = f.tracer.finished().filter((s) => s.name.startsWith('chat'));
      assert.ok(chats.length >= 1, `${platform}: expected at least one chat span`);
      // The reply is small, so the size rule carries it on the span
      // rather than in a log record — the trace reads without a join.
      assert.ok(
        chats.some((c) => String(c.attributes['nio.chat.reply'] ?? '').length > 0),
        `${platform}: the assistant text must reach the chat span`,
      );
      await f.logger.flushed();
    }
  });
});
