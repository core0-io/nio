# Collector Signals — Schema Reference

What Nio captures while an agent runs, organised by OTEL signal. This is the schema-of-record; if reality drifts from this doc, the source is wrong.

Three OTEL signals out — **metrics**, **traces**, **logs**. The audit log (logs signal) is the only one with a local backup; metrics and traces are OTLP-only.

## Architecture

The three host platforms each have their own runtime model — Claude Code and Hermes spawn a node process per hook event, OpenClaw runs as a long-lived daemon — but they all converge on the same canonical hook event vocabulary, then on the same three collector modules that own the attribute schema. Schema consistency falls out of the architecture: every attribute key string is owned by exactly one module, no matter which platform produced the event.

```text
   ┌─────────────┐     ┌────────────────┐     ┌───────────────┐
   │ Claude Code │     │     Hermes     │     │   OpenClaw    │
   │             │     │                │     │               │
   │ per-hook    │     │ per-hook spawn │     │ single daemon │
   │ spawn       │     │ (node hook-cli)│     │ process       │
   └──────┬──────┘     └────────┬───────┘     └───────┬───────┘
          │                     │                     │
          ▼                     ▼                     ▼
   ┌──────────────────────────────────────┐   ┌──────────────┐
   │   on-disk state cache                │   │ in-memory    │
   │   bridges span lifecycle across      │   │ Map<sessionId│
   │   short-lived hook processes         │   │  ,State>     │
   └──────────────────┬───────────────────┘   └──────┬───────┘
                      │                              │
                      └──────────────┬───────────────┘
                                     ▼
              ┌──────────────────────────────────────┐
              │   Canonical hook event vocabulary    │
              │   UserPromptSubmit · PreToolUse ·    │
              │   PostToolUse · TaskCreated ·        │
              │   TaskCompleted · Stop · Subagent    │
              │   Stop · SessionStart · SessionEnd   │
              └─────────────────┬────────────────────┘
                                ▼
              ┌──────────────────────────────────────┐
              │   Three collector modules unify      │
              │   the attribute schema:              │
              │                                      │
              │     trace-collector                  │
              │     metrics-collector                │
              │     logs-collector                   │
              │                                      │
              │   shared keys: gen_ai.* · nio.*      │
              │   shared values: span names,         │
              │   metric instruments                 │
              └────────┬─────────┬───────────┬───────┘
                       │         │           │
                       ▼         ▼           ▼
                    Metrics   Traces       Logs
                    (OTLP)    (OTLP)    (OTLP + local audit log)
```

CC and Hermes have to bridge span lifecycle across short-lived hook processes — a `PreToolUse` in process A and the matching `PostToolUse` in process B share state via an on-disk cache. OpenClaw's daemon model holds the same state in memory. Both end up calling the same trace-collector helpers; the only difference is where the state lives between events.

## Naming conventions

- `gen_ai.*` — keys that follow the OTel [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/). Used wherever there's a spec equivalent: tool name, conversation id, token usage, tool I/O.
- `nio.*` — vendor extensions for concepts the GenAI spec doesn't cover: guard decisions, per-phase scoring, platform tag, redacted prompt / reply previews, per-task subagent metadata.
- `session.id` — mirrored alongside `gen_ai.conversation.id` for OTel base-spec consumers that key off session id rather than conversation id. Same value.

Cross-signal: the same key name carries the same meaning across metrics, traces, and logs. `gen_ai.tool.name` on a metric label is the same string as the matching trace span attribute, which is the same string as the matching audit-log attribute. Joining signals in dashboards Just Works.

---

## Metrics

Four instruments emitted via OTLP to `<endpoint>/v1/metrics`.

### Instruments

| Instrument | Type | Unit | When recorded |
| --- | --- | --- | --- |
| `nio.tool_use.count` | Counter | `{invocations}` | Each `PreToolUse` and `PostToolUse` (and `TaskCreated` / `TaskCompleted` if fired) |
| `nio.turn.count` | Counter | `{turns}` | Each `Stop` / `SubagentStop` / `SessionEnd` (turn boundary) |
| `nio.decision.count` | Counter | `{decisions}` | Each guard decision (allow / deny / ask) |
| `nio.risk.score` | Histogram | `{score}` | Each guard evaluation; 0–1 distribution for avg / p50 / p99 |

### Labels

