// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * The test helpers must run the processors production runs.
 *
 * `traces-collector.ts` swapped `SimpleSpanProcessor` → `BatchSpanProcessor`
 * and `logs-collector.ts` swapped `SimpleLogRecordProcessor` →
 * `BatchLogRecordProcessor`, because the Simple variants start one export
 * per item and a turn's synchronous burst blew through the OTLP exporter's
 * 30-in-flight cap, silently losing the overflow (the turn root among it).
 *
 * Neither swap turned a single existing test red — and that was not luck.
 * `helpers/tracer.ts` and `helpers/logger.ts` built their own providers
 * with the Simple processors, so the entire assertion surface of this suite
 * was exercising export timing production had stopped using. A harness that
 * cannot express production's behaviour cannot catch a defect in it.
 *
 * These cases pin the helpers to the production processors. Put either
 * helper back on a Simple processor — the one "simplification" that would
 * make every timing-sensitive test in the suite pass again for free — and
 * this file goes red.
 *
 * They also pin the second half of the fix: the sync accessors REFUSE to
 * answer while items are still queued. Without that, batching would quietly
 * turn every negative assertion (`assert.equal(finished().length, 0)`) into
 * a tautology satisfied by an unexported item. That is not theoretical:
 * switching the helpers turned up two such assertions in the existing suite
 * (`content-wiring › emits nothing when the tool took no arguments` and
 * `plugin-runtime-monitor › never puts an unmonitored session's audit rows
 * on the OTLP logs signal`), both of which had been passing without
 * verifying anything.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { makeInMemoryTracer } from './helpers/tracer.js';
import { makeInMemoryLogger } from './helpers/logger.js';

describe('test helpers run the same processors production runs', () => {
  it('makeInMemoryTracer batches: an ended span is not exported until a flush', async () => {
    const tracer = makeInMemoryTracer();
    try {
      tracer.provider.getTracer('parity').startSpan('probe-span').end();

      // Read the exporter directly — `finished()` deliberately throws in
      // this state, and what is under test here is the batching itself.
      assert.equal(
        tracer.exporter.getFinishedSpans().length, 0,
        'a SimpleSpanProcessor would have exported this span inside end(); '
        + 'the helper must wire the BatchSpanProcessor production wires',
      );

      const flushed = await tracer.flushed();
      assert.equal(flushed.length, 1, 'the flush must deliver the span');
      assert.equal(flushed[0]!.name, 'probe-span');
    } finally {
      await tracer.shutdown();
    }
  });

  it('makeInMemoryTracer.finished() refuses to answer while spans are queued', async () => {
    const tracer = makeInMemoryTracer();
    try {
      tracer.provider.getTracer('parity').startSpan('unflushed-span').end();

      assert.throws(
        () => tracer.finished(),
        /still in the BatchSpanProcessor queue/,
        'a queued span must produce a loud failure, not a silently empty list that '
        + 'makes every "nothing was exported" assertion vacuous',
      );

      await tracer.flushed();
      assert.equal(
        tracer.finished().length, 1,
        'and once drained the accessor answers normally again',
      );
    } finally {
      await tracer.shutdown();
    }
  });

  it('makeInMemoryLogger batches: an emitted record is not exported until a flush', async () => {
    const logger = makeInMemoryLogger();
    try {
      logger.provider.getLogger('parity').emit({ body: 'probe-record' });

      assert.equal(
        logger.exporter.getFinishedLogRecords().length, 0,
        'a SimpleLogRecordProcessor would have exported this record inside emit(); '
        + 'the helper must wire the BatchLogRecordProcessor production wires',
      );

      const flushed = await logger.flushed();
      assert.equal(flushed.length, 1, 'the flush must deliver the record');
      assert.equal(String(flushed[0]!.body), 'probe-record');
    } finally {
      await logger.shutdown();
    }
  });

  it('makeInMemoryLogger.emitted() refuses to answer while records are queued', async () => {
    const logger = makeInMemoryLogger();
    try {
      logger.provider.getLogger('parity').emit({ body: 'unflushed-record' });

      assert.throws(
        () => logger.emitted(),
        /still in the BatchLogRecordProcessor queue/,
        'a queued record must produce a loud failure, not a silently empty list',
      );

      await logger.flushed();
      assert.equal(
        logger.emitted().length, 1,
        'and once drained the accessor answers normally again',
      );
    } finally {
      await logger.shutdown();
    }
  });
});
