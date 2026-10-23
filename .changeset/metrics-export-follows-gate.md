---
"@core0-io/nio": patch
---

**`/nio monitor off` now actually stops the metrics export on the
in-process hosts.** If you run Nio under Pi, opencode or OpenClaw and
have ever wondered why your collector keeps receiving data after you
turned monitoring off — this is why, and it is fixed.

The monitor gate stopped the RECORDING leg: once a session is disarmed
nothing calls `counter.add()` for it again. Nothing stopped the EXPORT
leg. Metric temporality is cumulative, so the reader's 1-second timer
re-sent the running totals on every tick whether or not anything new had
been recorded. Measured on a live host after `off`: `nio.turn.count`
sitting at a constant 5 while a fresh sample landed every second across
163 series — roughly 163 points per second of pure repetition, for as
long as the process stayed up. Killing the host was the only way to stop
it. This was previously documented as a known limitation in the
`nio-monitor` skill rather than treated as a defect.

The export timer now follows the gate: it runs while the process has at
least one monitored session and stops on the next event after the last
one is disarmed, or when that session ends.

Two properties were load-bearing in the fix.

**One session's `off` must not blind another session's `on`.** The gate
is per session; the MeterProvider and its timer are per process, and
these hosts serve many sessions from one process. So the timer follows
"does this process still have ANY monitored session", never a single
`off` call. Disarming one of two armed sessions leaves it running.

**Pausing is not shutting down.** `PeriodicExportingMetricReader
.onShutdown()` clears the interval *and* calls `exporter.shutdown()`,
which is terminal — re-arming would need a whole new provider and the
counters would restart at zero, a cumulative reset the backend reads as a
new series. The new `PausableExportingMetricReader` overrides the
documented `onInitialized()` hook to own its timer instead of reaching
into the SDK's private handle, so stopping it leaves the exporter open
and the accumulated totals intact. Arming again continues the same
series: a backend sees one curve with a gap in it, not a restart. The
pause ships a final flush on the way down, so points recorded just
before it are not stranded until a resume that may never come.

Claude Code, Codex and Hermes were never affected — each hook event is
its own process and exits long before a second tick.