| Attribute | Description | Captured at | Platforms |
| --- | --- | --- | --- |
| `gen_ai.tool.name` | Host tool name (`Bash`, `WebFetch`, …); same key as the tool-span attribute | PreToolUse · PostToolUse · guard decision | all |
| `nio.event` | Hook event firing this counter — `PreToolUse` / `PostToolUse` / `TaskCreated` / `TaskCompleted` | PreToolUse · PostToolUse · TaskCreated · TaskCompleted | all |
| `nio.platform` | Source platform — `claude-code` / `hermes` / `openclaw` | every metric | all |
| `nio.guard.decision` | Guard verdict — `allow` / `deny` / `ask` | guard decision | all |
| `nio.guard.risk_level` | Guard risk level — `low` / `medium` / `high` / `critical` | guard decision | all |

### Label sets per instrument

| Instrument | Labels |
| --- | --- |
| `nio.tool_use.count` | `gen_ai.tool.name` · `nio.event` · `nio.platform` |
| `nio.turn.count` | `nio.platform` |
| `nio.decision.count` | `nio.guard.decision` · `nio.guard.risk_level` · `gen_ai.tool.name` · `nio.platform` |
| `nio.risk.score` | `gen_ai.tool.name` · `nio.platform` |

> **Claude Code · Task → Agent**
>
> The user-facing **Task** tool (subagent dispatch) is reported as `tool_name="Agent"` in CC hook payloads, so PreToolUse / PostToolUse counters use `Agent` as the `gen_ai.tool.name` label. The literal value `Task` only appears as a counter label when `TaskCreated` / `TaskCompleted` fire (Teammates / cloud-agent flows; never fired by the regular Task tool subagent on current CC builds — see [`e2e-test/hook-subagent-e2e-task.md`](../e2e-test/hook-subagent-e2e-task.md)). OpenClaw and Hermes use their own native tool names.

Metrics have **no local file** — there is no `metrics.jsonl`. If `collector.endpoint` is empty, metrics drop on the floor (the meter provider returns `null`).

---

## Traces

One trace per conversation turn. Span hierarchy follows OTel [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) where applicable; Nio-specific extensions use `nio.*` prefix.

```text
Trace: invoke_agent UserPromptSubmit  (root, opens at 1st PreToolUse, ends at Stop / SubagentStop)
  ├─ Span: execute_tool <name>   (PreToolUse → PostToolUse)
  ├─ Span: execute_tool <name>   (...)
  └─ Span: task:execute          (TaskCreated → TaskCompleted, or OpenClaw subagent_spawning → subagent_ended)
```

### Span: `invoke_agent UserPromptSubmit` (turn root)

One per conversation turn. Carries the turn-level metadata: conversation id, accumulated token usage, agent identity, and the redacted user-prompt / assistant-reply previews.

| Attribute | Description | Captured at | Platforms |
| --- | --- | --- | --- |
| `gen_ai.operation.name` | Constant `invoke_agent` | turn close | all |
| `gen_ai.provider.name` | Constant `nio` | turn close | all |
| `gen_ai.conversation.id` | Host session ID | turn close | all |
| `gen_ai.agent.name` | Platform name acting as agent identifier | turn close | all |
| `session.id` | Mirror of `gen_ai.conversation.id` for OTel base-spec consumers | turn close | all |
| `gen_ai.usage.input_tokens` | Input tokens consumed across the turn | Stop · SubagentStop · SessionEnd | all |
| `gen_ai.usage.output_tokens` | Output tokens generated across the turn | Stop · SubagentStop · SessionEnd | all |
| `gen_ai.usage.cache_creation.input_tokens` | Cache-creation input tokens | Stop · SubagentStop · SessionEnd | all |
| `gen_ai.usage.cache_read.input_tokens` | Cache-read input tokens | Stop · SubagentStop · SessionEnd | all |
| `nio.platform` | Source platform — `claude-code` / `hermes` / `openclaw` | turn close | all |
| `nio.turn_number` | Per-session counter, starts at 1 | turn close | all |
| `nio.cwd` | Working dir at turn start | turn close (when set) | all |
| `nio.turn.user_prompt` | First user message of the turn, redacted, ≤2 KB | UserPromptSubmit | all |
| `nio.turn.assistant_reply` | First assistant reply of the turn, redacted, ≤2 KB | `llm_output` (OpenClaw-native) | OpenClaw only |
| `nio.turn.cache_hit_rate` | `cache_read / (input + cache_creation + cache_read)`, 0–1 | turn close | all |

**Token usage source** differs by platform. **Claude Code**: `Stop` reads the transcript JSONL and sums `message.usage` from all assistant entries since turn start. **Hermes**: same code path as CC if the transcript path is included in the `post_llm_call` payload; otherwise empty. **OpenClaw**: `llm_output` event payload carries usage directly; accumulated incrementally.

### Span: `execute_tool <name>` (tool span)

