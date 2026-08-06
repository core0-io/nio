// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildContentRecords } from '../scripts/lib/content/emit.js';
import type { ChatCall, ContentBlock } from '../scripts/lib/conversation/types.js';
import type { ContentLimits } from '../scripts/lib/content/truncate.js';

const GENEROUS_LIMITS: ContentLimits = {
  thinking: 65536,
  text: 65536,
  user_prompt: 65536,
  tool_input: 65536,
  tool_output: 65536,
};

/**
 * A reply too big for the span budget (`SPAN_CONTENT_LIMIT`, 2 KB — see
 * `content/span-content.ts`), so the logs signal stays authoritative for
 * it and a record IS produced.
 *
 * Every `text` fixture below is oversized on purpose. Under the
 * size-based placement rule a SMALL reply rides on `nio.chat.reply` and
 * emits no log record at all; a short fixture would therefore make these
 * assertions vacuous rather than wrong. The small-reply side of the rule
 * is pinned in `content-placement.test.ts`.
 */
const LONG_TEXT = `hello there ${'padding '.repeat(400)}`;

function makeCall(blocks: ContentBlock[]): ChatCall {
  return {
    callId: 'call-1',
    startMs: 0,
    endMs: 1,
    timing: 'exact',
    blocks,
    isSidechain: false,
  };
}

describe('buildContentRecords — shape and ordering', () => {
  it('produces one record per block, in order, with index preserved', () => {
    const call = makeCall([
      { type: 'thinking', index: 0, content: 'pondering', fidelity: 'full' },
      { type: 'text', index: 1, content: LONG_TEXT },
      {
        type: 'tool_use',
        index: 2,
        content: 'ls -la',
        toolUse: { id: 'tool-abc', name: 'Bash', input: '{"command":"ls -la"}' },
      },
    ]);

    const records = buildContentRecords(call, 'span-1', 'trace-1', GENEROUS_LIMITS);

    assert.equal(records.length, 3);
    assert.deepEqual(
      records.map((r) => r.attributes['nio.content.index']),
      [0, 1, 2]
    );
    assert.deepEqual(
      records.map((r) => r.attributes['nio.content.type']),
      ['thinking', 'text', 'tool_input']
    );
  });

  it('only the thinking record carries nio.content.fidelity', () => {
    const call = makeCall([
      { type: 'thinking', index: 0, content: 'pondering', fidelity: 'summary' },
      { type: 'text', index: 1, content: LONG_TEXT },
      {
        type: 'tool_use',
        index: 2,
        content: 'ls -la',
        toolUse: { id: 'tool-abc', name: 'Bash', input: '{}' },
      },
    ]);

    const [thinkingRec, textRec, toolRec] = buildContentRecords(call, 's', 't', GENEROUS_LIMITS);

    assert.equal(thinkingRec!.attributes['nio.content.fidelity'], 'summary');
    assert.equal(textRec!.attributes['nio.content.fidelity'], undefined);
    assert.equal(toolRec!.attributes['nio.content.fidelity'], undefined);
  });

  it('only the tool_use record carries gen_ai.tool.call.id', () => {
    const call = makeCall([
      { type: 'text', index: 0, content: LONG_TEXT },
      {
        type: 'tool_use',
        index: 1,
        content: 'ls -la',
        toolUse: { id: 'tool-xyz', name: 'Bash', input: '{}' },
      },
    ]);

    const [textRec, toolRec] = buildContentRecords(call, 's', 't', GENEROUS_LIMITS);

    assert.equal(textRec!.attributes['gen_ai.tool.call.id'], undefined);
    assert.equal(toolRec!.attributes['gen_ai.tool.call.id'], 'tool-xyz');
  });

  it('returns an empty array for a call with no blocks', () => {
    const call = makeCall([]);
    const records = buildContentRecords(call, 's', 't', GENEROUS_LIMITS);
    assert.deepEqual(records, []);
  });
});

describe('buildContentRecords — trace/span association', () => {
  it('sets traceId/spanId as built-in fields and duplicates them as redundant attributes', () => {
    const call = makeCall([{ type: 'text', index: 0, content: LONG_TEXT }]);
    const [rec] = buildContentRecords(call, 'span-42', 'trace-99', GENEROUS_LIMITS);

    assert.equal(rec!.traceId, 'trace-99');
    assert.equal(rec!.spanId, 'span-42');
    assert.equal(rec!.attributes['nio.trace_id'], 'trace-99');
    assert.equal(rec!.attributes['nio.span_id'], 'span-42');
  });
});

describe('buildContentRecords — redaction', () => {
  it('redacts a secret in body text and reports the hit count', () => {
    const call = makeCall([
      {
        type: 'text',
        index: 0,
        content: `my key is sk-ant-api03-AbCdEf1234567890AbCdEf1234567890AbCdEf12 ok ${LONG_TEXT}`,
      },
    ]);
    const [rec] = buildContentRecords(call, 's', 't', GENEROUS_LIMITS);

    assert.ok(rec!.body.includes('[REDACTED]'));
    assert.ok(!rec!.body.includes('sk-ant-api03'));
    assert.equal(rec!.attributes['nio.content.redactions'], 1);
  });

  it('omits nio.content.redactions when nothing was redacted', () => {
    const call = makeCall([{ type: 'text', index: 0, content: `nothing secret here ${LONG_TEXT}` }]);
    const [rec] = buildContentRecords(call, 's', 't', GENEROUS_LIMITS);
    assert.equal(rec!.attributes['nio.content.redactions'], undefined);
  });
});

