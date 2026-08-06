// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression: content records with an empty body must not be emitted.
 *
 * Measured live on 2026-08-06 against SigNoz: every `thinking` content
 * record on the wire had a zero-length body (21/21), while `text`,
 * `tool_input` and `tool_output` had none. The cause is upstream of nio —
 * that Claude Code session's transcript held 382 `thinking` blocks, all
 * with `thinking: ""` and only `signature` populated — but the behaviour
 * here was still wrong: the record went out carrying
 * `nio.content.fidelity = 'full'`, which reads downstream as "the model
 * reasoned, and its reasoning was blank".
 *
 * The fixtures below therefore use the shape the host actually writes —
 * a thinking block whose `content` is `''` — because the pre-existing
 * emit tests could not express it: every fixture block had text.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildContentRecords,
  buildToolInputRecord,
  buildToolOutputRecord,
} from '../scripts/lib/content/emit.js';
import type { ChatCall, ContentBlock } from '../scripts/lib/conversation/types.js';
import { DEFAULT_CONTENT_LIMITS, type ContentLimits } from '../scripts/lib/content/truncate.js';

function makeCall(blocks: ContentBlock[]): ChatCall {
  return {
    callId: 'c1',
    startMs: 1,
    endMs: 2,
    timing: 'inferred',
    isSidechain: false,
    blocks,
  };
}

describe('empty content records are not emitted', () => {
  it('emits no record for a thinking block with no text', () => {
    // Exactly what Claude Code writes: signature only, body empty.
    const call = makeCall([
      { type: 'thinking', index: 0, content: '', fidelity: 'full' },
      { type: 'text', index: 1, content: 'visible answer' },
    ]);

    const records = buildContentRecords(call, 'span1', 'trace1', DEFAULT_CONTENT_LIMITS);

    assert.equal(
      records.filter((r) => r.attributes['nio.content.type'] === 'thinking').length,
      0
    );
    assert.equal(records.filter((r) => r.attributes['nio.content.type'] === 'text').length, 1);
  });

  it('drops the empty block without disturbing the surviving blocks', () => {
    // The suppressed block sits between two kept ones: the survivors must
    // keep their own `nio.content.index` (the block's position in the
    // call), not be renumbered into a dense 0..n-1 sequence.
    const call = makeCall([
      { type: 'text', index: 0, content: 'before' },
      { type: 'thinking', index: 1, content: '', fidelity: 'full' },
      {
        type: 'tool_use',
        index: 2,
        content: 'ls -la',
        toolUse: { id: 'tool-1', name: 'Bash', input: '{"command":"ls -la"}' },
      },
    ]);

    const records = buildContentRecords(call, 'span1', 'trace1', DEFAULT_CONTENT_LIMITS);

    assert.deepEqual(
      records.map((r) => r.attributes['nio.content.type']),
      ['text', 'tool_input']
    );
    assert.deepEqual(
      records.map((r) => r.attributes['nio.content.index']),
      [0, 2]
    );
  });

  it('suppresses an empty block of any kind, not only thinking', () => {
    // An empty record carries no information under any content type.
    const call = makeCall([
      { type: 'text', index: 0, content: '' },
      { type: 'tool_use', index: 1, content: '', toolUse: { id: 't', name: 'Bash', input: '' } },
      { type: 'thinking', index: 2, content: '', fidelity: 'summary' },
    ]);

    assert.deepEqual(buildContentRecords(call, 'span1', 'trace1', DEFAULT_CONTENT_LIMITS), []);
  });

  it('still emits a non-empty thinking block, with its fidelity intact', () => {
    // Guards against "fix" by suppressing thinking wholesale: a platform
    // whose transcript does carry reasoning text must keep exporting it.
    const call = makeCall([{ type: 'thinking', index: 0, content: 'weighing options', fidelity: 'summary' }]);

    const records = buildContentRecords(call, 'span1', 'trace1', DEFAULT_CONTENT_LIMITS);

    assert.equal(records.length, 1);
    assert.equal(records[0]!.body, 'weighing options');
    assert.equal(records[0]!.attributes['nio.content.fidelity'], 'summary');
  });

  it('emits a block whose body survives redaction as a non-empty marker', () => {
    // Redaction replaces a secret with `[REDACTED]` rather than deleting
    // it, so a block that is nothing but a secret is NOT empty and must
    // still be reported — the fact that a credential was in the stream is
    // itself the signal.
    const call = makeCall([{ type: 'text', index: 0, content: 'AKIAIOSFODNN7EXAMPLE' }]);

    const records = buildContentRecords(call, 'span1', 'trace1', DEFAULT_CONTENT_LIMITS);

    assert.equal(records.length, 1);
    assert.ok(records[0]!.body.includes('[REDACTED]'));
  });

  it('judges emptiness after truncation, not before', () => {
    // A limit below the truncation marker's own byte length leaves a
    // marker-only body. That is still a record ("something was here, and
    // it was too big"), so it must survive — this pins the emptiness test
    // to the post-redact, post-truncate body rather than to a length
    // check on the raw block, and pins the redact→truncate order the
    // module doc requires.
    const limits: ContentLimits = { ...DEFAULT_CONTENT_LIMITS, text: 4 };
    const call = makeCall([{ type: 'text', index: 0, content: 'a'.repeat(100) }]);

    const records = buildContentRecords(call, 'span1', 'trace1', limits);

    assert.equal(records.length, 1);
    assert.notEqual(records[0]!.body.length, 0);
    assert.equal(records[0]!.attributes['nio.content.truncated'], true);
  });

  it('returns null instead of an empty tool_output record', () => {
    assert.equal(buildToolOutputRecord('', 'span1', 'trace1', DEFAULT_CONTENT_LIMITS, 'tc1'), null);
    assert.notEqual(
      buildToolOutputRecord('done', 'span1', 'trace1', DEFAULT_CONTENT_LIMITS, 'tc1'),
      null
    );
  });

  it('returns null instead of an empty tool_input record', () => {
    assert.equal(buildToolInputRecord('', 'span1', 'trace1', DEFAULT_CONTENT_LIMITS, 'tc1'), null);
    assert.notEqual(
      buildToolInputRecord('{"a":1}', 'span1', 'trace1', DEFAULT_CONTENT_LIMITS, 'tc1'),
      null
    );
  });
});
