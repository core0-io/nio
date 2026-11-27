// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Ajv } from 'ajv';
import { readFileSync } from 'node:fs';
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { contentJsonSchema, contentRecordSchema, type ContentPart, type ContentRecord } from '../schemas/content.js';
import type { AssistantMessage } from '../scripts/lib/conversation/types.js';
import { buildContentRecords, buildUserPromptRecord } from '../scripts/lib/content/emit.js';
import { emitAssistantContent, emitUserPromptContent } from '../scripts/lib/content/sink.js';
import { DEFAULT_CONTENT_LIMITS, truncateContent } from '../scripts/lib/content/truncate.js';
import { redactSecrets } from '../scripts/lib/content/redact.js';

const traceId = '1'.repeat(32);
const spanId = '2'.repeat(16);
const limits = { ...DEFAULT_CONTENT_LIMITS };
function message(content = 'short'): AssistantMessage {
  return { id: 'message-1', source: 'test-transcript', blocks: [
    { type: 'thinking', index: 0, content: 'reasoning', fidelity: 'summary' },
    { type: 'text', index: 2, sourceId: 'part-a', content },
    { type: 'text', index: 3, sourceId: 'part-b', content },
  ] };
}
function parts(record: ContentRecord): ContentPart[] {
  return 'gen_ai.input.messages' in record.attributes
    ? record.attributes['gen_ai.input.messages']![0]!.parts : record.attributes['gen_ai.output.messages']![0]!.parts;
}
function prompt(text: string, caps = limits): ContentRecord | null {
  return buildUserPromptRecord({ prompt: text, spanId, traceId }, caps);
}
function upstream(direction: 'input' | 'output') {
  const schema = JSON.parse(readFileSync(new URL(`../../schemas/opentelemetry/gen-ai-${direction}-messages.json`, import.meta.url), 'utf8'));
  return new Ajv({ strict: false, validateFormats: false }).compile(schema);
}
describe('structured observed-message content pipeline', () => {
  it('keeps each short or long observed message intact, ordered and duplicate-preserving', () => {
    const validate = upstream('output');
    for (const text of ['short', '界😀'.repeat(20000)]) {
      const records = buildContentRecords(message(text), spanId, traceId, limits);
      assert.equal(records.length, 1);
      const record = records[0]!;
      assert.deepEqual(parts(record).map((part) => part.type), ['reasoning', 'text', 'text']);
      assert.equal(parts(record)[1]!.content, parts(record)[2]!.content);
      assert.equal(parts(record)[0]!.content, 'reasoning');
      assert.equal(contentRecordSchema.safeParse(record).success, true);
      assert.equal(validate(record.attributes['gen_ai.output.messages']), true, JSON.stringify(validate.errors));
      assert.equal('body' in record, false);
      assert.equal('nio.content.type' in record.attributes, false);
      assert.equal('nio.content.call_id' in record.attributes, false);
      assert.equal('nio.content.source_id' in record.attributes, false);
      assert.equal('nio.content.source' in record.attributes, false);
    }
    const observed = message();
    observed.finishReason = 'tool_call';
    assert.equal(buildContentRecords(observed, spanId, traceId, limits)[0]!.attributes['gen_ai.output.messages']?.[0]!.finish_reason, 'tool_call');
  });

  it('uses independent kind limits on content properties without breaking structured JSON', () => {
    const caps = { thinking: 31, text: 32, user_prompt: 33 };
    const text = '界😀'.repeat(50);
    const assistant = message(text);
    assistant.blocks[0]!.content = text;
    const records = [...buildContentRecords(assistant, spanId, traceId, caps), prompt(text, caps)!];
    for (const record of records) {
      assert.equal(record.attributes['nio.content.truncated'], true);
      assert.equal(record.attributes['nio.content.original_bytes'], Buffer.byteLength(text) * parts(record).length);
      assert.equal(contentRecordSchema.safeParse(JSON.parse(JSON.stringify(record))).success, true);
      for (const [index, part] of parts(record).entries()) {
        const cap = 'gen_ai.input.messages' in record.attributes ? caps.user_prompt : index === 0 ? caps.thinking : caps.text;
        assert.ok(Buffer.byteLength(part.content) <= cap);
        assert.ok(!part.content.includes('\ufffd'));
      }
    }
    assert.deepEqual(parts(prompt('hi')!), [{ type: 'text', content: 'hi' }]);
    assert.equal(prompt(''), null);
  });

  it('emits one user message with ordered original parts, never fabricated input history', () => {
    const record = buildUserPromptRecord({ prompt: 'joined fallback is not emitted', spanId, traceId, sourceId: 'private-id', blocks: [
      { text: 'repeat', index: 0, sourceId: 'a' }, { text: 'repeat', index: 2, sourceId: 'b' },
    ] }, limits)!;
    assert.deepEqual(record.attributes['gen_ai.input.messages'], [{ role: 'user', parts: [
      { type: 'text', content: 'repeat' }, { type: 'text', content: 'repeat' },
    ] }]);
    assert.equal(upstream('input')(record.attributes['gen_ai.input.messages']), true);
    assert.ok(!JSON.stringify(record).includes('private-id'));
    assert.ok(!JSON.stringify(record).includes('joined fallback'));
    assert.equal(record.attributes['nio.content.truncated'], undefined);
    assert.equal(record.attributes['nio.content.redactions'], undefined);
    assert.equal(buildUserPromptRecord({ prompt: 'no invented fallback', blocks: [], spanId, traceId }, limits), null);
  });

  it('redacts whole credentials before UTF8 truncation on prompt, text and native reasoning', () => {
    const secret = `sk-ant-${'a'.repeat(80)}`;
    const text = `safe ${secret} tail`;
    const observed = message(text);
    observed.blocks[0]!.content = text;
    const records = [prompt(text, { ...limits, user_prompt: 20 })!, ...buildContentRecords(observed, spanId, traceId, { ...limits, thinking: 20, text: 20 })];
    for (const record of records) {
      assert.ok(!JSON.stringify(record).includes('sk-ant-'));
      assert.ok(!JSON.stringify(record).includes('aaaa'));
      assert.equal(record.attributes['nio.content.redactions'], parts(record).length);
    }
    const structured = prompt(JSON.stringify({ nested: { password: 'private', api_key: 'custom-token' }, command: 'echo safe' }))!;
    assert.deepEqual(JSON.parse(parts(structured)[0]!.content), { nested: { password: '[REDACTED]', api_key: '[REDACTED]' }, command: 'echo safe' });
    assert.equal(structured.attributes['nio.content.redactions'], 2);
    const benign = '550e8400-e29b-41d4-a716-446655440000 abcdef1234567890 /tmp/abcdef1234';
    assert.deepEqual(redactSecrets(benign), { text: benign, hits: 0 });
    const custom = /internal-[a-z]+/g;
    assert.equal(redactSecrets('internal-secret', [custom]).hits, 1);
    assert.equal(redactSecrets('internal-secret', [custom]).hits, 1);
  });

  it('redacts complete authorization values and fails closed on unsafe deep JSON serialization', () => {
    for (const [scheme, token] of [['Bearer', '+abc/def~ghi=='], ['Bearer', 'a.b_c-d+e/f~g='], ['Basic', 'YWJjL2RlZg==']]) {
      const record = prompt(`Authorization: ${scheme} ${token}\nsafe`)!;
      assert.equal(parts(record)[0]!.content, '[REDACTED]\nsafe');
      assert.equal(record.attributes['nio.content.redactions'], 1);
    }
    const nested = '{"nested":'.repeat(20000) + '{"password":"private-value"}' + '}'.repeat(20000);
    assert.equal(prompt(nested), null);
  });

  it('honors all positive UTF8 caps including caps shorter than the truncation marker', () => {
    const text = '界😀éabc'.repeat(100);
    for (let cap = 1; cap <= 64; cap++) {
      const bounded = truncateContent(text, cap);
      assert.ok(Buffer.byteLength(bounded.text) <= cap, `cap ${cap}`);
      assert.equal(Buffer.from(bounded.text).toString('utf8'), bounded.text);
      assert.ok(!bounded.text.includes('\ufffd'));
      assert.equal(bounded.originalBytes, Buffer.byteLength(text));
    }
    assert.deepEqual(truncateContent(text, 0), { text, truncated: false, originalBytes: Buffer.byteLength(text) });
    assert.equal(truncateContent('界', 3).truncated, false);
  });

  it('matches checked artifacts, validates upstream schemas and requires no private provenance', () => {
    const jsonSchema = contentJsonSchema();
    assert.deepEqual(JSON.parse(readFileSync(new URL('../../schemas/content.schema.json', import.meta.url), 'utf8')), jsonSchema);
    const validate = new Ajv({ strict: false }).compile(jsonSchema);
    const record = prompt('hello')!;
    assert.equal(validate(record), true);
    const minimal = { traceId, spanId, attributes: { 'gen_ai.input.messages': [{ role: 'user', parts: [{ type: 'text', content: 'hello' }] }] } };
    assert.equal(contentRecordSchema.safeParse(minimal).success, true);
    assert.equal(validate(minimal), true);
    const mismatched = { ...record, attributes: { ...record.attributes, 'nio.span_id': '3'.repeat(16) } };
    assert.equal(contentRecordSchema.safeParse(mismatched).success, false);
    for (const attributes of [
      {}, { 'gen_ai.input.messages': [{ role: 'user', parts: 'bad' }] },
      { 'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: 'hi' }] }] },
      { 'gen_ai.input.messages': [{ role: 'user', parts: [{ type: 'text', content: 7 }] }] },
    ]) assert.equal(contentRecordSchema.safeParse({ traceId, spanId, attributes }).success, false);
    assert.equal(upstream('output')([{ role: 'assistant', parts: [{ type: 'text', content: 'hi' }] }]), false);
    assert.equal(upstream('input')([{ role: 'user', parts: 'bad' }]), false);
  });

  it('rejects invalid associations, unordered positions, unsupported-only content and invalid caps', () => {
    assert.deepEqual(buildContentRecords(message(), '', traceId, limits), []);
    assert.equal(buildUserPromptRecord({ prompt: 'hi', spanId, traceId: 'bad' }, limits), null);
    const unordered = message();
    unordered.blocks[2]!.index = 1;
    assert.deepEqual(buildContentRecords(unordered, spanId, traceId, limits), []);
    assert.equal(buildUserPromptRecord({ prompt: 'hi', spanId, traceId, blocks: [{ text: 'x', index: -1 }] }, limits), null);
    for (const cap of [-1, NaN, Infinity]) assert.equal(prompt('hi', { ...limits, user_prompt: cap }), null);
    assert.deepEqual(buildContentRecords({ id: 'tool-only', blocks: [] }, spanId, traceId, limits), []);
  });

  it('gates direct sinks on providers and exports actual trace/span context with nested attributes', async () => {
    emitAssistantContent(null, limits, message(), spanId, traceId);
    emitUserPromptContent(null, limits, { prompt: 'private', spanId, traceId });
    const exporter = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor(exporter)] });
    try {
      emitAssistantContent(provider, limits, message(), spanId, traceId);
      emitUserPromptContent(provider, limits, { prompt: 'hello', spanId, traceId });
      emitUserPromptContent(provider, limits, { prompt: 'unassociated', spanId: '', traceId });
      await provider.forceFlush();
      const records = exporter.getFinishedLogRecords();
      assert.equal(records.length, 2);
      assert.deepEqual(records[0]!.attributes['gen_ai.output.messages'], [{ role: 'assistant', finish_reason: 'unknown', parts: [
        { type: 'reasoning', content: 'reasoning' }, { type: 'text', content: 'short' }, { type: 'text', content: 'short' },
      ] }]);
      for (const record of records) {
        assert.equal(record.spanContext?.traceId, traceId);
        assert.equal(record.spanContext?.spanId, spanId);
        assert.equal(record.body, undefined);
        assert.equal(record.attributes['nio.trace_id'], traceId);
        assert.equal(record.attributes['nio.span_id'], spanId);
      }
    } finally { await provider.shutdown(); }
  });
});
