# Collector Signals — Schema Reference

What Nio captures while an agent runs, organised by OTEL signal. This is the schema-of-record; if reality drifts from this doc, the source is wrong.

```
                ┌─ collector-hook.ts (per hook)
Claude Code  ──►│
                └─ guard-hook.ts    (per PreToolUse)

                ┌─ hook-cli.ts      (per shell hook)
Hermes       ──►│
                └─ pre_tool_call    routes both guard + collector through hook-cli

                ┌─ openclaw-plugin.ts.before_tool_call / after_tool_call
OpenClaw     ──►│
                └─ openclaw-plugin.ts.{subagent_*, before_agent_reply, llm_output, agent_end, session_*}

                              │
                              ▼
              ┌──────────────────────────────────┐
              │  dispatchCollectorEvent          │ ← collector-core.ts (CC, Hermes)
              │  (OpenClaw bypasses, calls       │
              │   traces-collector directly)     │
              └────────┬───────────┬──────────┬──┘
                       │           │          │
                       ▼           ▼          ▼
                 ┌─────────┐ ┌─────────┐ ┌─────────┐
                 │ Metrics │ │ Traces  │ │  Logs   │
                 │ (OTLP)  │ │ (OTLP)  │ │ (OTLP + │
                 │         │ │         │ │  local) │
                 └─────────┘ └─────────┘ └─────────┘
```

Three OTEL signals out — **metrics**, **traces**, **logs**. The audit log (logs signal) is the only one with a local JSONL backup; metrics and traces are OTLP-only.

---

## Metrics

Schema declared in [`METRICS_SCHEMA`](../src/scripts/lib/metrics-collector.ts) and emitted via the OTLP exporter to `<endpoint>/v1/metrics`.

| Instrument | Type | Unit | Labels | When recorded |
|------------|------|------|--------|---------------|
| `nio.tool_use.count` | Counter | `{invocations}` | `gen_ai.tool.name`, `nio.event`, `nio.platform` | Each `PreToolUse` and `PostToolUse` (and `TaskCreated`/`TaskCompleted` if fired) |
| `nio.turn.count` | Counter | `{turns}` | `nio.platform` | Each `Stop` / `SubagentStop` / `SessionEnd` (turn boundary) |
| `nio.decision.count` | Counter | `{decisions}` | `nio.guard.decision`, `nio.guard.risk_level`, `gen_ai.tool.name`, `nio.platform` | Each guard decision (allow / deny / ask) |
| `nio.risk.score` | Histogram | `{score}` | `gen_ai.tool.name`, `nio.platform` | Each guard evaluation; 0–1 distribution for avg/p50/p99 |

Label keys are aligned with the matching trace span attributes (`gen_ai.tool.name` matches the tool span; `nio.guard.*` matches the OpenClaw tool span guard attrs via `nioGuardAttributes`). Cross-signal queries (metrics ⇌ traces ⇌ logs) use the same key names.

**Label values:**

- `nio.platform` ∈ `claude-code` | `hermes` | `openclaw`
- `nio.event` ∈ `PreToolUse` | `PostToolUse` | `TaskCreated` | `TaskCompleted`
- `nio.guard.decision` ∈ `allow` | `deny` | `ask`
- `nio.guard.risk_level` ∈ `low` | `medium` | `high` | `critical`
- `gen_ai.tool.name` — host-platform tool name. Claude Code reports the canonical hook-payload tool name (`Bash`, `Write`, `WebFetch`, etc.). One quirk: the user-facing **Task** tool (subagent dispatch) is reported as `tool_name="Agent"` in CC hook payloads, so PreToolUse / PostToolUse counters use `Agent`. The literal value `Task` only appears as a counter label when `TaskCreated` / `TaskCompleted` fire (Teammates / cloud-agent flows; never fired by the regular Task tool subagent on current CC builds — see [`e2e-test/hook-subagent-e2e-task.md`](../e2e-test/hook-subagent-e2e-task.md)). OpenClaw and Hermes use their own native tool names.

Metrics have **no local file** — there is no `metrics.jsonl`. If `collector.endpoint` is empty, metrics drop on the floor (the meter provider returns `null`).

---

## Traces