describe('buildContentRecords — truncation', () => {
  it('truncates an overlong body and reports truncated + original_bytes', () => {
    const limits: ContentLimits = { ...GENEROUS_LIMITS, text: 20 };
    const call = makeCall([{ type: 'text', index: 0, content: 'a'.repeat(3_000) }]);
    const [rec] = buildContentRecords(call, 's', 't', limits);

    assert.equal(rec!.attributes['nio.content.truncated'], true);
    assert.equal(rec!.attributes['nio.content.original_bytes'], 3_000);
    assert.ok(Buffer.byteLength(rec!.body, 'utf-8') <= 20);
  });

  it('omits truncated/original_bytes when the body fits under the limit', () => {
    const call = makeCall([{ type: 'text', index: 0, content: LONG_TEXT }]);
    const [rec] = buildContentRecords(call, 's', 't', GENEROUS_LIMITS);
    assert.equal(rec!.attributes['nio.content.truncated'], undefined);
    assert.equal(rec!.attributes['nio.content.original_bytes'], undefined);
  });
});

describe('buildContentRecords — redact-before-truncate ordering', () => {
  // AWS access key id: AKIA + 16 uppercase alphanumerics = 20 bytes, ASCII.
  const SECRET = 'AKIAIOSFODNN7EXAMPLE';

  it('never leaves a secret fragment in the body when the secret straddles the truncation cut point', () => {
    // Layout: 5-byte prefix, then the 20-byte secret, then a long suffix.
    // limit is chosen so that truncating the RAW text (secret still intact)
    // would cut exactly 10 bytes into the secret — i.e. right through its
    // middle — while truncating the REDACTED text (secret already replaced
    // by the much shorter `[REDACTED]` marker) cuts safely inside the
    // marker instead, long before the suffix.
    //
    // TRUNCATION_MARKER = '…[truncated]' = 14 UTF-8 bytes.
    // budget = limit - 14.
    // prefix (5 bytes) + 10 bytes into SECRET = 15 bytes => limit = 15 + 14 = 29.
    const prefix = 'x'.repeat(5);
    const suffix = 'y'.repeat(3_000);
    const content = `${prefix}${SECRET}${suffix}`;
    const limit = 29;

    const limits: ContentLimits = { ...GENEROUS_LIMITS, text: limit };
    const call = makeCall([{ type: 'text', index: 0, content }]);
    const [rec] = buildContentRecords(call, 's', 't', limits);

    // Sanity: this scenario does hit the truncator.
    assert.equal(rec!.attributes['nio.content.truncated'], true);

    // The load-bearing assertion: no matter where the cut falls, redaction
    // ran on the FULL secret first, so no recognizable fragment of it
    // (starting with the distinctive "AKIA" prefix) can appear in the body.
    assert.ok(
      !rec!.body.includes('AKIA'),
      `expected no secret fragment in truncated body, got: ${rec!.body}`
    );
  });
});

describe('buildContentRecords — per-kind limits', () => {
  it('uses limits.thinking for thinking blocks', () => {
    // 20 bytes: comfortably above the 14-byte truncation marker itself,
    // while still well under the 50-byte content.
    const limits: ContentLimits = { ...GENEROUS_LIMITS, thinking: 20 };
    const call = makeCall([{ type: 'thinking', index: 0, content: 'a'.repeat(50), fidelity: 'full' }]);
    const [rec] = buildContentRecords(call, 's', 't', limits);
    assert.equal(rec!.attributes['nio.content.truncated'], true);
    assert.ok(Buffer.byteLength(rec!.body, 'utf-8') <= 20);
  });

  it('uses limits.tool_input (not limits.tool_output or others) for tool_use blocks', () => {
    const limits: ContentLimits = { ...GENEROUS_LIMITS, tool_input: 20, tool_output: 65536 };
    const call = makeCall([
      {
        type: 'tool_use',
        index: 0,
        content: 'a'.repeat(50),
        toolUse: { id: 'tool-1', name: 'Bash', input: '{}' },
      },
    ]);
    const [rec] = buildContentRecords(call, 's', 't', limits);
    assert.equal(rec!.attributes['nio.content.truncated'], true);
    assert.ok(Buffer.byteLength(rec!.body, 'utf-8') <= 20);
  });

  it('a generous thinking limit leaves a thinking block untruncated even when tool_input is tiny', () => {
    const limits: ContentLimits = { ...GENEROUS_LIMITS, tool_input: 1 };
    const call = makeCall([{ type: 'thinking', index: 0, content: 'a'.repeat(50), fidelity: 'full' }]);
    const [rec] = buildContentRecords(call, 's', 't', limits);
    assert.equal(rec!.attributes['nio.content.truncated'], undefined);
  });
});