One per tool invocation. Span name is literally `execute_tool ${toolName || 'unknown'}`. Pre-event opens the span; post-event closes it (with retroactive start time on CC/Hermes since the pre-side process is gone).

| Attribute | Description | Captured at | Platforms |
| --- | --- | --- | --- |
| `gen_ai.operation.name` | Constant `execute_tool` | PostToolUse | all |
| `gen_ai.tool.name` | Host tool name (`Bash`, `WebFetch`, …) | PreToolUse · PostToolUse | all |
| `gen_ai.tool.type` | Tool type, when known | PostToolUse | all |
| `gen_ai.tool.call.id` | Host tool-call id (`tool_use_id` on CC, `toolCallId` on OpenClaw) | PreToolUse · PostToolUse | all |
| `gen_ai.tool.call.arguments` | Tool input, redacted, ≤2 KB | PreToolUse | all |
| `gen_ai.tool.call.result` | Tool output, redacted, ≤2 KB | PostToolUse | all |
| `nio.tool.error` | Error message when the tool failed | PostToolUse | all |
| `nio.tool.duration_ms` | Wall-clock tool execution time (ms) | PostToolUse | OpenClaw only |
| `nio.tool.run_id` | OpenClaw-internal run identifier | PreToolUse | OpenClaw only |
| `nio.tool_summary` | One-line summary derived from tool input | PostToolUse | all |
| `nio.platform` | Source platform — `claude-code` / `hermes` / `openclaw` | PostToolUse | all |
| `nio.turn_number` | Parent turn's number | PostToolUse | all |
| `nio.cwd` | Working dir at hook fire | PostToolUse (when set) | all |
| `nio.guard.decision` | Guard verdict — `allow` / `deny` / `confirm_allowed` / `confirm_denied` | PreToolUse | OpenClaw only |
| `nio.guard.risk_level` | Guard risk level — `low` / `medium` / `high` / `critical` / `unknown` | PreToolUse | OpenClaw only |
| `nio.guard.risk_score` | Guard risk score, 0–1 | PreToolUse | OpenClaw only |
| `nio.guard.risk_tags` | Comma-joined rule IDs that fired | PreToolUse | OpenClaw only |

**Span status:** `ERROR` (with `recordException(error)`) when the tool failed or the guard denied / confirm-denied; `OK` otherwise.

**`nio.guard.*` on Claude Code?** Not yet — CC's guard decisions go to the audit log only; symmetric trace-span adoption is queued as a follow-up.

### Span: `task:execute` (task span)

One per subagent dispatch. Opens at `TaskCreated` (CC, Teammates / cloud-agent flows) or `subagent_spawning` (OpenClaw); closes at the matching completion event.

| Attribute | Description | Captured at | Platforms |
| --- | --- | --- | --- |
| `nio.task_id` | Task id from the dispatch event | TaskCreated | Claude Code + OpenClaw |
| `nio.task_summary` | Derived from task input (CC: `task_input.prompt`; OpenClaw: empty) | TaskCreated | Claude Code + OpenClaw |
| `nio.platform` | Source platform — `claude-code` / `openclaw` | TaskCompleted | Claude Code + OpenClaw |
| `nio.session_id` | Host session id | TaskCompleted | Claude Code + OpenClaw |
| `nio.turn_number` | Parent turn's number | TaskCompleted | Claude Code + OpenClaw |
| `nio.cwd` | Working dir at task start | TaskCompleted | Claude Code + OpenClaw |

> **Known gap · not yet GenAI-aligned**
>
> Span name is the literal `task:execute` (not `execute_tool task`); session id uses `nio.session_id` instead of `gen_ai.conversation.id` + `session.id`. The other two spans use GenAI semantic conventions; the task span is intentionally on the legacy schema until CC and OpenClaw can migrate in lockstep.

### Trace state lifecycle

Claude Code and Hermes spawn a fresh node process per hook event, so a `PreToolUse` in process A and the matching `PostToolUse` in process B can't share an OTEL `Span` object. Both platforms bridge state via an on-disk cache keyed by session id; pending spans land there at pre-event time and get materialised retroactively at post-event time with the original start timestamp. OpenClaw runs as a single daemon, so the equivalent state lives in an in-memory `Map<sessionId, State>` instead. All three platforms route through the same trace-collector helper functions — span names and attribute keys are identical regardless of where the state was kept.

---

## Logs (audit log)

Audit entries are **dual-written**: OTEL Logs export to `<endpoint>/v1/logs` (when `collector.logs.enabled`) AND a local JSONL file at `collector.logs.path` (when `collector.logs.local`). The JSONL line is the entry verbatim; the OTEL LogRecord uses `body = JSON.stringify(entry)` plus a flat attribute set for indexing.

