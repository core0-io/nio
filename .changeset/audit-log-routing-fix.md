---
"@core0-io/nio": patch
---

Fix: route Claude Code (and Hermes) hook event audit records — `PreToolUse`,
`PostToolUse`, `TaskCreated`, `TaskCompleted`, `Stop`, `SubagentStop`,
`SessionStart`, `SessionEnd`, `UserPromptSubmit` — to `audit.jsonl`
instead of the misnamed `metrics.jsonl`. They now flow through the same
`writeAuditLog` pipeline as guard, scan, and lifecycle entries, picking
up OTEL Logs export and rotation for free.

Audit-log path is now read consistently from `collector.logs.path`, and
the cross-process trace state file (`traces-state-store.json`) sits next
to the audit log so a single config setting controls both.

The obsolete `collector.metrics.{local,log,max_size_mb}` config keys are
removed; pre-cleanup `config.yaml` files continue to load (unknown
fields are stripped, not rejected). After updating, you can safely
delete the orphan `~/.nio/metrics.jsonl` and (if upgrading from a build
that wrote it) `~/.nio/collector-state.json`.

Internal: `traces-collector` is now a pure-function module — all state
IO moved to a new `traces-state-store` module that owns
`traces-state-store.json` persistence on behalf of the collector
pipeline.
