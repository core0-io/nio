# Collector Signals — Schema Reference

What Nio captures while an agent runs, organised by OTEL signal. This is the schema-of-record; if reality drifts from this doc, the source is wrong.

Three OTEL signals out — **metrics**, **traces**, **logs**. The audit log (logs signal) is the only one with a local backup; metrics and traces are OTLP-only.

**All three are off until a session is armed.** Configuring `collector.endpoint` does not start collection — see [Capture gating](#capture-gating).

## Architecture

The six host platforms each have their own runtime model — Claude Code, Codex, and Hermes spawn a node process per hook event; OpenClaw, Pi, and opencode load Nio in-process and stay resident — but they all converge on the same canonical hook event vocabulary, then on the same three collector modules that own the attribute schema. Schema consistency falls out of the architecture: every attribute key string is owned by exactly one module, no matter which platform produced the event.

```text
   ┌─────────────┐     ┌────────────────┐     ┌────────────────────┐
   │ Claude Code │     │     Hermes     │     │  OpenClaw · Pi ·   │
   │   · Codex   │     │                │     │      opencode      │
   │ per-hook    │     │ per-hook spawn │     │ in-process plugin  │
   │ spawn       │     │ (node hook-cli)│     │    (resident)      │
   └──────┬──────┘     └────────┬───────┘     └─────────┬──────────┘
          │                     │                     │
          ▼                     ▼                     ▼
   ┌──────────────────────────────────────┐   ┌──────────────┐
   │   on-disk state cache                │   │ in-memory    │
   │   bridges span lifecycle across      │   │ Map<sessionId│
   │   short-lived hook processes         │   │ ,CollectorS.>│
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

Claude Code, Codex, and Hermes have to bridge span lifecycle across short-lived hook processes — a `PreToolUse` in process A and the matching `PostToolUse` in process B share state via an on-disk cache. The in-process platforms (OpenClaw, Pi, opencode) hold the same state in memory, in the `Map<sessionId, CollectorState>` owned by `InProcessPluginRuntime`. Both end up calling the same trace-collector helpers; the only difference is where the state lives between events.

## Per-platform signal coverage

What each host can actually supply. "✓" means fully supplied; "—" means
the platform has no such concept or does not expose it (those gaps are
architectural, not bugs); "~" means partially supplied or supplied but
unverified — the cell says which.

| Signal | Claude Code | Codex | Hermes | OpenClaw | Pi | opencode |
| --- | --- | --- | --- | --- | --- | --- |
| Turn root span `invoke_agent UserPromptSubmit` | ✓ | ✓ | ✓ | ✓ | ✓ (`agent_end`) | ✓ (`session.idle`) |
| Tool span `execute_tool <name>` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Deny / confirm-denied orphan span | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Task span `task:execute` (subagents) | ✓ | — | — | ✓ | **— (Pi has no subagent concept)** | ✓ (`session.created` with `parentID`) |
| `gen_ai.tool.call.id` | ✓ | ✓ | ✓ | ✓ | ✓ (`toolCallId`) | ✓ (`callID`) |
| Token usage on the turn span | ✓ (transcript) | **— (parser is Claude-Code-schema-only)** | ✓ when `transcriptPath` supplied | ✓ (`llm_output`) | ✓ (`message_end`) | ✓ (`message.updated`, de-duplicated to a per-message delta) |
| `nio.turn.user_prompt` | ✓ | ✓ | ✓ | ✓ | ✓ (`input`) | ✓ (`chat.message`) |
| `nio.turn.assistant_reply` | — | — | — | ✓ (`llm_output`) | ✓ (`message_end`) | — |
| `nio.tool.duration_ms` / `nio.tool.run_id` | — | — | — | ✓ | — | — |
| Interactive `confirm` (`guard.confirm_action: ask`) | ✓ `permissionDecision: 'ask'` | ~ same payload emitted, host support unverified | **— falls back to _deny_** | — (folds to allow) | ✓ real `ctx.ui.confirm` dialog | ✓ via `permission.ask` |
| Human-typed shell audited (`lifecycle_type: user_bash`) | — | — | — | — | ✓ (audit only, never blocked) | — |
| All four metric instruments | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Audit log (local JSONL + OTLP logs) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

Four honest caveats:

- **Codex turn spans carry no token usage.** `parseTranscriptUsage` only
  counts transcript entries whose `type` is `"assistant"` and reads the
  Claude Code field names (`message.usage.input_tokens`,
  `cache_creation_input_tokens`, `cache_read_input_tokens`). Codex's
  transcript JSONL uses different event types and a different shape, so
  the parser matches nothing and returns null. A codex-specific parser is
  phase-2 work.
- **`guard.confirm_action: ask` has no single fallback.** Claude Code,
  Pi, and opencode each reach a real prompt. Codex emits the same
  `permissionDecision: 'ask'` payload as Claude Code (it shares
  `guard-hook.ts`), but the repo does not establish that the Codex host
  honours it. OpenClaw folds `ask` to **allow**; Hermes folds it to
  **deny** — it has no confirmation channel, so `hook-cli.ts` returns
  `decision: 'block'` plus a stderr note. Do not assume "else allow".
- **Pi emits no `task:execute` spans.** Pi has no subagent concept at
  all, so there is nothing to open a task span for. An empty task-span
  set on Pi is correct behaviour, not a dropped signal.
- **opencode's `tool.execute.after` does not fire for a tool that
  throws.** Those tool spans are therefore not closed precisely at
  completion time; they are *reclaimed* by the `session.idle` flush,
  which force-closes any pending spans before emitting the turn root.
  The span still lands in the trace with the right parent, carrying the
  same `nio.guard.*` attribution a normally closed span gets, and it is
  explicitly labelled as reclaimed:

  | Attribute | Value |
  | --- | --- |
  | `nio.span.reclaimed` | `true` |
  | `nio.span.reclaim_reason` | `no_post_tool_event` |

  Filter on `nio.span.reclaimed` to separate these from spans closed on
  a real tool return. On opencode this is the normal path for every
  failing tool call — not a rare edge.

  A reclaimed span is still **degraded in two ways**:
  1. Its end timestamp is the turn flush, not the tool's real finish, so
     its duration is an over-estimate.
  2. It carries **no `gen_ai.tool.call.result`** — nothing ever
     delivered one.

  **The tool's outcome is unknown, and the span does not claim
  otherwise.** Nio deliberately does not mark a reclaimed span `ERROR`:
  the after-hook is missing, which on opencode usually means the tool
  threw, but "usually" is not "always" and an ERROR status would be as
  much of a fabrication as claiming success. The OTel status field
  cannot express "unknown" either — `UNSET` is already what a
  successfully closed Nio tool span carries (nothing in Nio ever calls
  `setStatus(OK)`), and the SDK drops the `message` on a non-ERROR
  status. That is exactly why the two `nio.span.*` attributes above
  exist. **Do not read span status as a tool success rate on opencode**;
  read `nio.span.reclaimed` instead and treat those calls as
  outcome-unknown.

  The guard signal is independently complete regardless: it is emitted
  on the pre-side, before and independently of any span close — the
  audit log (`~/.nio/audit.jsonl` plus the OTLP logs export) is written
  by `evaluateHook` during `onPreTool`, and the `guard_decision` metric
  is recorded by `onPreTool` immediately after it.

  > **Joining a span back to its audit row.** Not by tool-call id.
  > `AuditGuardEntry` has no tool-call-id field at all; the
  > `gen_ai.tool.call.id` log attribute is derived solely from
  > `entry.tool_use_id`, which only the hook-based collector (Claude
  > Code / Codex / Hermes) populates — the in-process runtime writes
  > guard rows and lifecycle rows, neither of which carries it. The
  > `guard_decision` metric is no help either: its only labels are
  > `nio.guard.decision`, `nio.guard.risk_level` and `gen_ai.tool.name`
  > (plus the resource's `nio.platform`). The workable join is
  > **session id + `gen_ai.tool.name` + timestamp**: audit rows carry
  > `session_id` (exported as `gen_ai.conversation.id` / `session.id`)
  > and `tool_name`, and the tool span's enclosing turn span carries the
  > same `gen_ai.conversation.id`. **Join on the span's START timestamp,
  > not its end** — for exactly the reclaimed spans this note is about,
  > the end timestamp is the turn flush (see the degradation list
  > above), which can be arbitrarily far from the audit row; the start
  > timestamp is still the real `onPreTool` moment, the same instant
  > that wrote the row. Since the span now carries
  > `nio.guard.*` directly, you normally only need this join to reach
  > the full finding list and per-phase scores, which live in the audit
  > row alone.

## Capture gating

Nio exports nothing by default. Each of the three signals is created only
for sessions the user explicitly armed, or for every session when
`collector.monitor_all_sessions: true` is set.

Conversation content is gated by exactly this switch on both signals it
uses: the content records need a logger provider,
which an unarmed session never builds, and the span attributes that carry
small bodies (`nio.chat.reply`, `gen_ai.tool.call.arguments`) ride the
traces provider, which an unarmed session never builds either.

This gate covers only the three OTLP signals above. The guard pipeline's
Phase 5 (`guard.llm_analyser`) and Phase 6 (`guard.external_analyser`) have
their own, independent outbound paths — see "Two things are outside the
gate" below — and are not affected by monitor state either way. Both ship
disabled (`llm_analyser.enabled: false`, `external_analyser: []`), so on
an unmodified config nothing leaves the machine through them either.

Arming is `/nio-monitor on` on the platforms that install the focused
`nio-*` skills (Claude Code, Codex, Pi, opencode) and `/nio monitor on`
on OpenClaw and Hermes, which keep the unified `/nio` as their only entry
point. Both forms run the same code. Claude Code is the only host whose
session-id environment variable is verified, so everywhere else `on`
leaves a *pending arm* that the next hook event from the same directory
claims (60 s TTL).

The gate sits **before OTEL provider creation** — an unmonitored session
does not initialise exporters at all, so the cost is one small file read
per hook event. This includes the SessionStart skill scanner, whose
`session_scan` records would otherwise carry the user's installed-skill
inventory and its risk levels off the machine before anything was armed.

Two things are outside the gate:

- **Guard enforcement.** Phase 0–6 risk evaluation and blocking run
  regardless. The switch controls reporting, not enforcement. Phases 0–4
  are local pattern/AST matching with no network I/O. Phase 5
  (`guard.llm_analyser`) sends the content under evaluation to the
  Anthropic API when enabled; Phase 6 (`guard.external_analyser`) issues
  a GET-only request per configured endpoint to fetch a score, without
  sending any evaluated content. Both are independent of monitor state
  and both ship disabled by default (`llm_analyser.enabled: false`,
  `external_analyser: []`).
- **Local audit log.** `~/.nio/audit.jsonl` is written regardless, since
  it never leaves the machine and backs `/nio report`.

**One limitation, on the in-process hosts (OpenClaw · Pi · opencode).**
These three load Nio into a long-lived host process and OTEL counters
there are cumulative for the life of that process. A host in which no
session has ever been armed creates no providers and exports nothing. But
once any session has been armed and recorded a counter, the metrics
exporter keeps re-sending its accumulated totals about once a second until
the host restarts — disarming, session end and the arm-record deletion all
stop *new* data being collected, but none of them can stop that timer. The
three hook platforms (Claude Code, Codex, Hermes) run one process per hook
event, so nothing outlives it.

State lives in `${NIO_HOME}/monitored-sessions.json`, separate from
`traces-state-store.json` — session-scoped durable state versus
turn-scoped ephemeral state.

There is **no backfill**: capture starts at the moment `/nio-monitor`
runs. Platforms differ in whether historical session data exists at all
(Claude Code and Codex keep session files; Hermes and OpenClaw do not),
so retroactive capture is not offered anywhere, keeping behaviour uniform.
## Naming conventions

- `gen_ai.*` — keys that follow the OTel [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/). Used wherever there's a spec equivalent: tool name, conversation id, token usage, tool I/O.
- `nio.*` — vendor extensions for concepts the GenAI spec doesn't cover: guard decisions, per-phase scoring, platform tag, redacted prompt / reply previews, per-task subagent metadata.
- `session.id` — mirrored alongside `gen_ai.conversation.id` for OTel base-spec consumers that key off session id rather than conversation id. Same value.

Cross-signal: the same key name carries the same meaning across metrics, traces, and logs. `gen_ai.tool.name` on a metric label is the same string as the matching trace span attribute, which is the same string as the matching audit-log attribute. Joining signals in dashboards Just Works.

---

## Resource attributes

Three identity attributes live on the OTel `Resource` that every Nio
provider (tracer / logger / meter) constructs. Resource attrs flow to
every span, log record, and metric data point that provider emits —
backends surface them as top-level service selectors / filter
columns.

| Attribute | Value | Notes |
| --- | --- | --- |
| `service.name` | `nio-<platform>` | One per agent runtime: `nio-claude-code`, `nio-codex`, `nio-hermes`, `nio-openclaw`, `nio-pi`, `nio-opencode`. Backends like SigNoz / Jaeger split these into independent services in their main selector. |
| `nio.platform` | `<platform>` | Raw value of the platform tag (`claude-code` / `codex` / `hermes` / `openclaw` / `pi` / `opencode`). Provided as a separate attr so users who don't want to parse `service.name` can filter on it directly. |
| `gen_ai.agent.name` | `<configured value>` | Only set when the operator configures [`agent_name`](configuration.html#agent_name) in `~/.nio/config.yaml`. Absent on the resource when unset. The turn span carries the same key as a span-level attribute with a platform-default fallback for unconfigured users (see the turn-span attribute table below). |

> **Behaviour change in v2.4.2.** Earlier releases set `service.name=nio` for every platform and put `nio.platform` only on individual spans. Existing dashboards / alerts filtered on `service.name="nio"` will not match new data — re-target to `service.name=nio-*` (wildcard) or filter on `nio.platform` instead. Historical traces / logs / metrics keep their original `service.name=nio`.

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
| `nio.platform` | Source platform — `claude-code` / `codex` / `hermes` / `openclaw` / `pi` / `opencode` | every metric | all |
| `nio.guard.decision` | Guard verdict — `allow` / `deny` / `ask` | guard decision | all |
| `nio.guard.risk_level` | Guard risk level — `low` / `medium` / `high` / `critical` | guard decision | all |
| `nio.risk_level` | Nio risk level of the entry — same values, but present on **any** entry carrying one, including a `session_scan` entry that has a risk level and no guard decision. Absent when the entry has none. Not a log level — see the severity note above | guard decision · session scan | all |

### Label sets per instrument

| Instrument | Labels |
| --- | --- |
| `nio.tool_use.count` | `gen_ai.tool.name` · `nio.event` · `nio.platform` |
| `nio.turn.count` | `nio.platform` |
| `nio.decision.count` | `nio.guard.decision` · `nio.guard.risk_level` · `gen_ai.tool.name` · `nio.platform` |
| `nio.risk.score` | `gen_ai.tool.name` · `nio.platform` |

**Note — `agent_name` deliberately not a metric label.** The user-configured [`agent_name`](configuration.html#agent_name) lands on traces (`gen_ai.agent.name`) and on audit-log records (`agent_name` field), but **not** on metrics. Adding it as a metric label would multiply every series by the number of distinct agent names and inflate the backend's cardinality budget. Use `nio.platform` for host-level metric slicing; query the trace / log layer if you need to attribute metrics back to a specific deployment.

> **Claude Code · Task → Agent**
>
> The user-facing **Task** tool (subagent dispatch) is reported as `tool_name="Agent"` in Claude Code hook payloads, so PreToolUse / PostToolUse counters use `Agent` as the `gen_ai.tool.name` label. The literal value `Task` only appears as a counter label when `TaskCreated` / `TaskCompleted` fire (Teammates / cloud-agent flows; never fired by the regular Task tool subagent on current Claude Code builds — see [`e2e-test/hook-subagent-e2e-task.md`](../e2e-test/hook-subagent-e2e-task.md)). OpenClaw and Hermes use their own native tool names.

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
| `gen_ai.agent.name` | User-configured [`agent_name`](configuration.html#agent_name) from `~/.nio/config.yaml`; falls back to platform when unset | turn close | all |
| `session.id` | Mirror of `gen_ai.conversation.id` for OTel base-spec consumers | turn close | all |
| `gen_ai.usage.input_tokens` | Input tokens consumed across the turn | Stop · SubagentStop · SessionEnd | all |
| `gen_ai.usage.output_tokens` | Output tokens generated across the turn | Stop · SubagentStop · SessionEnd | all |
| `gen_ai.usage.cache_creation.input_tokens` | Cache-creation input tokens | Stop · SubagentStop · SessionEnd | all |
| `gen_ai.usage.cache_read.input_tokens` | Cache-read input tokens | Stop · SubagentStop · SessionEnd | all |
| `nio.platform` | Source platform — `claude-code` / `codex` / `hermes` / `openclaw` / `pi` / `opencode` | turn close | all |
| `nio.turn_number` | Per-session counter, starts at 1 | turn close | all |
| `nio.cwd` | Working dir at turn start | turn close (when set) | all |
| `nio.turn.user_prompt` | First user message of the turn, redacted, ≤2 KB | UserPromptSubmit | all |
| `nio.turn.assistant_reply` | First assistant reply of the turn, redacted, ≤2 KB | `llm_output` (OpenClaw) · `message_end` (Pi) | OpenClaw + Pi |
| `nio.turn.cache_hit_rate` | `cache_read / (input + cache_creation + cache_read)`, 0–1 | turn close | all |

**Token usage source** differs by platform. **Claude Code**: `Stop` reads the transcript JSONL and sums `message.usage` from all assistant entries since turn start. **Codex**: none today — `parseTranscriptUsage` matches only Claude-Code-shaped transcript entries (`type: "assistant"` plus `message.usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`), and Codex's transcript JSONL uses different event types and a different shape, so it returns null and the turn span carries no `gen_ai.usage.*`. **Hermes**: same code path as Claude Code if the transcript path is included in the `post_llm_call` payload; otherwise empty. **OpenClaw**: `llm_output` event payload carries usage directly; accumulated incrementally. **Pi**: `message_end` carries `message.usage` once per assistant message; accumulated the same way. **opencode**: `message.updated` carries a *cumulative snapshot* republished on every change to the same message, so the binding tracks last-seen totals per message id and accumulates only the delta — otherwise a re-publish would compound the turn's totals.

### Span: `execute_tool <name>` (tool span)

One per tool invocation. Span name is literally `execute_tool ${toolName || 'unknown'}`. Pre-event opens the span; post-event closes it (with retroactive start time on Claude Code/Hermes since the pre-side process is gone).

| Attribute | Description | Captured at | Platforms |
| --- | --- | --- | --- |
| `gen_ai.operation.name` | Constant `execute_tool` | PostToolUse | all |
| `gen_ai.tool.name` | Host tool name (`Bash`, `WebFetch`, …) | PreToolUse · PostToolUse | all |
| `gen_ai.tool.type` | Tool type, when known | PostToolUse | all |
| `gen_ai.tool.call.id` | Host tool-call id (`tool_use_id` on Claude Code, `toolCallId` on OpenClaw / Pi, `callID` on opencode) | PreToolUse · PostToolUse | all |
| `gen_ai.tool.call.arguments` | Tool input, redacted, ≤2 KB | PreToolUse | all |
| `gen_ai.tool.call.result` | Tool output, redacted, ≤2 KB | PostToolUse | all |
| `nio.tool.error` | Error message when the tool failed | PostToolUse | all |
| `nio.tool.duration_ms` | Wall-clock tool execution time (ms) — absent on the deny / confirm-denied span (the tool didn't run; use `nio.guard.eval_ms` instead) | PostToolUse | OpenClaw only |
| `nio.tool.run_id` | OpenClaw-internal run identifier | PreToolUse | OpenClaw only |
| `nio.tool_summary` | One-line summary derived from tool input | PostToolUse | all |
| `nio.platform` | Source platform — `claude-code` / `codex` / `hermes` / `openclaw` / `pi` / `opencode` | PostToolUse | all |
| `nio.turn_number` | Parent turn's number | PostToolUse | all |
| `nio.cwd` | Working dir at hook fire | PostToolUse (when set) | all |
| `nio.guard.decision` | Guard verdict — `allow` / `deny` / `confirm_allowed` / `confirm_denied` | PreToolUse | all |
| `nio.guard.risk_level` | Guard risk level — `low` / `medium` / `high` / `critical` / `unknown` | PreToolUse | all |
| `nio.guard.risk_score` | Guard risk score, 0–1 | PreToolUse | all |
| `nio.guard.risk_tags` | Comma-joined rule IDs that fired | PreToolUse | all |
| `nio.guard.phase_stopped` | Phase that produced the verdict (`0` = tool-gate, `1`–`6` = runtime pipeline) | PreToolUse | all |
| `nio.guard.top_finding_rule` | `rule_id` of the highest-ranked finding (when any fired) | PreToolUse | all |
| `nio.guard.eval_ms` | Wall-clock cost of the guard evaluation (ms) | PreToolUse | all |
| `nio.span.reclaimed` | `true` on a span the turn flush had to close because the host never delivered a post-side event. Absent otherwise | turn flush | in-process platforms (in practice: opencode) |
| `nio.span.reclaim_reason` | Why it was reclaimed — currently only `no_post_tool_event` | turn flush | in-process platforms (in practice: opencode) |

**Span status:** `ERROR` (with `recordException(error)`) when the tool failed or the guard denied / confirm-denied. Otherwise the status is left at the OTel default, `UNSET` — Nio never calls `setStatus(OK)`, and most backends render `UNSET` as "ok". A **reclaimed** span (`nio.span.reclaimed=true`) is also `UNSET`, but that does *not* mean it succeeded: its outcome is genuinely unknown. Treat `UNSET` as success only for spans without the reclaim marker.

**Deny / confirm-denied spans.** When the guard blocks a tool, `PostToolUse` never fires — so the span is emitted synchronously by the same process that ran the guard (the `guard-hook.ts` PreToolUse on Claude Code / Codex; the `hook-cli.ts` `pre_tool_call` branch on Hermes; `InProcessPluginRuntime.onPreTool`'s block path for OpenClaw / Pi / opencode, reached from `before_tool_call` / `tool_call` / `tool.execute.before` respectively — and, on Pi, also from `resolveConfirm` when the human declines the dialog). Span name is the same `execute_tool <tool>` as the allow path — the discrimination is on `nio.guard.decision` + ERROR status + the reason in the exception message. Wall-clock starts at the real `evalStartMs` so the span duration reflects the guard window, and `nio.guard.eval_ms` carries the same value as an explicit attribute for filtering.

### Span: `task:execute` (task span)

One per subagent dispatch. Opens at `TaskCreated` (Claude Code, Teammates / cloud-agent flows), `subagent_spawning` (OpenClaw), or `session.created` carrying a `parentID` (opencode); closes at the matching completion event — for opencode, the *child* session's own `session.idle`, routed back to the parent through a child→parent map.

**Pi emits no task spans at all**: Pi has no subagent concept, so there is nothing to open one for.

| Attribute | Description | Captured at | Platforms |
| --- | --- | --- | --- |
| `nio.task_id` | Task id from the dispatch event | TaskCreated | Claude Code + OpenClaw |
| `nio.task_summary` | Derived from task input (Claude Code: `task_input.prompt`; OpenClaw: empty) | TaskCreated | Claude Code + OpenClaw |
| `nio.platform` | Source platform — `claude-code` / `openclaw` | TaskCompleted | Claude Code + OpenClaw |
| `nio.session_id` | Host session id | TaskCompleted | Claude Code + OpenClaw |
| `nio.turn_number` | Parent turn's number | TaskCompleted | Claude Code + OpenClaw |
| `nio.cwd` | Working dir at task start | TaskCompleted | Claude Code + OpenClaw |

> **Known gap · not yet GenAI-aligned**
>
> Span name is the literal `task:execute` (not `execute_tool task`); session id uses `nio.session_id` instead of `gen_ai.conversation.id` + `session.id`. The other two spans use GenAI semantic conventions; the task span is intentionally on the legacy schema until Claude Code and OpenClaw can migrate in lockstep.

### Trace state lifecycle

Claude Code, Codex, and Hermes spawn a fresh node process per hook event, so a `PreToolUse` in process A and the matching `PostToolUse` in process B can't share an OTEL `Span` object. Those platforms bridge state via an on-disk cache keyed by session id; pending spans land there at pre-event time and get materialised retroactively at post-event time with the original start timestamp. OpenClaw, Pi, and opencode load Nio in-process and stay resident, so the equivalent state lives in an in-memory `Map<sessionId, CollectorState>` owned by `InProcessPluginRuntime` instead. Every platform routes through the same trace-collector helper functions — span names and attribute keys are identical regardless of where the state was kept.

**opencode's reclaim path.** opencode does not fire `tool.execute.after` when the tool itself throws, so a pending span would otherwise leak. The `session.idle` handler doubles as the safety net: `onTurnEnd` force-closes every leftover pending span before emitting the turn root. Such a span is *reclaimed*, not closed precisely: `flushSessionTurn` drains the parked guard attrs onto it (so it carries the full `nio.guard.*` set) and tags it `nio.span.reclaimed=true` / `nio.span.reclaim_reason=no_post_tool_event`, but its end timestamp is the turn flush and it carries no `gen_ai.tool.call.result`. Its status is left `UNSET` — the tool's real outcome is unknowable at flush time, so the span asserts neither success nor failure. The audit log and the `guard_decision` metric are unaffected — both are emitted pre-side by `onPreTool`. See [Per-platform signal coverage](#per-platform-signal-coverage) for the full caveat.

---

## Logs (audit log)

Audit entries are **dual-written**: OTEL Logs export to `<endpoint>/v1/logs` (when `collector.logs.enabled`) AND a local JSONL file at `collector.logs.path` (when `collector.logs.local`). The JSONL line is the entry verbatim; the OTEL LogRecord uses `body = JSON.stringify(entry)` plus a flat attribute set for indexing.

### Entry types (discriminated by `event`)

#### `event: "guard"` — guard decision (per PreToolUse / PostToolUse)

| Field | Type | Notes |
| --- | --- | --- |
| `event` | `"guard"` | discriminator |
| `timestamp` | string | ISO-8601 |
| `platform` | string | `claude-code` / `codex` / `hermes` / `openclaw` / `pi` / `opencode` |
| `agent_name` | string? | User-configured [`agent_name`](configuration.html#agent_name); omitted when unset |
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
| `agent_name` | string? | User-configured [`agent_name`](configuration.html#agent_name); omitted when unset |
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
| `agent_name` | string? | User-configured [`agent_name`](configuration.html#agent_name); omitted when unset |
| `session_id` | string? | host session id |
| `lifecycle_type` | string | `subagent_spawning` / `subagent_ended` / `agent_end` / `session_start` / `session_end` / `user_bash` |
| `details` | `Record<string, unknown>?` | platform-specific (e.g. OpenClaw: `{subagent_id, run_id}`; Pi `user_bash`: `{command, cwd, actor: "user"}`) |

> **`user_bash` — Pi only, audit-only.** Pi fires a `user_bash` event when the *human* types a `!`-prefixed shell command. Nio guards agent actions, not human keystrokes, so this path writes a lifecycle entry (`lifecycle_type: "user_bash"`, `details.actor: "user"`) and **never** runs Phase 0-6 and **never** blocks. There is no `event: "guard"` row for it.

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
| `agent_name` | string? | User-configured [`agent_name`](configuration.html#agent_name); omitted when unset |
| `session_id` | string? | host session id |
| `cwd` | string \| null | working dir |
| `transcript_path` | string? | Claude Code-only — path to session transcript JSONL |
| `tool_name` | string? | for PreToolUse / PostToolUse |
| `tool_use_id` | string? | for PreToolUse / PostToolUse |
| `tool_summary` | string? | for PreToolUse / PostToolUse |
| `task_id` | string? | for TaskCreated / TaskCompleted |
| `task_summary` | string? | for TaskCreated |

### OTEL LogRecord projection

The flat attribute set used for OTEL Logs indexing. Same key names as the matching trace span attributes wherever a concept overlaps (tool name, conversation id, guard decision, …) — same query keys work across logs and traces.

- `body` = JSON-stringified entry (full content of the JSONL line)
- `severityNumber` / `severityText` — always an **OTel severity**, never a nio risk level. `severityText` is one of `INFO` / `WARN` / `ERROR` / `FATAL`, and always the standard name of the record's own `severityNumber`
- `nio.risk_level` — the nio risk level, when the entry has one

**Severity and risk level are two different dimensions.** `severityNumber` /
`severityText` are the OTel log level, and backends build their severity
facets and filters from the names the OTel logs data model defines. Nio's
risk level (`low` / `medium` / `high` / `critical`) is a classification of
the *action*, not of the log record, so it travels as its own attribute:

| entry carries | `severityNumber` | `severityText` | `nio.risk_level` |
| --- | --- | --- | --- |
| `risk_level: low` | 9 | `INFO` | `low` |
| `risk_level: medium` | 13 | `WARN` | `medium` |
| `risk_level: high` | 17 | `ERROR` | `high` |
| `risk_level: critical` | 21 | `FATAL` | `critical` |
| any other / unrecognised `risk_level` | 9 | `INFO` | the value as-is |
| no `risk_level` (hook, lifecycle, diagnostic) | 9 | `INFO` | *absent* |

An entry without a risk level is `INFO` because nio reached no verdict on
it — not because the verdict was "low". Filter on `nio.risk_level`, not on
severity, to find low-risk actions.

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
| `nio.platform` | Source platform — `claude-code` / `codex` / `hermes` / `openclaw` / `pi` / `opencode` | every audit entry | all |
| `gen_ai.agent.name` | User-configured [`agent_name`](configuration.html#agent_name) from `~/.nio/config.yaml`; only emitted when set | every audit entry (when configured) | all |
| `nio.cwd` | Working dir at hook fire | every audit entry with cwd | all |
| `nio.event` | Discriminator — hook event name vs guard / lifecycle / scan / config_error | every audit entry | all |
| `nio.event_type` | `pre` / `post` for guard entries | guard decision | all |
| `nio.action_type` | `exec_command` / `write_file` / `network_request` / `read_file` | guard decision | all |
| `nio.max_finding_severity` | Highest finding severity surfaced this run | guard decision | all |
| `nio.phase_stopped` | Which Phase 0–6 produced the decision | guard decision | all |
| `nio.explanation` | Human-readable reason for the verdict | guard decision | all |
| `nio.transcript_path` | Claude Code-only — path to session transcript JSONL | hook events with transcript | Claude Code only |
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
  headers: {}                       # extra OTLP request headers; values are stringified
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
