// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Exporter diagnostics — make OTLP send failures auditable.
 *
 * The OTEL SDK swallows export failures: SimpleSpanProcessor /
 * SimpleLogRecordProcessor / PeriodicExportingMetricReader invoke the
 * exporter's `export(items, cb)` and the FAILED result never bubbles up to
 * our code, so a collector that can't reach its endpoint (connection
 * refused, auth rejected, bad protocol/URL, timeout) fails silently.
 *
 * `instrumentExporter()` wraps an exporter's `export()` so any FAILED result
 * — or a synchronous throw — is reported via `reportDiagnostic()`, which
 * appends a `source: 'collector'` entry to the audit log (and stderr).
 * `reportFlushFailure()` does the same for a rejected `forceFlush()`.
 */

import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { reportDiagnostic } from '../../adapters/diagnostics.js';

export type CollectorSignal = 'traces' | 'metrics' | 'logs';

/** Minimal push-exporter shape shared by trace/metric/log OTLP exporters. */
interface PushExporter {
  export(items: unknown, resultCallback: (result: ExportResult) => void): void;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  return String(err);
}

function reportExportFailure(signal: CollectorSignal, endpoint: string, err: unknown): void {
  reportDiagnostic({
    severity: 'warning',
    source: 'collector',
    kind: 'otlp_export_failed',
    component: signal,
    message: `Failed to export ${signal} to the OTLP endpoint`,
    detail: errMessage(err),
    hint: `Check collector.endpoint (${endpoint || '<unset>'}) reachability, auth, and protocol.`,
  });
}

/**
 * Report a rejected `provider.forceFlush()` as a collector diagnostic.
 * Callers should pass this as the `.catch()` handler so a flush failure at
 * subprocess shutdown still lands in the audit log instead of becoming an
 * unhandled rejection.
 */
export function reportFlushFailure(signal: CollectorSignal, endpoint: string, err: unknown): void {
  reportDiagnostic({
    severity: 'warning',
    source: 'collector',
    kind: 'otlp_flush_failed',
    component: signal,
    message: `Failed to flush ${signal} to the OTLP endpoint`,
    detail: errMessage(err),
    hint: `Check collector.endpoint (${endpoint || '<unset>'}) reachability, auth, and protocol.`,
  });
}

/**
 * Wrap `exporter.export()` in place so OTLP send failures are audited.
 *
 * Mutates and returns the same instance (sibling methods such as
 * `shutdown` / `forceFlush` / metric aggregation selectors are untouched).
 * A FAILED result is reported and forwarded unchanged; a synchronous throw
 * is reported and surfaced to the caller as a FAILED result — never
 * rethrown — so the host processor's flush resolves rather than crashing
 * the telemetry subprocess.
 */
export function instrumentExporter<T extends PushExporter>(
  exporter: T,
  signal: CollectorSignal,
  endpoint: string,
): T {
  const original = exporter.export.bind(exporter);
  exporter.export = function (items: unknown, resultCallback: (result: ExportResult) => void): void {
    try {
      original(items, (result: ExportResult) => {
        if (result?.code === ExportResultCode.FAILED) {
          reportExportFailure(signal, endpoint, result.error);
        }
        resultCallback(result);
      });
    } catch (err) {
      reportExportFailure(signal, endpoint, err);
      resultCallback({ code: ExportResultCode.FAILED, error: err instanceof Error ? err : new Error(String(err)) });
    }
  };
  return exporter;
}
