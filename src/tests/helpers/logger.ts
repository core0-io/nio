// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * A LoggerProvider that records emitted LogRecords in memory.
 *
 * Mirrors `helpers/tracer.ts` for the logs signal, so a test can assert
 * on the exact records a code path put on the OTLP logs leg without
 * standing up a collector.
 *
 * ── The processor here MUST match the one production ships ────────────
 *
 * It is currently `SimpleLogRecordProcessor`, because that is what
 * `logs-collector.ts`'s `createLoggerProvider` wires. If that is ever
 * swapped to `BatchLogRecordProcessor`, this helper has to be swapped
 * with it — otherwise every logs assertion in the suite runs against
 * export timing production no longer has, and a record that is emitted
 * but never exported reads here as though it were delivered. A batch
 * version additionally needs an emitted-vs-exported counter so
 * "nothing was emitted" stays distinguishable from "emitted, still
 * queued"; a bare read of the exporter cannot tell those apart.
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
