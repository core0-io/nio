// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * How many times one tool call's arguments reach the wire.
 *
 * The defect this file exists for: with a conversation source, every
 * tool call shipped its arguments THREE times —
 *
 *   1. `gen_ai.tool.call.arguments` on the tool span (≤ 2 KB),
 *   2. the out-of-band `tool_input` record PostToolUse emits (full), and
 *   3. a second full `tool_input` record `endTurn` built from the chat
 *      call's `tool_use` block.
 *
 * (3) was supposed to be suppressed by `argumentsOnSpan`, an id set
 * derived from `state.deferred_spans` — which is permanently empty since
 * tool spans became eager, so the suppression never fired for any tool
 * call ever.
 *
 * The rule now: **the arguments belong to the site that emits the tool's
 * span.** That site holds one `SpanContent` and knows from it whether the
 * span took the whole body; if it did not, the same site emits the
 * full-fidelity record in the same breath. The turn boundary emits
 * nothing for `tool_use` blocks at all — it replays history and cannot
 * see whether a span exists, so any rule it applied would be a guess.
 *
 * The four combinations below are the contract: source present or not,
 * arguments under or over the span budget. Each case asserts BOTH the
 * count (no duplicate) and the content (nothing lost) — a count-only
 * assertion is satisfied just as well by dropping the payload.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-node';
import type { ReadableLogRecord } from '@opentelemetry/sdk-logs';

import { dispatchCollectorEvent } from '../scripts/lib/collector-core.js';
import { loadState } from '../scripts/lib/traces-state-store.js';
import { SPAN_CONTENT_LIMIT } from '../scripts/lib/content/span-content.js';
import type { ResolvedMetricsConfig, CollectorLogsConfig } from '../adapters/common.js';
import { makeInMemoryTracer } from './helpers/tracer.js';
import { makeInMemoryLogger } from './helpers/logger.js';
import { trackTempDir } from './helpers/tmp-dirs.js';

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

/** Comfortably inside the 2 KB span budget. */
const SMALL_COMMAND = 'ls -la /tmp';
/** Comfortably past it, so the span can only hold a preview. */
const BIG_COMMAND = `grep -rn "needle-${'z'.repeat(SPAN_CONTENT_LIMIT * 2)}" /haystack`;

interface Captured {
  spans: readonly ReadableSpan[];
  records: readonly ReadableLogRecord[];
  argsJson: string;
}

function attr(record: ReadableLogRecord, key: string): unknown {
  return (record.attributes as Record<string, unknown>)[key];
}

function toolInputRecords(records: readonly ReadableLogRecord[]): ReadableLogRecord[] {
  return records.filter((r) => attr(r, 'nio.content.type') === 'tool_input');
}

function byName(spans: readonly ReadableSpan[], name: string): ReadableSpan[] {
  return spans.filter((s) => s.name === name);
}

/**
 * One Claude Code transcript line declaring the same tool call the hook
 * pair below reports — i.e. the session HAS a conversation source, and
 * `endTurn` will rebuild a chat call carrying this `tool_use` block.
 */
function transcriptLine(timestampMs: number, toolUseId: string, args: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'assistant',
    requestId: 'req_1',
    timestamp: new Date(timestampMs).toISOString(),
    message: {
      id: 'req_1',
      model: 'claude-test-model',
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [
        { type: 'text', text: 'running it' },
        { type: 'tool_use', id: toolUseId, name: 'Bash', input: args },
      ],
    },
  });
}

/**
 * Drive one whole tool call — PreToolUse, PostToolUse, Stop — through the
 * real collector against in-memory providers, with or without a
 * transcript for `endTurn` to replay.
 */
async function runToolCall(opts: { command: string; withSource: boolean }): Promise<Captured> {
  const dir = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-tool-input-dedup-')));
  const logsConfig: CollectorLogsConfig = {
    enabled: true, local: true, path: join(dir, 'audit.jsonl'), max_size_mb: 100,
  };
  const tracer = makeInMemoryTracer();
  const logger = makeInMemoryLogger();
  const sessionId = `sess-dedup-${opts.withSource ? 'src' : 'nosrc'}-${opts.command.length}`;
  const toolUseId = 'toolu_dedup_1';
  const args = { command: opts.command, timeout: 120000 };

  const input = {
    tool_name: 'Bash',
    tool_input: args,
    tool_use_id: toolUseId,
    session_id: sessionId,
    cwd: '/tmp',
  };
  const dispatch = (event: 'PreToolUse' | 'PostToolUse' | 'Stop', extra: Record<string, unknown>) =>
    dispatchCollectorEvent({
      event,
      input: { ...input, ...extra } as never,
      platform: 'claude-code',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: tracer.provider,
      loggerProvider: logger.provider,
      logsConfig,
    });

  await dispatch('PreToolUse', {});
  await dispatch('PostToolUse', { tool_response: { output: 'ok' } });

  let transcriptPath: string | undefined;
  if (opts.withSource) {
    const turnStart = loadState(logsConfig, sessionId)!.turn_start_ms;
    transcriptPath = join(dir, 'transcript.jsonl');
    writeFileSync(transcriptPath, transcriptLine(turnStart + 10, toolUseId, args) + '\n', 'utf-8');
  }

  await dispatch('Stop', {
    tool_name: undefined,
    tool_input: undefined,
    ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
  });

  return {
    spans: await tracer.flushed(),
    records: await logger.flushed(),
    argsJson: JSON.stringify(args),
  };
}

