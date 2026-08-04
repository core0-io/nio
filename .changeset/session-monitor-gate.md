---
"@core0-io/nio": minor
---

Add session-level telemetry capture gate. Nio now captures nothing by
default — arm a session with `/nio-monitor on` (Claude Code, Codex) or
`/nio monitor on` (OpenClaw, Hermes) to start exporting metrics, traces
and logs. Guard enforcement and the local audit log are unaffected. Set
`collector.monitor_all_sessions: true` to restore blanket capture.

Known limitation on OpenClaw: it runs inside a long-lived daemon with
cumulative OTEL counters, so once any session there has been armed, the
metrics exporter keeps re-sending its accumulated totals until the daemon
restarts. Disarming stops new data being collected but cannot stop that
periodic export. The other platforms run one process per hook event and
are unaffected.
