// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Ajv } from 'ajv';
import { readFileSync } from 'node:fs';
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { CONTENT_TYPES, contentJsonSchema, contentRecordSchema } from '../schemas/content.js';
import type { ChatCall } from '../scripts/lib/conversation/types.js';
import { buildContentRecords, buildToolInputRecord, buildToolOutputRecord, buildUserPromptRecord } from '../scripts/lib/content/emit.js';
import { createContentSink, emitToolInputContent, emitToolOutputContent, emitUserPromptContent } from '../scripts/lib/content/sink.js';
import { DEFAULT_CONTENT_LIMITS, truncateContent } from '../scripts/lib/content/truncate.js';
import { redactSecrets } from '../scripts/lib/content/redact.js';

const traceId = '1'.repeat(32);
const spanId = '2'.repeat(16);
const limits = { ...DEFAULT_CONTENT_LIMITS };
function call(content = 'short'): ChatCall {
  return {
    callId: 'message-1', source: 'test-transcript', startMs: 1, endMs: 2, timing: 'exact', isSidechain: false,
    blocks: [
      { type: 'thinking', index: 0, content: 'reasoning', fidelity: 'summary' },
      { type: 'text', index: 2, sourceId: 'part-a', content },
      { type: 'text', index: 3, sourceId: 'part-b', content },
      { type: 'tool_use', index: 4, content: '{}', toolUse: { id: 'tool-1', name: 'read', input: '{}' } },
    ],
  };
}

