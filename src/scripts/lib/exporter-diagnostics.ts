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

/**
 * Render an export failure into the one line a human has to read.
 *
 * `err.message` alone is not enough. Node's happy-eyeballs connect
 * failures arrive as an `AggregateError` whose own `message` is the empty
 * string and whose real content ('connect ECONNREFUSED ::1:4318', …) sits
 * in `.errors`. 115 of the 845 diagnostics in a real audit log rendered as
 * the bare word "AggregateError", which says nothing at all.
 */
export function errMessage(err: unknown): string {
  if (err instanceof Error) {
    const nested = (err as { errors?: unknown }).errors;
    if (Array.isArray(nested) && nested.length > 0) {
      const parts = nested.map(errMessage).filter(Boolean);
      const uniq = [...new Set(parts)];
      if (uniq.length > 0) {
        return err.message ? `${err.message}: ${uniq.join('; ')}` : uniq.join('; ');
      }
    }
    if (err.message) return err.message;
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code) return `${err.name}: ${code}`;
    return err.name || String(err);
  }
  return String(err);
}

/**
 * Turn the failure text into a hint that is actually true.
 *
 * The old single hint told every reader to check endpoint reachability.
 * On a live session that hint was wrong for 86 % of the diagnostics: the
 * two most common failures never touched the network at all, or reached a
 * healthy endpoint that simply could not answer as fast as nio was
 * asking. Telling someone to debug their collector while the exporter is
 * refusing to send is worse than saying nothing.
 */
function exportHint(endpoint: string, detail: string): string {
  const where = endpoint || '<unset>';
  if (/concurrent export limit/i.test(detail)) {
    // otlp-exporter-base caps in-flight exports at 30 PER EXPORTER and
    // rejects the overflow itself — no request is sent, so the endpoint's
    // health is irrelevant to this failure.
    return 'The OTLP exporter refused to send: its in-flight limit (30) was full, '
      + 'so nothing reached the network. Nio is producing exports faster than the '
      + `endpoint acknowledges them; ${where} may be healthy but slow.`;
  }
  if (/timed out|timeout/i.test(detail)) {
    return `The request to ${where} was sent but not answered within collector.timeout. `
      + 'Raise collector.timeout, or reduce export volume, before suspecting the endpoint.';
  }
  return `Check collector.endpoint (${where}) reachability, auth, and protocol.`;
}

