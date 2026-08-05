---
"@core0-io/nio": minor
---

Add Pi and opencode platform support

Feature parity with the existing platforms: guard Phase 0-6, OTEL
traces/metrics/logs, audit log, the `/nio` skill surface with the six
focused skills, an idempotent installer, and a per-platform release zip —
with two documented host-imposed gaps: Pi emits no subagent task spans
(Pi has no subagent concept), and an opencode tool that throws skips
`tool.execute.after`, so its span is reclaimed at `session.idle` rather
than closed precisely.

Both platforms load Nio as an in-process plugin, so the platform-agnostic
part of the OpenClaw plugin was extracted into a shared
`InProcessPluginRuntime` that all three now share.

Pi is the first platform where a `confirm` verdict opens a real
interactive dialog rather than folding to `guard.confirm_action`.
