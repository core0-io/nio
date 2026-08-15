---
"@core0-io/nio": patch
---

Stop nio filling the OTLP exporter's in-flight queue with its own metrics
flushes.

`otlp-exporter-base` caps in-flight exports at 30 and rejects the overflow
outright — `Concurrent export limit reached` — without retrying or
queueing, so nothing reaches the network on that path. On the in-process
hosts (OpenClaw, Pi, opencode) one `MeterProvider` serves the whole host
process, and `InProcessPluginRuntime` issues two fire-and-forget metric
flushes per tool event plus one awaited on the post side. Overlapping tool
events stacked those unawaited flushes on a single exporter.

Measured over 20 overlapping tool events against a local sink that
answered **200 to every request**: peak 30 in-flight exports, 4
`Concurrent export limit reached` diagnostics, and 27 further exports
dropped by the backoff those failures opened. Nio was tripping its own
circuit breaker against a healthy endpoint, and the resulting diagnostics
were 61% of the failures seen in a live session.

Concurrent `forceFlush()` calls are now collapsed: the first flushes
immediately, and callers arriving while one is in flight share a single
follow-up flush that starts after it settles. Same 20 events, same sink:
2 exports, 0 diagnostics.

Nothing is lost by collapsing them. Metric temporality is cumulative, so
every export carries the running total and a later one supersedes an
earlier one completely — an export that never happened is never a gap.
The trailing flush is what keeps it correct rather than merely cheaper:
every point is covered by a flush that *started* after it was recorded,
which a "join the export already in flight" version would not give you.

The fork-per-event platforms (Claude Code, Codex, Hermes) are unaffected
in either direction — each hook event is its own process with its own
exporter and awaits its flushes in sequence. Measured through the real
hook binaries, before and after: 121 `/v1/metrics` requests for 20 tool
calls, peak in-flight 1. The periodic reader still ticks every second and
the hooks still run their budgeted closing flush before `process.exit()`,
so nothing about the hard-kill case changed.