/** The tool span, asserted to exist exactly once. */
function toolSpan(spans: readonly ReadableSpan[]): ReadableSpan {
  const found = byName(spans, 'execute_tool Bash');
  assert.equal(found.length, 1, 'exactly one tool span expected');
  return found[0]!;
}

describe('tool arguments are exported once — arguments within the span budget', () => {
  it('with NO conversation source: the span carries them and nothing else does', async () => {
    const { spans, records, argsJson } = await runToolCall({
      command: SMALL_COMMAND, withSource: false,
    });

    const tool = toolSpan(spans);
    assert.equal(
      tool.attributes['gen_ai.tool.call.arguments'], argsJson,
      'the whole payload must be on the span — a degraded session has nowhere else to read it',
    );
    assert.equal(
      tool.attributes['nio.content.truncated'], undefined,
      'no truncation flag means the span copy IS the whole body',
    );
    assert.deepEqual(
      toolInputRecords(records).map((r) => r.body), [],
      'a log record here would be the same bytes a second time',
    );
  });

  it('with a conversation source: still exactly one copy, on the span', async () => {
    const { spans, records, argsJson } = await runToolCall({
      command: SMALL_COMMAND, withSource: true,
    });

    // The source really was usable — otherwise this case would be the
    // no-source case wearing a transcript, and would prove nothing.
    const chats = byName(spans, 'chat claude-test-model');
    assert.equal(chats.length, 1, 'the transcript must have produced a chat span');
    assert.deepEqual(
      chats[0]!.attributes['nio.chat.tool_call_ids'], ['toolu_dedup_1'],
      'the chat call → tool call edge lives on the chat span, not in a duplicate log record',
    );

    assert.equal(toolSpan(spans).attributes['gen_ai.tool.call.arguments'], argsJson);
    assert.deepEqual(
      toolInputRecords(records).map((r) => r.body), [],
      'this is the defect: a source used to add TWO full copies on top of the span attribute',
    );
  });
});

describe('tool arguments are exported once — arguments past the span budget', () => {
  it('with NO conversation source: a truncated span copy plus exactly one full record', async () => {
    const { spans, records, argsJson } = await runToolCall({
      command: BIG_COMMAND, withSource: false,
    });

    const tool = toolSpan(spans);
    const onSpan = tool.attributes['gen_ai.tool.call.arguments'] as string;
    assert.ok(
      Buffer.byteLength(onSpan, 'utf-8') <= SPAN_CONTENT_LIMIT,
      `span copy must respect the ${SPAN_CONTENT_LIMIT}-byte budget, got ${Buffer.byteLength(onSpan, 'utf-8')}`,
    );
    assert.equal(tool.attributes['nio.content.truncated'], true);

    const logged = toolInputRecords(records);
    assert.equal(logged.length, 1, 'exactly one full copy: the span could not hold it');
    assert.equal(logged[0]!.body, argsJson, 'nothing may be lost from the authoritative copy');
    assert.equal(attr(logged[0]!, 'gen_ai.tool.call.id'), 'toolu_dedup_1');
    assert.equal(
      logged[0]!.spanContext!.spanId, tool.spanContext().spanId,
      'the record must name the tool span whose truncated attribute it completes',
    );
  });

  it('with a conversation source: still exactly one full record, not one per producer', async () => {
    const { spans, records, argsJson } = await runToolCall({
      command: BIG_COMMAND, withSource: true,
    });

    const chats = byName(spans, 'chat claude-test-model');
    assert.equal(chats.length, 1, 'the transcript must have produced a chat span');

    const tool = toolSpan(spans);
    assert.equal(tool.attributes['nio.content.truncated'], true);

    const logged = toolInputRecords(records);
    assert.equal(
      logged.length, 1,
      'the chat call\'s `tool_use` block must not add a second full copy',
    );
    assert.equal(logged[0]!.body, argsJson);
    assert.equal(
      logged[0]!.spanContext!.spanId, tool.spanContext().spanId,
      'the surviving copy is the one on the TOOL span — next to `tool_output`, and present '
      + 'whether or not a session has a transcript',
    );
    assert.equal(
      logged.filter((r) => chats.some((c) => c.spanContext().spanId === r.spanContext!.spanId)).length,
      0,
      'no `tool_input` record may be stamped with a chat span any more',
    );
  });
});