One trace per conversation turn. Span hierarchy follows OTel [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) where applicable; Nio-specific extensions use `nio.*` prefix. Schema lives in [`traces-collector.ts`](../src/scripts/lib/traces-collector.ts) — every literal attribute key string is owned by one helper there; consumers (`collector-core.ts`, `openclaw-plugin.ts`) only call helpers.

```
Trace: invoke_agent UserPromptSubmit  (root, opens at 1st PreToolUse, ends at Stop / SubagentStop)
  ├─ Span: execute_tool <name>   (PreToolUse → PostToolUse)
  ├─ Span: execute_tool <name>   (...)
  └─ Span: task:execute          (TaskCreated → TaskCompleted, or OpenClaw subagent_spawning → subagent_ended)
```

### Span: `invoke_agent UserPromptSubmit` (turn root)

Built by [`endTurn`](../src/scripts/lib/traces-collector.ts) at turn close. Span ID is deterministic (`traceId.slice(0,16)`) so child spans can parent to it before it exists.

| Attribute | Source | Helper |
|-----------|--------|--------|
| `gen_ai.operation.name` | constant `invoke_agent` | `genAiInvokeAgentAttributes` |
| `gen_ai.provider.name` | constant `nio` | `genAiInvokeAgentAttributes` |
| `gen_ai.conversation.id` | session ID | `genAiInvokeAgentAttributes` |
| `gen_ai.agent.name` | platform name (acts as agent identifier) | `genAiInvokeAgentAttributes` |
| `session.id` | session ID (mirror of conversation.id for OTel base-spec consumers) | `genAiInvokeAgentAttributes` |
| `gen_ai.usage.input_tokens` | accumulated across turn | `genAiUsageAttributes` / `accumulateGenAiUsage` |
| `gen_ai.usage.output_tokens` | accumulated across turn | same |
| `gen_ai.usage.cache_creation.input_tokens` | accumulated across turn | same |
| `gen_ai.usage.cache_read.input_tokens` | accumulated across turn | same |
| `nio.platform` | `claude-code` / `hermes` / `openclaw` | inline in endTurn |
| `nio.turn_number` | per-session counter, starts at 1 | inline in endTurn |
| `nio.cwd` | working dir at turn start | inline in endTurn (when set) |
| `nio.turn.user_prompt` | first user message of the turn (redacted, ≤2 KB) | `recordUserPrompt` |
| `nio.turn.assistant_reply` | OpenClaw only — captured at `llm_output` (redacted, ≤2 KB) | `recordAssistantReply` |
| `nio.turn.cache_hit_rate` | `cache_read / (input + cache_creation + cache_read)`, 0–1 | `recordCacheHitRate` |

**Token usage source** differs by platform:
- **Claude Code**: `Stop` event reads `transcript_path` JSONL, sums `message.usage` from all assistant entries since turn start.
- **Hermes**: same code path as CC — if `transcriptPath` is included in the post_llm_call payload, parsed identically; otherwise empty.
- **OpenClaw**: `llm_output` event payload carries `usage` directly; accumulated incrementally into `state.turn_attributes`.

### Span: `execute_tool <name>` (tool span)

Built by [`recordPostToolUse`](../src/scripts/lib/traces-collector.ts) at PostToolUse time. Span name is literally `execute_tool ${toolName || 'unknown'}`.

| Attribute | Source | Helper |
|-----------|--------|--------|
| `gen_ai.operation.name` | constant `execute_tool` | `genAiToolAttributes` |
| `gen_ai.tool.name` | host tool name (`Bash`, `WebFetch`, etc.) | `genAiToolAttributes` |
| `gen_ai.tool.type` | optional, when known | `genAiToolAttributes` |
| `gen_ai.tool.call.id` | host tool-call id (`tool_use_id` for CC, `toolCallId` for OpenClaw) | `genAiToolCallInputAttributes` / `genAiToolAttributes` |
| `gen_ai.tool.call.arguments` | tool input (redacted, ≤2 KB) | `genAiToolCallInputAttributes` |
| `gen_ai.tool.call.result` | tool output (redacted, ≤2 KB) | `genAiToolCallOutputAttributes` |
| `nio.tool.error` | error message (when tool failed) | `genAiToolCallOutputAttributes` |
| `nio.tool.duration_ms` | OpenClaw only — wall-clock duration | `genAiToolCallOutputAttributes` |
| `nio.tool.run_id` | OpenClaw only — runId from event | `nioToolRunIdAttribute` |
| `nio.tool_summary` | one-line summary derived from tool input | inline in recordPostToolUse |
| `nio.platform` | `claude-code` / `hermes` / `openclaw` | inline in recordPostToolUse |
| `nio.turn_number` | parent turn's number | inline in recordPostToolUse |
| `nio.cwd` | working dir at hook fire | inline in recordPostToolUse (when set) |
| `nio.guard.decision` | OpenClaw only — `allow` / `deny` / `confirm_allowed` / `confirm_denied` | `nioGuardAttributes` |
| `nio.guard.risk_level` | OpenClaw only — `low` / `medium` / `high` / `critical` / `unknown` | `nioGuardAttributes` |
| `nio.guard.risk_score` | OpenClaw only — 0–1 | `nioGuardAttributes` |
| `nio.guard.risk_tags` | OpenClaw only — comma-joined rule IDs | `nioGuardAttributes` |