function reportExportFailure(signal: CollectorSignal, endpoint: string, err: unknown): void {
  const detail = errMessage(err);
  reportDiagnostic({
    severity: 'warning',
    source: 'collector',
    kind: 'otlp_export_failed',
    component: signal,
    message: `Failed to export ${signal} to the OTLP endpoint`,
    detail,
    hint: exportHint(endpoint, detail),
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

// ── Export backoff ──────────────────────────────────────────────────────
//
// A failing export is retried by whoever owns the processor, on ITS
// schedule and with no idea that the last attempt failed:
// `PeriodicExportingMetricReader` fires every 1000 ms forever, and every
// recorded event force-flushes on top of that. So a fault that lasts six
// minutes costs ~700 pointless round trips (or, in the concurrency-limit
// case, ~700 instant rejections), each one an audit line and a stderr
// line, and each one still occupying the caller's await.
//
// The breaker below puts a floor under that retry interval WITHOUT
// hiding anything:
//
//   - the first `OPEN_AFTER_FAILURES` failures behave exactly as before —
//     attempted, reported, forwarded;
//   - after that, exports short-circuit for a doubling delay (1 s, 2 s,
//     4 s … capped at `MAX_BACKOFF_MS`), returning FAILED immediately;
//   - short-circuited exports are counted, not reported: they are the
//     same fault, and the fault was already on screen;
//   - one `otlp_export_backoff` diagnostic announces each pause, so the
//     user is told that nio has stopped trying and when it will retry;
//   - the first attempt after the delay goes through as a live probe. It
//     fails → longer pause. It succeeds → `otlp_export_recovered`, the
//     count of what was dropped, and full-rate exporting resumes.
//
// This is per exporter instance, i.e. per signal, so a broken metrics
// pipeline never pauses traces.
//
// It cannot affect a guard decision: the wrapper only ever changes what
// the TELEMETRY exporter returns, and short-circuiting makes the guard
// path strictly faster (an immediate FAILED instead of a
// `collector.timeout`-long stall).

/** Consecutive failures tolerated before exports are paused. */
export const OPEN_AFTER_FAILURES = 3;
/** First pause length; doubles per subsequent failure. */
export const BASE_BACKOFF_MS = 1_000;
/** Ceiling on the pause, so a long outage still retries twice a minute. */
export const MAX_BACKOFF_MS = 30_000;

/** Injectable clock so backoff tests do not have to sleep. */
let backoffClock: () => number = () => Date.now();

/** Test seam: pin the backoff clock. `null` restores `Date.now`. */
export function _setExporterBackoffClockForTests(now: (() => number) | null): void {
  backoffClock = now ?? (() => Date.now());
}

function backoffFor(consecutiveFailures: number): number {
  const steps = consecutiveFailures - OPEN_AFTER_FAILURES;
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, steps), MAX_BACKOFF_MS);
}

/**
 * Wrap `exporter.export()` in place so OTLP send failures are audited and
 * a persistent fault stops being retried once per second.
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

  let consecutiveFailures = 0;
  /** Epoch ms until which exports short-circuit; 0 = not paused. */
  let pausedUntil = 0;
  /** Exports dropped by the pause since it began. */
  let droppedWhilePaused = 0;

  /** Never let diagnostics reporting break the exporter callback. */
  const safely = (fn: () => void): void => {
    try { fn(); } catch { /* telemetry must not take the host down */ }
  };

  const onFailure = (err: unknown, reported: boolean): void => {
    consecutiveFailures++;
    if (!reported) safely(() => reportExportFailure(signal, endpoint, err));
    if (consecutiveFailures < OPEN_AFTER_FAILURES) return;
    const delay = backoffFor(consecutiveFailures);
    pausedUntil = backoffClock() + delay;
    const secs = Math.round(delay / 1000);
    // While the delay is still doubling there are at most ~6 of these and
    // each one is new information, so it carries the failure count. Once
    // the delay is capped the pause repeats for as long as the outage
    // lasts, and an ever-incrementing count in the text would defeat the
    // stderr limiter — the same line would look "distinct" every 30 s and
    // an eight-hour outage would print a thousand of them. At the cap the
    // wording is therefore STABLE, so repeats collapse into one
    // "suppressed N" summary. The exact count is still one grep away in
    // the audit log, which is never throttled.
    const capped = delay >= MAX_BACKOFF_MS;
    safely(() => reportDiagnostic({
      severity: 'warning',
      source: 'collector',
      kind: 'otlp_export_backoff',
      component: signal,
      message: capped
        ? `Pausing ${signal} export for ${secs}s after repeated failures`
        : `Pausing ${signal} export for ${secs}s after ${consecutiveFailures} consecutive failures`,
      detail: errMessage(err),
      hint: 'Nio has stopped retrying this signal until the pause elapses. '
        + 'Telemetry produced meanwhile is dropped; the guard is unaffected.',
    }));
  };

  const onSuccess = (): void => {
    const dropped = droppedWhilePaused;
    const wasPaused = pausedUntil !== 0;
    consecutiveFailures = 0;
    pausedUntil = 0;
    droppedWhilePaused = 0;
    if (!wasPaused) return;
    safely(() => reportDiagnostic({
      severity: 'info',
      source: 'collector',
      kind: 'otlp_export_recovered',
      component: signal,
      message: `${signal} export recovered`,
      detail: dropped > 0 ? `${dropped} export(s) were dropped while paused` : undefined,
    }));
  };

  exporter.export = function (items: unknown, resultCallback: (result: ExportResult) => void): void {
    if (pausedUntil > backoffClock()) {
      droppedWhilePaused++;
      resultCallback({
        code: ExportResultCode.FAILED,
        error: new Error(
          `nio: ${signal} export paused after ${consecutiveFailures} consecutive failures`,
        ),
      });
      return;
    }

    try {
      original(items, (result: ExportResult) => {
        if (result?.code === ExportResultCode.FAILED) {
          safely(() => reportExportFailure(signal, endpoint, result.error));
          onFailure(result.error, true);
        } else {
          onSuccess();
        }
        resultCallback(result);
      });
    } catch (err) {
      onFailure(err, false);
      resultCallback({ code: ExportResultCode.FAILED, error: err instanceof Error ? err : new Error(String(err)) });
    }
  };
  return exporter;
}
