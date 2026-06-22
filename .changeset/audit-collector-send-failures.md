---
"@core0-io/nio": patch
---

Audit collector send failures. OTLP export failures (connection refused, auth rejected, bad protocol/URL, timeout) were silently swallowed by the OTEL SDK — the documented `collector / otlp_export_failed` diagnostic was never actually emitted. The trace/metric/log exporters are now wrapped so a FAILED export result (or a synchronous throw) is reported via `reportDiagnostic()` into the audit log, tagged with the failing signal as `component`. A rejected `forceFlush()` at hook-subprocess shutdown is likewise captured as the new `collector / otlp_flush_failed` diagnostic instead of becoming an unhandled rejection.