**Span status:** `ERROR` (with `recordException(error)`) when the tool failed or the guard denied/confirm-denied; `OK` otherwise.

**`nio.guard.*` on CC?** Not yet — CC's guard decisions go to the audit log only. The `nioGuardAttributes` helper is exported and ready; symmetric CC adoption is a follow-up.

### Span: `task:execute` (task span)

Built by [`recordPostTaskToolUse`](../src/scripts/lib/traces-collector.ts) at TaskCompleted (CC, currently never fired in normal sessions) or `subagent_ended` (OpenClaw). Span name is literal `task:execute` — not yet migrated to GenAI conventions.

| Attribute | Source |
|-----------|--------|
| `nio.task_id` | task id from event |
| `nio.task_summary` | derived from task input (CC: `task_input.prompt`; OpenClaw: empty) |
| `nio.platform` | `claude-code` / `openclaw` |
| `nio.session_id` | session id |
| `nio.turn_number` | parent turn's number |
| `nio.cwd` | working dir at task start |

### Trace state and span lifecycle

All three platforms route span construction through [`traces-collector.ts`](../src/scripts/lib/traces-collector.ts) pure functions (`ensureTurn`, `recordPreToolUse`, `recordPostToolUse`, `recordPreTaskToolUse`, `recordPostTaskToolUse`, `setTurnAttributes`, `endTurn`). The only platform difference is **where `CollectorState` lives**:

- **Claude Code / Hermes** (cross-process spawn-per-hook): bridged via [`traces-state-store.json`](../src/scripts/lib/traces-state-store.ts) on disk. `PreToolUse` writes pending span data; `PostToolUse` reads it and emits the span retroactively with the original start time. `Stop` (or `SubagentStop` / `SessionEnd`) emits the turn root span.
- **OpenClaw** (in-process daemon): per-session `Map<sessionId, CollectorState>` in memory inside [`openclaw-plugin.ts`](../src/adapters/openclaw-plugin.ts). No disk bridging; same lifecycle methods.

State file path: `dirname(collector.logs.path) / traces-state-store.json` (defaults to `${NIO_HOME ?? ~/.nio}/traces-state-store.json`).

---

## Logs (audit log)

Audit entries are **dual-written**: OTEL Logs export to `<endpoint>/v1/logs` (when `collector.logs.enabled`) AND a local JSONL file at `collector.logs.path` (when `collector.logs.local`). Schema is the discriminated union [`AuditEntry`](../src/adapters/audit-types.ts) + the OTEL log attribute mapping in [`emitAuditLog`](../src/scripts/lib/logs-collector.ts).

The JSONL line is the entry verbatim; the OTEL LogRecord uses `body = JSON.stringify(entry)` plus a flat attribute list for indexing.

### Entry types (discriminated by `event`)

#### `event: "guard"` — guard decision (per PreToolUse / PostToolUse)

