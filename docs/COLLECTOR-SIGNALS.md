# Collector Signals — Schema Reference

What Nio captures while an agent runs, organised by OTEL signal. This is the schema-of-record; if reality drifts from this doc, the source is wrong.

Three OTEL signals out — **metrics**, **traces**, **logs**. The audit log (logs signal) is the only one with a local backup; metrics and traces are OTLP-only.

## Architecture

The four host platforms each have their own runtime model — Claude Code, Codex, and Hermes spawn a node process per hook event, OpenClaw runs as a long-lived daemon — but they all converge on the same canonical hook event vocabulary, then on the same three collector modules that own the attribute schema. Schema consistency falls out of the architecture: every attribute key string is owned by exactly one module, no matter which platform produced the event.

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

Claude Code and Hermes have to bridge span lifecycle across short-lived hook processes — a `PreToolUse` in process A and the matching `PostToolUse` in process B share state via an on-disk cache. OpenClaw's daemon model holds the same state in memory. Both end up calling the same trace-collector helpers; the only difference is where the state lives between events.

## Capture gating

Nio exports nothing by default. Each of the three signals is created only
for sessions the user explicitly armed, or for every session when
`collector.monitor_all_sessions: true` is set.

Conversation content ([content records](#content-records)) rides the logs
signal, so it is gated by exactly this switch: an unarmed session builds
no logger provider, and nothing in the content path can emit without one.

This gate covers only the three OTLP signals above. The guard pipeline's
Phase 5 (`guard.llm_analyser`) and Phase 6 (`guard.external_analyser`) have
their own, independent outbound paths — see "Two things are outside the
gate" below — and are not affected by monitor state either way. Both ship
disabled (`llm_analyser.enabled: false`, `external_analyser: []`), so on
an unmodified config nothing leaves the machine through them either.

Arming is `/nio-monitor on` on Claude Code and Codex, and `/nio monitor on`
on OpenClaw and Hermes — those two platforms do not install the focused
`nio-*` skills, so the unified `/nio` is their entry point. Both run the
same code.

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

**One limitation, on OpenClaw only.** OpenClaw runs Nio inside a
long-lived daemon and OTEL counters there are cumulative for the life of
that process. A daemon in which no session has ever been armed creates no
providers and exports nothing. But once any session has been armed and
recorded a counter, the metrics exporter keeps re-sending its accumulated
totals about once a second until the daemon restarts — disarming,
`session_end` and the arm-record deletion all stop *new* data being
collected, but none of them can stop that timer. The other three
platforms run one process per hook event, so nothing outlives it.

State lives in `${NIO_HOME}/monitored-sessions.json`, separate from
`traces-state-store.json` — session-scoped durable state versus
turn-scoped ephemeral state.

There is **no backfill**: capture starts at the moment `/nio-monitor`
runs. Platforms differ in whether historical session data exists at all
(Claude Code and Codex keep session files; Hermes and OpenClaw do not),
so retroactive capture is not offered anywhere, keeping behaviour uniform.

## Debug: raw payload capture (`NIO_DUMP_PAYLOAD`)

Everything above describes the *processed* schema Nio extracts from each
platform's hook payload. `NIO_DUMP_PAYLOAD` is a separate, debug-only
switch for capturing the **raw, unprocessed** payload each hook receives
— useful when investigating what a platform's payload actually contains
(e.g. LLM thinking/reasoning content, full conversation history,
transcript paths) that the schema above doesn't yet extract.

**Enable it:**

```bash
export NIO_DUMP_PAYLOAD=/path/to/an/existing/writable/directory
```

Unset (the default): zero effect. No extra I/O, no extra branching cost
on the hook's hot path — this is a debug tool, not a product feature.

**What gets written:** one file per hook invocation,
`<dir>/<timestamp>-<platform>-<event>-<random>.json`, containing the
payload **exactly as received** — no redaction, no truncation, no
schema mapping. The trailing random suffix exists because some platforms
fire more than one process for the same logical event in the same
millisecond (e.g. Claude Code's `PreToolUse` spawns both `guard-hook.ts`
and `collector-hook.ts`).

**How to trigger a sample per platform:**

| Platform | What to run |
| --- | --- |
| Claude Code / Codex | Run any prompt that triggers a tool call, a session start, etc., with `NIO_DUMP_PAYLOAD` set in the environment the CLI launches hooks from. `collector-hook.ts`, `guard-hook.ts`, and `scanner-hook.ts` each dump the raw stdin JSON they receive. |
| Hermes | Same idea — set the variable in the environment Hermes spawns `hook-cli.js` from. Dumps the full JSON envelope for both the guard branch (`pre_tool_call`) and the collector branch (`post_tool_call`, `pre_llm_call`, …). |
| OpenClaw | Set the variable in the daemon's environment before it loads the plugin. Each registered handler (`before_tool_call`, `after_tool_call`, `llm_output`, `session_start`, …) dumps a single file containing both the raw `event` and `ctx` objects it received: `{"event": …, "ctx": …}`. |

**Design notes:**

- **Not gated by the monitor state above.** Everything in "Capture
  gating" governs whether processed telemetry leaves the machine over
  OTLP. `NIO_DUMP_PAYLOAD` writes to a local directory the user
  themselves pointed at and never touches the network — setting the
  variable *is* the explicit, one-time opt-in, so it is deliberately
  independent of `/nio-monitor` / `/nio monitor on`. This is intentional,
  not an oversight — see the doc comment on `dumpPayload()` in
  `src/scripts/lib/payload-dump.ts`.
- **Fails silently.** A missing or unwritable directory, a full disk, or
  a payload that can't be JSON-serialised is swallowed without throwing,
  blocking, or slowing down the hook — and without polluting
  `~/.nio/audit.jsonl` (dump failures never go through
  `reportDiagnostic()`).

**⚠️ Handle dump files as sensitive data.** Because nothing is redacted
or truncated, dump files can contain API keys, full conversation text,
file contents, and anything else present in the raw hook payload. Treat
the output directory as you would a credentials file: don't commit it,
don't upload it as-is, and sanitize/redact before sharing a sample with
anyone (including when filing a bug report).

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
| `service.name` | `nio-<platform>` | One per agent runtime: `nio-claude-code`, `nio-codex`, `nio-hermes`, `nio-openclaw`. Backends like SigNoz / Jaeger split these into independent services in their main selector. |
| `nio.platform` | `<platform>` | Raw value of the platform tag (`claude-code` / `codex` / `hermes` / `openclaw`). Provided as a separate attr so users who don't want to parse `service.name` can filter on it directly. |
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
| `nio.platform` | Source platform — `claude-code` / `codex` / `hermes` / `openclaw` | every metric | all |
| `nio.guard.decision` | Guard verdict — `allow` / `deny` / `ask` | guard decision | all |
| `nio.guard.risk_level` | Guard risk level — `low` / `medium` / `high` / `critical` | guard decision | all |

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
Trace: session                        (its own trace; emitted at SessionEnd)
   ↑ span link
Trace: invoke_agent UserPromptSubmit  (root, opens at 1st PreToolUse, ends at Stop / SubagentStop)
  ├─ Span: chat <model>          (one per LLM call, reconstructed at turn close)
  │    └─ Span: execute_tool <name>   (the tools THAT call issued; not on OpenClaw — see below)
  ├─ Span: execute_tool <name>   (tools that could not be attributed — hung off the turn)
  └─ Span: task:execute          (TaskCreated → TaskCompleted, or OpenClaw subagent_spawning → subagent_ended)
```

**Emission timing.** A tool span can only be nested under the LLM call
that issued it, and that attribution is unknowable at `PostToolUse` time —
it comes from the conversation source once the turn is over. So finished
tool spans are parked in `traces-state-store.json` and the WHOLE tree
(chat spans, their tools, the unattributed tools, the turn root) is
exported together at `Stop` / `SubagentStop` / `SessionEnd`. Two
exceptions keep their immediate export: the guard's deny / confirm-denied
span (a security event must not wait for a turn to close) and OpenClaw's
eager per-tool export.

If the host process dies before the turn closes, the parked tree is
flushed by the next event that finds it — or by the next `SessionStart` —
under a root tagged `nio.turn.incomplete: true`.

**Without a conversation source** (no transcript path, an unreadable
session file, a platform whose conversation data never reached the
collector) the chat layer is skipped entirely and every tool span hangs
off the turn — the pre-chat-layer shape, degraded but never broken. The
tool's arguments and result still reach the backend either way: both go
out as content records at `PostToolUse`, which needs no source (see
[Content records](#content-records)).

**Platform exception · on OpenClaw, `chat` and `execute_tool` are
siblings.** Every other platform nests a tool span under the chat span
that issued it. OpenClaw cannot, because both of `buildSpanTree`'s
attribution channels are unavailable there:

1. `createOpenClawSource` never emits a `tool_use` block — its own
   documented known gap. OpenClaw's `llm_output` event carries no content
   field, and correlating `before_tool_call` / `after_tool_call` back to
   the right chat call would be guesswork on a platform the source has
   never been verified against live.
2. All OpenClaw calls are `timing: 'synthetic'` (no event carries a real
   timestamp), and the time-window fallback skips synthetic calls by
   design.

So every OpenClaw tool span is an orphan and lands on the turn root
**regardless of when it is emitted** — verified by running the plugin
with its `after_tool_call` deferred like every other platform's: the
parent stayed the turn root. That is why the plugin keeps its eager
per-tool export: deferring would trade crash-resilience (OpenClaw holds
its state in memory, so there is nothing on disk for the recovery path to
replay) and prompt visibility for no structural gain. Closing the
exception requires teaching `openclaw-source.ts` to reconstruct
`tool_use` first.

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
| `nio.platform` | Source platform — `claude-code` / `codex` / `hermes` / `openclaw` | turn close | all |
| `nio.turn_number` | Per-session counter, starts at 1 | turn close | all |
| `nio.cwd` | Working dir at turn start | turn close (when set) | all |
| `nio.turn.user_prompt` | First user message of the turn, redacted, ≤2 KB | UserPromptSubmit | all |
| `nio.turn.assistant_reply` | First assistant reply of the turn, redacted, ≤2 KB | `llm_output` (OpenClaw-native) | OpenClaw only |
| `nio.turn.cache_hit_rate` | `cache_read / (input + cache_creation + cache_read)`, 0–1 | turn close | all |

**Token usage source** differs by platform. **Claude Code**: `Stop` reads the transcript JSONL and sums `message.usage` from all assistant entries since turn start. **Hermes**: no usage. The `post_llm_call` payload carries no transcript path (verified by live capture — `extra` holds only `user_message`, `assistant_response`, `conversation_history`, `model`, `platform`), so there is nothing for `parseTranscriptUsage` to read. Token usage on Hermes turn spans is a known gap, not a payload-dependent behaviour. **OpenClaw**: `llm_output` event payload carries usage directly; accumulated incrementally.

### Span: `chat <model>` (LLM call)

One per LLM call within the turn, reconstructed from the platform's
conversation data at turn close (Claude Code / Codex: the session file at
`transcript_path`; Hermes: the raw `post_llm_call` envelope; OpenClaw: the
`llm_output` events the daemon accumulated). Span name is `chat <model>`,
or plain `chat` when the source does not report a model.

| Attribute | Description | Captured at | Platforms |
| --- | --- | --- | --- |
| `gen_ai.operation.name` | Constant `chat` | turn close | all |
| `gen_ai.request.model` | Model the call was issued against, when the source reports one | turn close | all |
| `gen_ai.response.id` | Provider-side call id where available, otherwise a synthesised ordinal | turn close | all |
| `gen_ai.usage.input_tokens` / `output_tokens` / `cache_read.input_tokens` / `cache_creation.input_tokens` | Per-call usage, when the source reports it | turn close | all |
| `gen_ai.response.finish_reasons` | Stop reason for this call | turn close | all |
| `nio.content.thinking_chars` | Character count of this call's thinking blocks (the content itself goes to logs) | turn close | all |
| `nio.content.text_chars` | Character count of this call's text blocks | turn close | all |
| `nio.content.blocks` | Number of content blocks in the call | turn close | all |
| `nio.chat.is_sidechain` | True when the call belongs to a subagent rather than the main thread | turn close | all |
| `nio.chat.timing` | `exact` / `inferred` / `synthetic` — how much `endMs - startMs` can be trusted | turn close | all |

> `nio.chat.timing` is not decoration. Only one platform reports both ends
> of an LLM call; the others infer the end from the next call's start, or
> synthesise both. A consumer that cannot tell them apart reads a
> synthetic zero-duration span as "the model answered instantly".

**Known limitation · Hermes replays its history.** Every `post_llm_call`
payload carries the *entire* `conversation_history`, and each one closes a
turn — so a call that happened three turns ago is reconstructed again into
each later turn's tree. Chat spans and their content records therefore
repeat across a Hermes session. This is deliberate rather than
deduplicated: the earlier calls are what a later turn's tool spans
attribute to (a tool runs in the turn *after* the call that requested it),
so dropping them would orphan the nesting this layer exists for. Dedupe
on `gen_ai.response.id` at query time when counting calls.

### Span: `session` (session root)

One per host session, on its **own trace** — not a parent of the turns.
Ids are minted at `SessionStart` and persisted, so each turn root can
carry a span link to it without waiting for the session to end; the span
itself is emitted at `SessionEnd`. Carries the same
`gen_ai.conversation.id` / `session.id` as the turns, with
`gen_ai.operation.name = session`.

Turns are joined to it by **span link**, not parent/child: a session
outlives any single trace, and nesting hours of turns under one root span
makes every backend's trace view unusable.

**Codex: the session span never goes out.** `startSessionTrace` runs and
mints `session_trace_id`/`session_span_id` on every Codex `SessionStart`
(as of the C1 wiring fix, Codex's `hooks.json` routes `SessionStart` to
`collector-hook.js` alongside `scanner-hook.js`), so turn roots on Codex
do carry a session link like every other platform. But the span itself
is only ever emitted by the `SessionEnd` branch in
`collector-core.ts`'s `dispatchCollectorEvent`, and Codex has no
`SessionEnd`-equivalent hook event (see `src/adapters/codex.ts`'s module
doc). There is also no crash-flush path for it: the orphaned-tree
recovery in `hasOrphanedDeferredTree` / `recoverDeferredTree` covers
`turn_trace_id` + `deferred_spans` only, not `session_trace_id` /
`session_span_id` — a session that starts on Codex simply never gets its
`session` root span exported, on a clean exit or a crash alike. The
session ids still exist in `traces-state-store.json` for as long as the
session runs (and turn-root links to them remain intact), and are
silently discarded by `startSessionTrace`'s `sessionChanged` branch the
next time a *different* session starts on the same machine. If Codex
ever adds a session-boundary hook, wire it to `collector-hook.js` with
`event: 'SessionEnd'` and this paragraph goes away.

**OpenClaw: no session layer at all.** Unlike the other three platforms,
OpenClaw's `session_start` handler in `src/adapters/openclaw-plugin.ts`
never calls `startSessionTrace` — no `session_trace_id` / `session_span_id`
is ever minted, so no `session` root span is ever emitted and no OpenClaw
turn root ever carries a session link. This is not a bug being tracked;
OpenClaw's session boundary is a long-lived daemon lifecycle rather than a
per-process hook pair, and wiring it up was out of scope for the session
span work. `gen_ai.conversation.id` / `session.id` are still present on
every OpenClaw turn span regardless, so session-level aggregation by id
still works — only the dedicated `session` root span and its link are
absent.

**Known gap · a hard crash on Claude Code can leave a dangling session
link.** Once a session starts, its turn roots link to
`(session_trace_id, session_span_id)` immediately (Claude Code and Codex
both mint these at `SessionStart`), but the `session` span itself is only
emitted at `SessionEnd`. If the host process is killed before `SessionEnd`
fires — a hard crash, not a normal exit — the `session` span never goes
out, exactly like the Codex case above, except here it's contingent on a
crash rather than guaranteed. The orphaned-tree recovery in
`hasOrphanedDeferredTree` / `recoverDeferredTree` does not cover this: it
only replays `state.deferred_spans` (parked tool/turn spans), not
`session_trace_id` / `session_span_id`, so a crash with no in-flight tool
activity leaves nothing for it to recover. The result is a turn span
whose session link points at a span id that was never exported — a
dangling link, not a dangling *trace*: the turn's own trace is complete on
its own, and `session.id` / `gen_ai.conversation.id` are already present
directly on every turn span, so nothing that queries or aggregates by
session id needs the `session` span to have gone out. This was previously
assessed as impossible on Claude Code/Codex because the session link
wasn't wired there at all (see the C1 fix referenced above) — that premise
no longer holds now that it is wired, so this paragraph replaces that
earlier assumption rather than leaving it stale.

### Span: `execute_tool <name>` (tool span)

One per tool invocation. Span name is literally `execute_tool ${toolName || 'unknown'}`. Pre-event opens the span; post-event closes it (with retroactive start time on Claude Code/Hermes since the pre-side process is gone).

| Attribute | Description | Captured at | Platforms |
| --- | --- | --- | --- |
| `gen_ai.operation.name` | Constant `execute_tool` | PostToolUse | all |
| `gen_ai.tool.name` | Host tool name (`Bash`, `WebFetch`, …) | PreToolUse · PostToolUse | all |
| `gen_ai.tool.type` | Tool type, when known | PostToolUse | all |
| `gen_ai.tool.call.id` | Host tool-call id (`tool_use_id` on Claude Code, `toolCallId` on OpenClaw) | PreToolUse · PostToolUse | all |
| `gen_ai.tool.call.arguments` | Tool input, redacted, ≤2 KB. **Deferred platforms do not set this** — see the note below | PreToolUse | OpenClaw eager path + guard deny span |
| `gen_ai.tool.call.result` | Tool output, redacted, ≤2 KB. **Deferred platforms do not set this** — see the note below | PostToolUse | OpenClaw eager path |
| `nio.tool.error` | Error message when the tool failed | PostToolUse | all |
| `nio.tool.duration_ms` | Wall-clock tool execution time (ms) — absent on the deny / confirm-denied span (the tool didn't run; use `nio.guard.eval_ms` instead) | PostToolUse | OpenClaw only |
| `nio.tool.run_id` | OpenClaw-internal run identifier | PreToolUse | OpenClaw only |
| `nio.tool_summary` | One-line summary derived from tool input | PostToolUse | all |
| `nio.platform` | Source platform — `claude-code` / `codex` / `hermes` / `openclaw` | PostToolUse | all |
| `nio.turn_number` | Parent turn's number | PostToolUse | all |
| `nio.cwd` | Working dir at hook fire | PostToolUse (when set) | all |
| `nio.guard.decision` | Guard verdict — `allow` / `deny` / `confirm_allowed` / `confirm_denied` | PreToolUse | all |
| `nio.guard.risk_level` | Guard risk level — `low` / `medium` / `high` / `critical` / `unknown` | PreToolUse | all |
| `nio.guard.risk_score` | Guard risk score, 0–1 | PreToolUse | all |
| `nio.guard.risk_tags` | Comma-joined rule IDs that fired | PreToolUse | all |
| `nio.guard.phase_stopped` | Phase that produced the verdict (`0` = tool-gate, `1`–`6` = runtime pipeline) | PreToolUse | all |
| `nio.guard.top_finding_rule` | `rule_id` of the highest-ranked finding (when any fired) | PreToolUse | all |
| `nio.guard.eval_ms` | Wall-clock cost of the guard evaluation (ms) | PreToolUse | all |

**Where tool payloads live on the deferred platforms.** Claude Code,
Codex, and Hermes park finished tool spans in `traces-state-store.json`
until the turn closes, and every hook event rewrites that file whole — so
the tool's arguments and result are deliberately kept off the span there
and carried by the logs signal instead: the arguments as a `tool_input`
content record, the result as a `tool_output` content record, both
emitted at `PostToolUse` (see [Content records](#content-records)). Both
carry the same span id as the span itself, so the join works on the
backend. `nio.tool_summary` stays on the span so a trace list is still
readable without joining anything.

**Span status:** `ERROR` (with `recordException(error)`) when the tool failed or the guard denied / confirm-denied; `OK` otherwise.

**Deny / confirm-denied spans.** When the guard blocks a tool, `PostToolUse` never fires — so the span is emitted synchronously by the same process that ran the guard (the `guard-hook.ts` PreToolUse on Claude Code / Codex; the `hook-cli.ts` `pre_tool_call` branch on Hermes; the `before_tool_call` handler in the OpenClaw plugin). Span name is the same `execute_tool <tool>` as the allow path — the discrimination is on `nio.guard.decision` + ERROR status + the reason in the exception message. Wall-clock starts at the real `evalStartMs` so the span duration reflects the guard window, and `nio.guard.eval_ms` carries the same value as an explicit attribute for filtering.

**Known limitation · concurrent tool-call timing on Hermes only.** When the same tool is invoked multiple times with identical arguments within a single turn, and the `PostToolUse` events complete in a different order than their `PreToolUse` events, the result and duration attributes may be swapped between the calls. Specifically, `nio.tool.duration_ms` and the span's `tool_output` content record may report values from a different physical invocation than the one whose input opened the span. Spans are never lost and the pending-span state always drains cleanly, so the audit log remains consistent and no tracing data is orphaned — the mismatch affects only the pairing of result/duration to input within a single span.

The root cause is Hermes-specific: Claude Code, Codex, and OpenClaw carry a unique `tool_use_id` in both `PreToolUse` and `PostToolUse` payloads, enabling unambiguous span pairing. Hermes provides `tool_use_id` only in the `post_tool_call` hook, not in `pre_tool_call`, forcing the collector to pair spans using a composite key derived from tool name and input digest. When two concurrent calls produce the same composite key and their `PostToolUse` events arrive out-of-order relative to `PreToolUse`, the span-pairing fallback may resolve both to the same pending entry, causing the mismatch. This is a platform limitation (Hermes does not expose the necessary cross-reference), not an Nio implementation defect.

Workaround: make concurrent tool invocations distinguishable by varying the tool input (e.g., add a unique `request_id` or `caller_id` parameter) or by dispatching through separate tool names per caller.

### Span: `task:execute` (task span)

One per subagent dispatch. Opens at `TaskCreated` (Claude Code, Teammates / cloud-agent flows) or `subagent_spawning` (OpenClaw); closes at the matching completion event.

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

Claude Code and Hermes spawn a fresh node process per hook event, so a `PreToolUse` in process A and the matching `PostToolUse` in process B can't share an OTEL `Span` object. Both platforms bridge state via an on-disk cache keyed by session id; pending spans land there at pre-event time and get materialised retroactively at post-event time with the original start timestamp. OpenClaw runs as a single daemon, so the equivalent state lives in an in-memory `Map<sessionId, State>` instead. All three platforms route through the same trace-collector helper functions — span names and attribute keys are identical regardless of where the state was kept.

---

## Logs (audit log)

Audit entries are **dual-written**: OTEL Logs export to `<endpoint>/v1/logs` (when `collector.logs.enabled`) AND a local JSONL file at `collector.logs.path` (when `collector.logs.local`). The JSONL line is the entry verbatim; the OTEL LogRecord uses `body = JSON.stringify(entry)` plus a flat attribute set for indexing.

The logs signal carries two different kinds of record: the **audit
entries** documented below (metadata about what happened, dual-written),
and the **[content records](#content-records)** at the end of this
section (the conversation itself, OTLP only — never written to the local
JSONL). Both are stamped with the trace and span they belong to.

### Entry types (discriminated by `event`)

#### `event: "guard"` — guard decision (per PreToolUse / PostToolUse)

| Field | Type | Notes |
| --- | --- | --- |
| `event` | `"guard"` | discriminator |
| `timestamp` | string | ISO-8601 |
| `platform` | string | `claude-code` / `codex` / `hermes` / `openclaw` |
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
| `nio.platform` | Source platform — `claude-code` / `codex` / `hermes` / `openclaw` | every audit entry | all |
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

Audit LogRecords also carry the **built-in `trace_id` / `span_id`** of the
turn that was active when they were written (the turn root's ids), so an
audit entry can be pulled up next to the trace it belongs to. Entries
written while no turn is open (`SessionStart`, the first event of a
session) carry none rather than claiming an association they don't have.

### Content records

The conversation itself — reasoning, replies, tool arguments, tool
results — travels on the logs signal, not as span attributes. Trace
backends cap attribute length aggressively and a 64 KB reasoning trace has
no business inside a span; the logs signal has no such ceiling, and the
records join back to their span by id.

**These records are OTLP-only.** They are never written to the local
`audit.jsonl`, and they are emitted **only for a session armed with
`/nio-monitor`** (an unarmed session never constructs a logger provider,
so there is nothing to emit through).

- `body` = the content itself: redacted first, then truncated
- `severityNumber` / `severityText` = INFO / `low` — content is not a verdict
- built-in `trace_id` / `span_id` = the span this content belongs to

| Attribute | Description |
| --- | --- |
| `nio.content.type` | `thinking` / `text` / `tool_input` / `tool_output` |
| `nio.content.index` | Position of the source block within its LLM call; `0` for the `PostToolUse`-emitted `tool_input` / `tool_output` records, which have no block sequence |
| `nio.content.fidelity` | `full` / `summary` — only on `thinking`. Follows the model provider, not the platform: Anthropic models return complete reasoning, OpenAI's reasoning series returns step summaries. Do not treat the two as interchangeable |
| `nio.content.truncated` | `true` only when the body was cut |
| `nio.content.original_bytes` | Pre-truncation UTF-8 byte length; only present when truncated |
| `nio.content.redactions` | Number of secrets replaced; only present when at least one was |
| `nio.trace_id` | Redundant plain-string copy of the built-in field |
| `nio.span_id` | Redundant plain-string copy of the built-in field |
| `gen_ai.tool.call.id` | Only on `tool_input` / `tool_output` |

> **Why `nio.trace_id` / `nio.span_id` duplicate the built-in fields.**
> Backends disagree on how they surface OTLP's binary `trace_id` /
> `span_id` after ingestion — some expose `span_id`, some `SpanId`, some
> bury them in structured metadata that isn't queryable like a normal
> attribute. A plain string attribute is the one join key that behaves
> identically everywhere. Removing the copy silently costs some backends
> the ability to join content back to its span.

**When each kind is emitted** — the two differ, because a content record
is worthless without the span id it must carry, and the two span ids
become available at different moments:

| Content | Associated span | Emitted at |
| --- | --- | --- |
| `thinking` · `text` | the `chat` span | **turn close**, in the same batch as the span tree — a chat span id does not exist until `buildSpanTree` mints it |
| `tool_input` (from the call's `tool_use` block) | the `chat` span | **turn close**, as above — requires a `ConversationSource` |
| `tool_input` (from the hook payload) | the `execute_tool` span | **`PostToolUse`**, immediately — the tool span's id was pre-allocated at `PreToolUse` and survives the deferral |
| `tool_output` | the `execute_tool` span | **`PostToolUse`**, immediately — same pre-allocated id |

So a `PostToolUse`-emitted record reaches the backend *before* the span it
names, by up to the remaining length of the turn (longer if the turn had
to be recovered after a crash). The ids match either way; only "log
references a span I haven't seen" alerting needs to allow for it.

**`tool_input` has two producers, on purpose.** Neither subsumes the
other, so they are not deduplicated:

- The **chat-call `tool_use` block** exists only when a
  `ConversationSource` could be built (a readable transcript, or Hermes's
  `post_llm_call` envelope). It is the only producer that covers calls
  which never reach `PostToolUse` — anything the guard denied, and
  interrupted calls.
- The **`PostToolUse` record** needs no source at all, so it is the only
  producer in a degraded session (no `transcript_path`, unreadable
  session file). Without it, losing the chat layer would silently cost
  the arguments too, leaving only `nio.tool_summary`'s 300-char prefix.

Tell them apart — or collapse them — by `nio.span_id`: chat span vs. tool
span, with the same `nio.content.type` and the same
`gen_ai.tool.call.id`. The overlap is a bounded 2x on tool arguments
only; it does not grow with session length.

**Redaction runs before truncation, always.** The reverse order can slice
a credential in half at the cut point, leaving one half of a live secret
in the record with no contiguous match left for the redactor to find.

**Truncation limits** are per content kind, in UTF-8 **bytes**, and cut
only on whole character boundaries:

```yaml
collector:
  content_limits:
    thinking: 65536      # 64 KB
    text: 65536          # 64 KB
    user_prompt: 32768   # 32 KB
    tool_input: 16384    # 16 KB
    tool_output: 32768   # 32 KB
```

Any kind set to `0` is captured without a cap. The caps exist to contain
pathological output (a `cat` of a huge file, a `find /` dump) — normal
reasoning and replies run 2–10 KB and never approach them — because
unbounded content breaks real things downstream: OTLP gRPC's 4 MB
per-message ceiling fails the *entire* export, the hook blocks its host
while it serialises, and backends like Loki reject over-long lines.

`user_prompt` has a limit reserved but no content record yet: the prompt
still rides the turn span as `nio.turn.user_prompt`.

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
    enabled: true                   # OTLP logs export on/off (audit + content records)
    local: true                     # local JSONL backup on/off (audit entries only)
    path: "~/.nio/audit.jsonl"      # audit log + (sibling) traces-state-store.json
    max_size_mb: 100                # rotation threshold for the local file
  content_limits:                   # per-kind UTF-8 byte caps for content records; 0 = uncapped
    thinking: 65536
    text: 65536
    user_prompt: 32768
    tool_input: 16384
    tool_output: 32768
```

Per-signal gating: when `collector.endpoint` is empty, the corresponding provider factory returns `null` and the platform code skips emit. The audit-log local JSONL still works (controlled by `collector.logs.local`) even without an endpoint — handy for offline / air-gapped use.
