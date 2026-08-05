// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import {
  LoggerProvider,
  InMemoryLogRecordExporter,
  SimpleLogRecordProcessor,
  type ReadableLogRecord,
} from '@opentelemetry/sdk-logs';

export interface InMemoryLogger {
  provider: LoggerProvider;
  exporter: InMemoryLogRecordExporter;
  emitted(): readonly ReadableLogRecord[];
  shutdown(): Promise<void>;
}

/**
 * A LoggerProvider that records emitted LogRecords in memory.
 *
 * Mirrors `helpers/tracer.ts` for the logs signal, so a test can assert
 * on the exact record shape — body, attributes, and crucially the
 * built-in `spanContext` the OTLP encoder turns into `trace_id` /
 * `span_id` — without standing up a collector.
 */
export function makeInMemoryLogger(): InMemoryLogger {
  const exporter = new InMemoryLogRecordExporter();
  const provider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor(exporter)],
  });
  return {
    provider,
    exporter,
    emitted: () => exporter.getFinishedLogRecords(),
    shutdown: async () => {
      await provider.shutdown();
    },
  };
}