| Field | Type | Notes |
|-------|------|-------|
| `event` | `"guard"` | discriminator |
| `timestamp` | string | ISO-8601 |
| `platform` | string | `claude-code` / `hermes` / `openclaw` |
| `session_id` | string? | host session id |
| `cwd` | string? | working dir |
| `tool_name` | string | host tool name |
| `action_type` | string? | `exec_command` / `write_file` / `network_request` / `read_file` |
| `tool_input_summary` | string | redacted ≤200-char summary of tool input |
| `decision` | string | `allow` / `deny` / `ask` |
| `risk_level` | string | `low` / `medium` / `high` / `critical` |
| `max_finding_severity` | string | highest finding severity |
| `risk_score` | number | 0–1 final score |
| `risk_tags` | string[] | rule IDs hit (deduped) |
| `phase_stopped` | number \| null | which Phase 0–6 produced the decision |
| `scores` | `Record<string, number>` | per-phase score (`runtime`, `static`, `behavioural`, `llm`, `external`, `final`) |
| `phases` | `AuditPhaseMap?` | per-phase `{score, finding_count, duration_ms}` |
| `top_findings` | `AuditFindingSummary[]` | up to 5: `{rule_id, severity, category, title, confidence}` |
| `explanation` | string? | human-readable reason |
| `initiating_skill` | string? | which skill scope the action originated from |
| `event_type` | `"pre" \| "post"?` | which hook side fired |

#### `event: "session_scan"` — skill scan (on-demand or session-start)

| Field | Type | Notes |
|-------|------|-------|
| `event` | `"session_scan"` | discriminator |
| `timestamp` | string | ISO-8601 |
| `platform` | string | host |
| `session_id` | string? | host session id |
| `skill_name` | string | scanned skill / dir |
| `risk_level` | string | aggregated severity |
| `risk_tags` | string[] | rule IDs hit |
| `finding_count` | number? | total findings |

#### `event: "lifecycle"` — subagent / agent / session lifecycle

| Field | Type | Notes |
|-------|------|-------|
| `event` | `"lifecycle"` | discriminator |
| `timestamp` | string | ISO-8601 |
| `platform` | string | host |
| `session_id` | string? | host session id |
| `lifecycle_type` | string | `subagent_spawning` / `subagent_ended` / `agent_end` / `session_start` / `session_end` |
| `details` | `Record<string, unknown>?` | platform-specific (e.g. OpenClaw: `{subagent_id, run_id}`) |

#### `event: "config_error"` — config load failure

| Field | Type | Notes |
|-------|------|-------|
| `event` | `"config_error"` | discriminator |
| `timestamp` | string | ISO-8601 |
| `config_path` | string | path that failed to load |
| `error_message` | string | parser / IO error |

#### `event: <hook event>` — collector hook record

