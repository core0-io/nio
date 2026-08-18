// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * A LoggerProvider that records emitted LogRecords in memory.
 *
 * Mirrors `helpers/tracer.ts` for the logs signal, so a test can assert
 * on the exact records a code path put on the OTLP logs leg without
 * standing up a collector. The processor is the same
 * `SimpleLogRecordProcessor` `createLoggerProvider` ships.
 */

import {
  LoggerProvider,
  InMemoryLogRecordExporter,
  SimpleLogRecordProcessor,
  type ReadableLogRecord,
} from '@opentelemetry/sdk-logs';

export interface InMemoryLogger {
  provider: LoggerProvider;
  exporter: InMemoryLogRecordExporter;
  /** Flush the provider, then return the exported records. */
  flushed(): Promise<readonly ReadableLogRecord[]>;
  shutdown(): Promise<void>;
}

export function makeInMemoryLogger(): InMemoryLogger {
  const exporter = new InMemoryLogRecordExporter();
  const provider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor(exporter)],
  });
  return {
    provider,
    exporter,
    flushed: async () => {
      await provider.forceFlush();
      return exporter.getFinishedLogRecords();
    },
    shutdown: async () => {
      await provider.shutdown();
    },
  };
}
