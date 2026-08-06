// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import {
  LoggerProvider,
  InMemoryLogRecordExporter,
  BatchLogRecordProcessor,
  type ReadableLogRecord,
  type LogRecordProcessor,
} from '@opentelemetry/sdk-logs';

export interface InMemoryLogger {
  provider: LoggerProvider;
  exporter: InMemoryLogRecordExporter;
  /**
   * The exported records. THROWS if any record has been emitted but not
   * yet exported — see the note on batching below.
   */
  emitted(): readonly ReadableLogRecord[];
  /** Flush the batch processor, then return the exported records. */
  flushed(): Promise<readonly ReadableLogRecord[]>;
  shutdown(): Promise<void>;
}

/**
 * A `LogRecordProcessor` that only counts — the logs counterpart of
 * `helpers/tracer.ts`'s `EndedSpanCounter`, and for the same reason:
 * it lets the helper distinguish "nothing was emitted" from "something
 * was emitted and is still in the batch queue".
 */
class EmittedRecordCounter implements LogRecordProcessor {
  emitted = 0;
  onEmit(): void { this.emitted += 1; }
  async forceFlush(): Promise<void> { /* nothing buffered */ }
  async shutdown(): Promise<void> { /* nothing to release */ }
}

/**
 * A LoggerProvider that records emitted LogRecords in memory.
 *
 * Mirrors `helpers/tracer.ts` for the logs signal, so a test can assert
 * on the exact record shape — body, attributes, and crucially the
 * built-in `spanContext` the OTLP encoder turns into `trace_id` /
 * `span_id` — without standing up a collector.
 *
 * The processor is the SAME `BatchLogRecordProcessor`, with the same
 * sizing, that `createLoggerProvider` ships, and `emitted()` throws on
 * unflushed records for exactly the reasons documented in
 * `helpers/tracer.ts`. In short: while this helper wired
 * `SimpleLogRecordProcessor`, every logs assertion in the suite ran
 * against export timing production no longer used, which is why swapping
 * `logs-collector.ts` to batching turned no existing test red.
 *
 * Consequence for callers: a record is NOT in the exporter the instant it
 * is emitted. Either drive a production entry point that flushes, or
 * `await logger.flushed()`.
 */
export function makeInMemoryLogger(): InMemoryLogger {
  const exporter = new InMemoryLogRecordExporter();
  const counter = new EmittedRecordCounter();
  const provider = new LoggerProvider({
    // Mirrors createLoggerProvider's processor and sizing exactly.
    processors: [counter, new BatchLogRecordProcessor(exporter, {
      maxQueueSize: 2048,
      maxExportBatchSize: 512,
      scheduledDelayMillis: 1000,
    })],
  });
  const read = (): readonly ReadableLogRecord[] => {
    const out = exporter.getFinishedLogRecords();
    if (counter.emitted > out.length) {
      throw new Error(
        `makeInMemoryLogger: ${counter.emitted - out.length} record(s) have been emitted `
        + 'but are still in the BatchLogRecordProcessor queue. This helper wires the same '
        + 'batch processor production uses, so an emitted record is not exported until '
        + 'something flushes. Await a production entry point that flushes, or '
        + '`await logger.flushed()` before asserting.',
      );
    }
    return out;
  };
  return {
    provider,
    exporter,
    emitted: read,
    flushed: async () => {
      await provider.forceFlush();
      return read();
    },
    shutdown: async () => {
      await provider.shutdown();
    },
  };
}