Discriminator is the canonical hook event name itself: `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `TaskCreated`, `TaskCompleted`, `Stop`, `SubagentStop`, `SessionStart`, `SessionEnd`. One entry written per dispatched hook event.

| Field | Type | Notes |
|-------|------|-------|
| `event` | `HookEventName` | one of the 9 above |
| `timestamp` | string | ISO-8601 |
| `platform` | string | host |
| `session_id` | string? | host session id |
| `cwd` | string \| null | working dir |
| `transcript_path` | string? | CC-only — path to session transcript JSONL |
| `tool_name` | string? | for PreToolUse / PostToolUse |
| `tool_use_id` | string? | for PreToolUse / PostToolUse |
| `tool_summary` | string? | for PreToolUse / PostToolUse |
| `task_id` | string? | for TaskCreated / TaskCompleted |
| `task_summary` | string? | for TaskCreated |

### OTEL LogRecord projection

[`emitAuditLog`](../src/scripts/lib/logs-collector.ts) maps the entry above onto an OTEL LogRecord. The flat attribute set is built by [`auditEntryAttributes`](../src/scripts/lib/logs-collector.ts) and aligns with the trace span schema where concepts overlap — same key names work across logs and traces in dashboards.

- `body` = JSON-stringified entry (full content)
- `severityNumber` / `severityText` = derived from `risk_level` (`low`→INFO, `medium`→WARN, `high`→ERROR, `critical`→FATAL); INFO when no `risk_level`
- Attributes (extracted for indexing). Cross-signal alignment column shows where the same key appears in the traces signal:

| Attribute | Source field | Cross-signal alignment |
| --------- | ------------ | ---------------------- |
| `gen_ai.tool.name` | `tool_name` | matches tool-span attribute |
| `gen_ai.tool.call.id` | `tool_use_id` | matches tool-span attribute |
| `gen_ai.conversation.id` | `session_id` | matches turn-span attribute |
| `session.id` | `session_id` | matches turn-span attribute |
| `nio.guard.decision` | `decision` | matches OpenClaw tool-span guard attr (`nioGuardAttributes`) |
| `nio.guard.risk_level` | `risk_level` | same |
| `nio.guard.risk_score` | `risk_score` | same |
| `nio.guard.risk_tags` | `risk_tags` (comma-joined) | same |
| `nio.event` | `event` | logs-only — discriminator for hook event vs guard / lifecycle / scan |
| `nio.platform` | `platform` | matches turn-span and tool-span attribute |
| `nio.event_type` | `event_type` | logs-only — `pre` / `post` for guard entries |
| `nio.action_type` | `action_type` | logs-only — `exec_command` / `write_file` / `network_request` / `read_file` |
| `nio.max_finding_severity` | `max_finding_severity` | logs-only |
| `nio.phase_stopped` | `phase_stopped` | logs-only |
| `nio.explanation` | `explanation` | logs-only |
| `nio.tool_summary` | `tool_summary` | matches tool-span attribute |
| `nio.task_id` | `task_id` | matches task-span attribute |
| `nio.task_summary` | `task_summary` | matches task-span attribute |
| `nio.cwd` | `cwd` | matches tool-span / turn-span attribute |
| `nio.transcript_path` | `transcript_path` | logs-only |
| `nio.phases.{name}.score` | `phases[name].score` | logs-only — per-phase Phase 0–6 telemetry |
| `nio.phases.{name}.finding_count` | `phases[name].finding_count` | same |
| `nio.phases.{name}.duration_ms` | `phases[name].duration_ms` | same |

Local JSONL path: `collector.logs.path` (default `~/.nio/audit.jsonl`). Rotation kicks in at `collector.logs.max_size_mb` (default 100 MB) — the live file is renamed to `<path>.1`.

---

## Configuration knobs (collector section)

Full config reference: [configuration.html](configuration.html). Quick summary of what gates each signal:

```yaml
collector:
  endpoint: ""                      # OTLP base URL; empty = no OTLP export at all
  api_key: ""                       # Bearer token
  timeout: 5000                     # milliseconds
  protocol: http                    # http | grpc
  metrics:
    enabled: true                   # OTLP metrics export on/off
  traces:
    enabled: true                   # OTLP traces export on/off
  logs:
    enabled: true                   # OTLP logs export on/off
    local: true                     # local JSONL backup on/off
    path: "~/.nio/audit.jsonl"      # audit log + (sibling) traces-state-store.json
    max_size_mb: 100                # rotation threshold for the local file
```

Per-signal gating: when `collector.endpoint` is empty, the corresponding provider factory returns `null` and the platform code skips emit. The audit-log local JSONL still works (controlled by `collector.logs.local`) even without an endpoint — handy for offline / air-gapped use.

---

## Source-of-truth files

| Schema | File | What it owns |
|--------|------|-------------|
| Metrics catalog | [`src/scripts/lib/metrics-collector.ts`](../src/scripts/lib/metrics-collector.ts) (`METRICS_SCHEMA`) | Instrument names, types, labels, descriptions |
| Trace span attributes (all `gen_ai.*` and `nio.*` keys) | [`src/scripts/lib/traces-collector.ts`](../src/scripts/lib/traces-collector.ts) | All span attribute keys via builder helpers (`genAi*Attributes`, `nio*Attributes`, `record*` operations) |
| Trace state shape | [`src/scripts/lib/traces-state-store.ts`](../src/scripts/lib/traces-state-store.ts) | `CollectorState`, `PendingToolSpan`, `PendingTaskSpan` |
| Audit log entry types | [`src/adapters/audit-types.ts`](../src/adapters/audit-types.ts) | All entry shapes (guard / scan / lifecycle / config_error / hook) |
| OTEL log attribute projection | [`src/scripts/lib/logs-collector.ts`](../src/scripts/lib/logs-collector.ts) (`auditEntryAttributes`) | Flat attribute keys for log indexing — shared GenAI / `nio.*` keys with the trace signal |
| Collector config schema | [`src/adapters/config-schema.ts`](../src/adapters/config-schema.ts) (`CollectorConfigSchema`, `CollectorLogsConfigSchema`) | YAML field validation + defaults |

When schema drifts, update the source file and re-run `pnpm run build` — the helper functions in `traces-collector.ts` are the single point of change for trace attribute keys, so most edits don't ripple beyond one file.