### Entry types (discriminated by `event`)

#### `event: "guard"` — guard decision (per PreToolUse / PostToolUse)

| Field | Type | Notes |
| --- | --- | --- |
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
| --- | --- | --- |
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
| --- | --- | --- |
| `event` | `"lifecycle"` | discriminator |
| `timestamp` | string | ISO-8601 |
| `platform` | string | host |
| `session_id` | string? | host session id |
| `lifecycle_type` | string | `subagent_spawning` / `subagent_ended` / `agent_end` / `session_start` / `session_end` |
| `details` | `Record<string, unknown>?` | platform-specific (e.g. OpenClaw: `{subagent_id, run_id}`) |

#### `event: "config_error"` — config load failure

| Field | Type | Notes |
| --- | --- | --- |
| `event` | `"config_error"` | discriminator |
| `timestamp` | string | ISO-8601 |
| `config_path` | string | path that failed to load |
| `error_message` | string | parser / IO error |

#### `event: <hook event>` — collector hook record

Discriminator is the canonical hook event name itself: `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `TaskCreated`, `TaskCompleted`, `Stop`, `SubagentStop`, `SessionStart`, `SessionEnd`. One entry written per dispatched hook event.

| Field | Type | Notes |
| --- | --- | --- |
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

The flat attribute set used for OTEL Logs indexing. Same key names as the matching trace span attributes wherever a concept overlaps (tool name, conversation id, guard decision, …) — same query keys work across logs and traces.

- `body` = JSON-stringified entry (full content of the JSONL line)
- `severityNumber` / `severityText` derived from `risk_level`: `low`→INFO, `medium`→WARN, `high`→ERROR, `critical`→FATAL; INFO when no `risk_level`

| Attribute | Description | Captured at | Platforms |
| --- | --- | --- | --- |
| `gen_ai.tool.name` | Host tool name; same key as the tool-span attribute | PreToolUse · PostToolUse · guard decision | all |
| `gen_ai.tool.call.id` | Host tool-call id; same key as the tool-span attribute | PreToolUse · PostToolUse | all |
| `gen_ai.conversation.id` | Host session id; same key as the turn-span attribute | every audit entry with a session | all |
| `session.id` | Mirror of `gen_ai.conversation.id` for OTel base-spec consumers | every audit entry with a session | all |
| `nio.guard.decision` | Guard verdict — `allow` / `deny` / `ask` | guard decision | all |
| `nio.guard.risk_level` | Guard risk level — `low` / `medium` / `high` / `critical` | guard decision | all |
| `nio.guard.risk_score` | Guard risk score, 0–1 | guard decision | all |
| `nio.guard.risk_tags` | Comma-joined rule IDs that fired | guard decision | all |
| `nio.tool_summary` | One-line summary derived from tool input | PreToolUse · PostToolUse | all |
| `nio.task_id` | Task id from the dispatch event | TaskCreated · TaskCompleted | Claude Code + OpenClaw |
| `nio.task_summary` | Derived from task input | TaskCreated | Claude Code + OpenClaw |
| `nio.platform` | Source platform — `claude-code` / `hermes` / `openclaw` | every audit entry | all |
| `nio.cwd` | Working dir at hook fire | every audit entry with cwd | all |
| `nio.event` | Discriminator — hook event name vs guard / lifecycle / scan / config_error | every audit entry | all |
| `nio.event_type` | `pre` / `post` for guard entries | guard decision | all |
| `nio.action_type` | `exec_command` / `write_file` / `network_request` / `read_file` | guard decision | all |
| `nio.max_finding_severity` | Highest finding severity surfaced this run | guard decision | all |
| `nio.phase_stopped` | Which Phase 0–6 produced the decision | guard decision | all |
| `nio.explanation` | Human-readable reason for the verdict | guard decision | all |
| `nio.transcript_path` | CC-only — path to session transcript JSONL | hook events with transcript | Claude Code only |
| `nio.phases.{name}.score` | Per-phase score (Phase 0–6) | guard decision | all |
| `nio.phases.{name}.finding_count` | Per-phase finding count | guard decision | all |
| `nio.phases.{name}.duration_ms` | Per-phase wall-clock cost (ms) | guard decision | all |

Local JSONL path: `collector.logs.path` (default `~/.nio/audit.jsonl`). Rotation kicks in at `collector.logs.max_size_mb` (default 100 MB) — the live file is renamed to `<path>.1`.

---

## Configuration

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
