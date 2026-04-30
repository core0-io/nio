---
"@core0-io/nio": minor
---

Align the OTLP **logs** and **metrics** signal attribute / label keys
with the trace signal. Cross-signal queries now work with the same key
names; observability dashboards no longer need to OR-query parallel
schemas across logs / metrics / traces.

**Metrics** (`nio.tool_use.count`, `nio.turn.count`, `nio.decision.count`,
`nio.risk.score`):

- `tool_name` → `gen_ai.tool.name`
- `decision` → `nio.guard.decision`
- `risk_level` → `nio.guard.risk_level`
- `event` → `nio.event`
- `platform` → `nio.platform`

Metric instrument names are unchanged.

**Audit log** (`emitAuditLog` OTEL LogRecord projection):

- `nio.tool_name` → `gen_ai.tool.name`
- `nio.session_id` → `gen_ai.conversation.id` + `session.id`
- `nio.decision` → `nio.guard.decision`
- `nio.risk_level` → `nio.guard.risk_level`
- `nio.risk_score` → `nio.guard.risk_score`
- `nio.risk_tags` → `nio.guard.risk_tags`
- New: `gen_ai.tool.call.id` (from `tool_use_id`)
- New: `nio.tool_summary`, `nio.task_id`, `nio.task_summary`, `nio.cwd`,
  `nio.transcript_path` (previously inside the JSON `body` only)
- New: `nio.event_type`

The flat-attribute set is now built by a shared `auditEntryAttributes`
helper that pulls guard-decision keys from `nioGuardAttributes` in
`traces-collector` — same single-source-of-truth pattern the trace
signal uses.

**Breaking for dashboards**: any saved query / alert filtering on the
old keys above must be updated to the new keys before upgrading.
The local `audit.jsonl` JSONL line shape is **unchanged** (still the
verbatim `AuditEntry`); only the OTEL flat-attribute projection moved.