describe('linked content pipeline', () => {
  it('logs short and long text without replaying tool arguments or deduplicating equal blocks', () => {
    for (const body of ['short', '界😀'.repeat(20000)]) {
      const records = buildContentRecords(call(body), spanId, traceId, limits);
      assert.equal(records.length, 3);
      assert.deepEqual(records.map((r) => r.attributes['nio.content.index']), [0, 2, 3]);
      assert.deepEqual(records.map((r) => r.attributes['nio.content.type']), ['thinking', 'text', 'text']);
      assert.equal(records[0]!.attributes['nio.content.fidelity'], 'summary');
      assert.equal(records[1]!.attributes['nio.content.source_id'], 'part-a');
      assert.equal(records[2]!.attributes['nio.content.source_id'], 'part-b');
      for (const record of records) {
        assert.equal(record.attributes['nio.content.call_id'], 'message-1');
        assert.equal(record.attributes['nio.content.source'], 'test-transcript');
        assert.equal(contentRecordSchema.safeParse(record).success, true);
      }
    }
  });

  it('uses each independent kind limit and emits prompt and tool records even when short', () => {
    const perKind = { thinking: 31, text: 32, user_prompt: 33, tool_input: 34, tool_output: 35 };
    const text = '界😀'.repeat(50);
    const chat = call(text);
    chat.blocks[0]!.content = text;
    const records = [
      ...buildContentRecords(chat, spanId, traceId, perKind).slice(0, 2),
      buildUserPromptRecord(text, spanId, traceId, perKind, 7)!,
      buildToolInputRecord(text, spanId, traceId, perKind, 'tool-1')!,
      buildToolOutputRecord(text, spanId, traceId, perKind, 'tool-1')!,
    ];
    assert.deepEqual(records.map((r) => r.attributes['nio.content.type']), CONTENT_TYPES);
    for (const record of records) {
      const kind = record.attributes['nio.content.type'];
      assert.ok(Buffer.byteLength(record.body) <= perKind[kind]);
      assert.equal(record.attributes['nio.content.truncated'], true);
      assert.equal(record.attributes['nio.content.original_bytes'], Buffer.byteLength(text));
      assert.equal(contentRecordSchema.safeParse(record).success, true);
    }
    assert.equal(records[2]!.attributes['nio.content.index'], 7);
    assert.equal(records[3]!.attributes['gen_ai.tool.call.id'], 'tool-1');
    assert.equal(buildUserPromptRecord('hi', spanId, traceId, limits)!.body, 'hi');
    assert.equal(buildToolInputRecord('{}', spanId, traceId, limits)!.body, '{}');
    assert.equal(buildToolOutputRecord('ok', spanId, traceId, limits)!.body, 'ok');
    assert.equal(buildUserPromptRecord('', spanId, traceId, limits), null);
  });

  it('redacts whole credentials before truncation and protects structured secret keys', () => {
    const secret = `sk-ant-${'a'.repeat(80)}`;
    const record = buildUserPromptRecord(`safe ${secret} tail`, spanId, traceId, { ...limits, user_prompt: 32 })!;
    assert.ok(!record.body.includes('sk-ant-'));
    assert.ok(!record.body.includes('aaaa'));
    assert.equal(record.attributes['nio.content.redactions'], 1);
    const structured = buildToolInputRecord(JSON.stringify({ nested: { password: 'private', api_key: 'custom-token' }, command: 'echo safe' }), spanId, traceId, limits)!;
    assert.deepEqual(JSON.parse(structured.body), { nested: { password: '[REDACTED]', api_key: '[REDACTED]' }, command: 'echo safe' });
    assert.equal(structured.attributes['nio.content.redactions'], 2);
    const benign = '550e8400-e29b-41d4-a716-446655440000 abcdef1234567890 /tmp/abcdef1234';
    assert.deepEqual(redactSecrets(benign), { text: benign, hits: 0 });
    const custom = /internal-[a-z]+/g;
    assert.equal(redactSecrets('internal-secret', [custom]).hits, 1);
    assert.equal(redactSecrets('internal-secret', [custom]).hits, 1);
  });

  it('redacts complete Bearer and Basic tokens including valid symbols and padding', () => {
    for (const [scheme, token] of [['Bearer', '+abc/def~ghi=='], ['Bearer', 'a.b_c-d+e/f~g='], ['Basic', 'YWJjL2RlZg==']]) {
      const record = buildToolOutputRecord(`Authorization: ${scheme} ${token}\nsafe`, spanId, traceId, limits)!;
      assert.equal(record.body, '[REDACTED]\nsafe');
      assert.equal(record.attributes['nio.content.redactions'], 1);
    }
    const nested = '{"nested":'.repeat(20000) + '{"password":"private-value"}' + '}'.repeat(20000);
    assert.equal(buildToolOutputRecord(nested, spanId, traceId, limits), null);
  });

  it('honors all positive UTF8 byte caps including caps shorter than the marker', () => {
    const input = '界😀éabc'.repeat(100);
    for (let cap = 1; cap <= 64; cap++) {
      const result = truncateContent(input, cap);
      assert.ok(Buffer.byteLength(result.text) <= cap, `cap ${cap}`);
      assert.equal(Buffer.from(result.text).toString('utf8'), result.text);
      assert.ok(!result.text.includes('\ufffd'));
      assert.equal(result.originalBytes, Buffer.byteLength(input));
    }
    assert.deepEqual(truncateContent(input, 0), { text: input, truncated: false, originalBytes: Buffer.byteLength(input) });
    assert.equal(truncateContent('界', 3).truncated, false);
  });

  it('matches the checked-in JSON schema and rejects missing provenance and mismatched joins', () => {
    const jsonSchema = contentJsonSchema();
    const artifact = JSON.parse(readFileSync(new URL('../../schemas/content.schema.json', import.meta.url), 'utf8'));
    assert.deepEqual(artifact, jsonSchema);
    const validate = new Ajv({ strict: false }).compile(jsonSchema);
    const record = buildUserPromptRecord('hello', spanId, traceId, limits)!;
    assert.equal(validate(record), true);
    const missing = structuredClone(record) as { attributes: Record<string, unknown> };
    delete missing.attributes['nio.content.source'];
    assert.equal(contentRecordSchema.safeParse(missing).success, false);
    assert.equal(validate(missing), false);
    const mismatched = structuredClone(record);
    mismatched.attributes['nio.span_id'] = '3'.repeat(16);
    assert.equal(contentRecordSchema.safeParse(mismatched).success, false);
    const invalidIndex = structuredClone(record);
    invalidIndex.attributes['nio.content.index'] = -1;
    assert.equal(contentRecordSchema.safeParse(invalidIndex).success, false);
  });

  it('gates every sink on the provider and emits real built-in trace/span context', async () => {
    assert.equal(createContentSink(null, limits), undefined);
    emitUserPromptContent(null, limits, { prompt: 'private', spanId, traceId });
    emitToolInputContent(null, limits, { input: 'private', spanId, traceId });
    emitToolOutputContent(null, limits, { result: 'private', spanId, traceId });
    const exporter = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor(exporter)] });
    try {
      createContentSink(provider, limits)!(call(), spanId, traceId);
      emitUserPromptContent(provider, limits, { prompt: 'hello', spanId, traceId, index: 5 });
      emitToolInputContent(provider, limits, { input: '{}', spanId, traceId, toolCallId: 'tool-1' });
      emitToolOutputContent(provider, limits, { result: 'ok', spanId, traceId, toolCallId: 'tool-1' });
      emitUserPromptContent(provider, limits, { prompt: 'unassociated', spanId: '', traceId });
      await provider.forceFlush();
      const records = exporter.getFinishedLogRecords();
      assert.equal(records.length, 6);
      for (const record of records) {
        assert.equal(record.spanContext?.traceId, traceId);
        assert.equal(record.spanContext?.spanId, spanId);
        assert.equal(record.attributes['nio.trace_id'], traceId);
        assert.equal(record.attributes['nio.span_id'], spanId);
        assert.equal(record.attributes.event, undefined);
      }
    } finally {
      await provider.shutdown();
    }
  });
});
