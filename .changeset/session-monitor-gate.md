---
"@core0-io/nio": minor
---

Add session-level telemetry capture gate. Nio now captures nothing by
default — arm a session with `/nio-monitor` to start exporting metrics,
traces and logs. Guard enforcement and the local audit log are
unaffected. Set `collector.monitor_all_sessions: true` to restore
blanket capture.
