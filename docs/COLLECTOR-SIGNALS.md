# Collector Signals — Schema Reference

What Nio captures while an agent runs, organised by OTEL signal. This is the schema-of-record; if reality drifts from this doc, the source is wrong.

Three OTEL signals out — **metrics**, **traces**, **logs**. The audit log (logs signal) is the only one with a local backup; metrics and traces are OTLP-only.

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
| Tool spans nested under the issuing `chat` span | **— (no platform; siblings everywhere — see [Traces](#traces))** | — | — | — | — | — |
| Tool span exported before the turn closes | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `tool_input` / `tool_output` content records | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Token usage on the turn span | ✓ (transcript) | **— (parser is Claude-Code-schema-only)** | ✓ when `transcriptPath` supplied | ✓ (`llm_output`) | ✓ (`message_end`) | ✓ (`message.updated`, de-duplicated to a per-message delta) |
| `nio.turn.user_prompt` | ✓ | ✓ | ✓ | ✓ | ✓ (`input`) | ✓ (`chat.message`) |
| `nio.turn.assistant_reply` | — | — | — | ✓ (`llm_output`) | ✓ (`message_end`) | — |
| `nio.tool.duration_ms` / `nio.tool.run_id` | — | — | — | ✓ | — | — |
| Interactive `confirm` (`guard.confirm_action: ask`) | ✓ `permissionDecision: 'ask'` | ~ same payload emitted, host support unverified | **— falls back to _deny_** | — (folds to allow) | ✓ real `ctx.ui.confirm` dialog | ✓ via `permission.ask` |
| Human-typed shell audited (`lifecycle_type: user_bash`) | — | — | — | — | ✓ (audit only, never blocked) | — |
| All four metric instruments | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Audit log (local JSONL + OTLP logs) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

Five honest caveats:

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
- **opencode's host-injected text is not recorded as assistant text.** A
  `TextPart` flagged `synthetic: true` is text opencode itself put into
  the assistant message (an interruption notice, a re-prompt, a
  compaction stub), not text the model produced. `opencode-source.ts`
  skips it, so it produces no `text` block, no `text` content record, and
  no `nio.content.text_chars`. Recording it would misattribute the
  harness's words to the model — a wrong record rather than an incomplete
  one. Everything the model actually said either side of it is kept.
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
uses: the [content records](#content-records) need a logger provider,
which an unarmed session never builds, and the span attributes that carry
small bodies (`nio.chat.reply`, `gen_ai.tool.call.arguments`) ride the
traces provider, which an unarmed session never builds either.

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
`traces-state-store-<session>.json` — session-scoped durable state versus
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
  ├─ Span: execute_tool <name>   (exported as the tool finishes; joins to its chat call
  │                               by gen_ai.tool.call.id, not by parentage — see below)
  └─ Span: task:execute          (TaskCreated → TaskCompleted, or OpenClaw subagent_spawning → subagent_ended)
```

**Emission timing.** A tool span is exported the moment the tool
finishes, on every platform — `PostToolUse` on Claude Code / Codex,
`post_tool_call` on Hermes, `after_tool_call` / `tool_result` /
`tool.execute.after` on OpenClaw / Pi / opencode — as a direct child of
the turn root. So is the guard's deny / confirm-denied span, for which no
post-side event ever fires. The `chat` layer and the turn root are the
only things that wait for `Stop` / `SubagentStop` / `SessionEnd`, because
they can only be reconstructed from the conversation source once the turn
is over.

This is a deliberate reversal: tool spans used to be parked in
`traces-state-store-<session>.json` so they could be nested under the chat
call that issued them. See [Tool spans are siblings of `chat`](#traces)
below for what that cost and what replaced it.

If the host process dies before the turn closes, the turn root and its
chat layer are lost — the tool spans are already on the backend. A shard
still carrying PARKED spans (written by an older nio, or by
`eagerToolSpans: false`) is flushed by the next event that finds it — or
by the next `SessionStart` — under a root tagged
`nio.turn.incomplete: true`.

**One state file per session.** The store is sharded: the filename
carries the session id, sanitised to `[A-Za-z0-9_-]` and suffixed with a
short digest of the raw id. Two host windows open at once are two
independent sessions, and before sharding they wrote the same file —
which mis-attributed data rather than merely losing it (session A's
`Stop` would close session B's turn, exporting A's conversation content
under B's trace id). The two recovery legs follow from that: a session
finds its OWN parked tree by loading its own shard, and a shard left by a
session whose host never reached `SessionEnd` is claimed by the next
`SessionStart` once it has gone untouched for an hour.

That claim is a **salvage, not a delete**. An hour of silence is not proof
of death — one `Bash` call that runs for two hours, and a window left open
overnight, look identical through mtime — so `takeAbandonedShards` takes
`deferred_spans` and writes the shard back with `turn_trace_id`,
`turn_number`, `pending_spans` and the session-trace ids untouched. A
session that was merely idle keeps an unbroken turn, still closes it at
`Stop`, and still emits its `session` span at `SessionEnd`; the only cost
of guessing wrong is that its already-finished spans went out early under
a detached root tagged `nio.turn.incomplete`. Deleting the shard is a
separate leg on a separate clock: a week untouched, at which point nothing
in it can belong to a running host. Shards of sessions that end cleanly
are deleted immediately at `SessionEnd`.

Since tool spans became eager, `deferred_spans` is empty on every shard
the current code writes, so the salvage leg's normal outcome is now
"leave the shard completely alone" — there is nothing parked to flush and
no detached `nio.turn.incomplete` root is produced. It still fires for a
shard written by an older nio or by `eagerToolSpans: false`, which is the
case `state-store-idle-session.test.ts` constructs.

Recovered trees keep the DEAD session's identity, not the recovering
one's. `nio.platform` / `service.name` / `gen_ai.agent.name` live on the
OTEL Resource, so the shard records the platform and agent name that wrote
it and the sweep builds a short-lived provider from them when they differ
— all four platforms share `$NIO_HOME` by default, and Claude Code and
Codex are the same scripts behind a different `--platform` flag.

A pre-upgrade `traces-state-store.json` is adopted once, by the session
recorded inside it, so a tool call spanning the upgrade keeps its
pre/post bridge.

**Without a conversation source** (no transcript path, an unreadable
session file, a platform whose conversation data never reached the
collector) the chat layer is skipped entirely and every tool span hangs
off the turn — the pre-chat-layer shape, degraded but never broken. The
tool's arguments and result still reach the backend either way: both go
out as content records associated with the tool span, which needs no
source (see [Content records](#content-records)). The hook platforms emit
them at `PostToolUse`; the in-process platforms emit the arguments when
the tool span opens and the result when it closes. The span-side copy of
the arguments is unaffected too: `gen_ai.tool.call.arguments` comes off
the live tool payload, not off the conversation source. What is lost
without a source is the `chat` layer itself — the model's words, its
token usage and its finish reasons.

**Tool spans are siblings of `chat`, on every platform**

| Platform | Tool span parent | Emitted at |
| --- | --- | --- |
| Claude Code | the turn root — sibling of `chat` | `PostToolUse` |
| Codex | the turn root — sibling of `chat` | `PostToolUse` |
| Hermes | the turn root — sibling of `chat` | `post_tool_call` |
| OpenClaw | the turn root — sibling of `chat` | `after_tool_call` |
| Pi | the turn root — sibling of `chat` | `tool_result` |
| opencode | the turn root — sibling of `chat` | `tool.execute.after` |

There used to be an OpenClaw exception here, in the other direction:
every other platform nested its tool spans under the `chat` call that
issued them, and OpenClaw could not because neither of `buildSpanTree`'s
attribution channels exists there (`createOpenClawSource` emits no
`tool_use` block, and all its calls are `timing: 'synthetic'`, which the
time-window fallback skips by design). The exception is gone because the
nesting is gone.

**Why the nesting was given up.** A tool span can only be attributed to
the call that issued it once the turn's conversation has been
reconstructed, and that does not happen until the turn closes. Nesting
therefore requires holding every finished tool span until then. It
worked — verified live, `execute_tool Bash` under a `chat` parent — and
it was still the wrong trade:

- **A long turn showed nothing at all.** Measured on a live session: a
  turn ran for seven minutes with 38 finished tool spans parked in its
  `traces-state-store-<session>.json` shard (`deferred: 38`,
  `pending: 0`), while the newest span the backend held still belonged to
  the previous turn. An agent is least observable exactly when it is
  doing the most.
- **A crash in that window left nothing to reconstruct.** Not a truncated
  tree — no record of how far the agent got. Nothing re-sends a live
  turn's parked spans either: the salvage path
  (`hasOrphanedDeferredTree`) only adopts a shard whose turn is already
  closed. A guard tool earns its keep at a crash scene, and deferral
  removed the crash scene.

**What replaced it.** The issuing call survives as DATA rather than as
tree structure. `gen_ai.tool.call.id` is on every tool span, carrying the
same id the chat call's `tool_use` block carries, so a backend can join
a tool to the call that made it — it is a join instead of a parent edge.
The `chat` layer itself is unchanged: chat spans are still reconstructed
from the conversation source at turn close and still hang off the turn
root. Only the tool → chat edge was dropped.

The time-window and id channels in `buildSpanTree` are still there and
still used for anything that IS parked (see below), but they no longer
decide a normal tool span's parent, because a normal tool span is gone
before they run.

**The deferral path still exists, dormant.** `PluginRuntimeOptions.eagerToolSpans`
defaults to `true` everywhere; `false` selects parking and is used only
to keep the machinery under test. `deferred_spans` is kept for three
reasons: it is the structure the crash-salvage in `traces-state-store.ts`
reads and writes, shards written by an older nio still carry it, and a
turn boundary still reclaims any span whose post-side event never arrived
(opencode's normal path for a tool that threw — `tool.execute.after` is
not delivered in that case). A reclaimed span is routed exactly like a
normal close: onto the turn root, marked `nio.span.reclaimed`.

**Pinned by**
`src/tests/eager-tool-spans.test.ts` — a 40-tool turn whose spans are all
asserted on the wire *before* any turn boundary is dispatched, against a
real OTLP sink, with the state shard asserted empty at the same moment.
Reverting `collector-core.ts` to `deferPostToolUse` turns it red.
`src/tests/openclaw-span-hierarchy.test.ts` and
`src/tests/pi-opencode-span-hierarchy.test.ts` pin the sibling parentage
and the surviving `gen_ai.tool.call.id` on the real bindings; each states
the parentage as an equality against the turn root *and* an inequality
against the chat span, so a regression to parking fails both ways round.

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

**Token usage source** differs by platform, and applies to the **turn** span. **Claude Code**: `Stop` reads the transcript JSONL and sums `message.usage` from all assistant entries since turn start. **Codex**: none — `parseTranscriptUsage` matches only Claude-Code-shaped transcript entries (`type: "assistant"` plus `message.usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`), and Codex's rollout JSONL uses different event types and a different shape, so it returns null. Codex usage is not lost, though — `createCodexSource` reads `last_token_usage` off the rollout, so it lands on the **chat call** spans instead. **Hermes**: none. There is no transcript file at all: the `post_llm_call` payload carries no transcript path (verified by live capture — `extra` holds only `user_message`, `assistant_response`, `conversation_history`, `model`, `platform`), so `parseTranscriptUsage` has nothing to read, and the history it *does* carry has no token counts. A known gap, not a payload-dependent behaviour. **OpenClaw**: `llm_output` event payload carries usage directly; accumulated incrementally. **Pi**: `message_end` carries `message.usage` once per assistant message; accumulated the same way. **opencode**: `message.updated` carries a *cumulative snapshot* republished on every change to the same message, so the binding tracks last-seen totals per message id and accumulates only the delta — otherwise a re-publish would compound the turn's totals.

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
| `nio.chat.reply` | What the model said: this call's `text` blocks joined in order, redacted, ≤2 KB. Absent when the call said nothing. See [Content records](#content-records) for when a reply is instead (or also) a log record | turn close | all |
| `nio.content.truncated` | `true` when `nio.chat.reply` did not fit the 2 KB budget — the full body is then in a `text` content record | turn close | all |
| `nio.content.original_bytes` | Pre-truncation UTF-8 byte length of the reply; only present when truncated | turn close | all |
| `nio.content.redactions` | Number of secrets replaced in the reply; only present when at least one was | turn close | all |

> `nio.chat.timing` is not decoration — how much of it is measured varies
> by platform:
>
> | Value | Where it comes from | Meaning |
> | --- | --- | --- |
> | `exact` | Codex (`task_complete`'s `started_at` / `completed_at`); opencode (`time.created` + `time.completed` on the assistant message) | both ends are platform-reported |
> | `inferred` | Claude Code and Pi, for every call that has a successor | start is real, end is borrowed from the next call's start |
> | `synthetic` | OpenClaw (no event carries a timestamp); Hermes (one `Date.now()` for a whole replayed payload); Claude Code's last call in a batch, which has no successor to borrow from | the duration is fabricated |
>
> `exact` used to be Codex's alone; opencode is the second platform to
> reach it (and drops to `inferred` for a message still streaming, which
> has a `created` but no `completed`).
>
> A consumer that cannot tell them apart reads a synthetic zero-duration
> span as "the model answered instantly". That is the whole of what this
> attribute is for now. It used to have a second job — `buildSpanTree`
> enabled its time-window attribution channel only for a call whose
> timing was not `synthetic` — but neither that channel nor the
> `tool_use`-id channel decides a tool span's parent any more: tool spans
> are exported at their post-side event, long before any of this is
> reconstructed, and hang off the turn root. `gen_ai.tool.call.id` is the
> surviving link between a tool and the call that issued it. Both
> channels still run, for whatever a turn boundary finds parked (see
> [Tool spans are siblings of `chat`](#traces)).

**Known limitation · Hermes replays its history.** Every `post_llm_call`
payload carries the *entire* `conversation_history`, and each one closes a
turn — so a call that happened three turns ago is reconstructed again into
each later turn's tree. Chat spans and their content records therefore
repeat across a Hermes session. This is deliberate rather than
deduplicated: the earlier calls are what a later turn's tool spans
attribute to (a tool runs in the turn *after* the call that requested it),
so dropping them would lose the chat spans a later turn's tool calls join
back to on `gen_ai.tool.call.id`. Dedupe on `gen_ai.response.id` at query
time when counting calls.

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
session ids still exist in the session's `traces-state-store` shard for as long as the
session runs (and turn-root links to them remain intact). Post-sharding a
different session never loads this session's state, so nothing discards
them early either: the shard is left alone by the 1-hour salvage leg —
which takes `deferred_spans` and nothing else — and is finally removed by
`takeAbandonedShards`' GC leg once it has gone a week untouched. If Codex
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
| `gen_ai.tool.call.id` | Host tool-call id (`tool_use_id` on Claude Code, `toolCallId` on OpenClaw / Pi, `callID` on opencode) | PreToolUse · PostToolUse | all |
| `gen_ai.tool.call.arguments` | Tool input, redacted, ≤2 KB | PreToolUse (in-process) · PostToolUse (hook platforms) | all — see the note below |
| `nio.content.truncated` | `true` when the arguments did not fit the 2 KB budget — the full body is then in a `tool_input` content record | PostToolUse | hook platforms (Claude Code / Codex / Hermes) |
| `nio.content.original_bytes` | Pre-truncation UTF-8 byte length of the arguments; only present when truncated | PostToolUse | hook platforms |
| `nio.content.redactions` | Number of secrets replaced in the arguments; only present when at least one was | PostToolUse | hook platforms |
| `gen_ai.tool.call.result` | Tool output, redacted, ≤2 KB. **The hook platforms do not set this** — see the note below | PostToolUse | in-process platforms (OpenClaw / Pi / opencode) |
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

**Where tool payloads live.** Nothing bulky is written into
`traces-state-store-<session>.json`: every hook event rewrites that file
whole, so a payload parked in it is paid for on every subsequent event.

- **Arguments** ride on the span, capped at the 2 KB budget. They are
  taken from the live tool payload at the moment the span is emitted —
  `tool_input` from the hook stdin on Claude Code / Codex / Hermes, the
  handler's `params` on OpenClaw / Pi / opencode — and go straight from
  there to the exporter without a stop on disk. No conversation source is
  involved, so a session without one keeps them.
- **Results** stay off the span on the hook platforms and travel as a
  `tool_output` content record emitted at `PostToolUse` (see
  [Content records](#content-records)). Measured p90 is 7.7 KB and max
  32 KB — the payload the span budget exists to keep out of trace
  queries.

Content records carry the same span id as the span itself, so the join
works on the backend. `nio.tool_summary` stays on the span so a trace list
is still readable without joining anything.

> **Known overlap.** The arguments appear up to three times on a session
> that has a conversation source: as `gen_ai.tool.call.arguments` on the
> tool span, as the source-free `tool_input` record `PostToolUse` emits,
> and inside the `tool_use` block of the chat call's own content record.
> All three derive from the same payload and cannot disagree; the span
> copy is capped at 2 KB while the records are full-fidelity. Collapse on
> `gen_ai.tool.call.id` when counting.

**Span status:** `ERROR` (with `recordException(error)`) when the tool failed or the guard denied / confirm-denied. Otherwise the status is left at the OTel default, `UNSET` — Nio never calls `setStatus(OK)`, and most backends render `UNSET` as "ok". A **reclaimed** span (`nio.span.reclaimed=true`) is also `UNSET`, but that does *not* mean it succeeded: its outcome is genuinely unknown. Treat `UNSET` as success only for spans without the reclaim marker.

**Deny / confirm-denied spans.** When the guard blocks a tool, `PostToolUse` never fires — so the span is emitted synchronously by the same process that ran the guard (the `guard-hook.ts` PreToolUse on Claude Code / Codex; the `hook-cli.ts` `pre_tool_call` branch on Hermes; `InProcessPluginRuntime.onPreTool`'s block path for OpenClaw / Pi / opencode, reached from `before_tool_call` / `tool_call` / `tool.execute.before` respectively — and, on Pi, also from `resolveConfirm` when the human declines the dialog). Span name is the same `execute_tool <tool>` as the allow path — the discrimination is on `nio.guard.decision` + ERROR status + the reason in the exception message. Wall-clock starts at the real `evalStartMs` so the span duration reflects the guard window, and `nio.guard.eval_ms` carries the same value as an explicit attribute for filtering.

**Known limitation · concurrent tool-call timing on Hermes only.** When the same tool is invoked multiple times with identical arguments within a single turn, and the `PostToolUse` events complete in a different order than their `PreToolUse` events, the result and duration attributes may be swapped between the calls. Specifically, `nio.tool.duration_ms` and the span's `tool_output` content record may report values from a different physical invocation than the one whose input opened the span. Spans are never lost and the pending-span state always drains cleanly, so the audit log remains consistent and no tracing data is orphaned — the mismatch affects only the pairing of result/duration to input within a single span.

The root cause is Hermes-specific: Claude Code, Codex, and OpenClaw carry a unique `tool_use_id` in both `PreToolUse` and `PostToolUse` payloads, enabling unambiguous span pairing. Hermes provides `tool_use_id` only in the `post_tool_call` hook, not in `pre_tool_call`, forcing the collector to pair spans using a composite key derived from tool name and input digest. When two concurrent calls produce the same composite key and their `PostToolUse` events arrive out-of-order relative to `PreToolUse`, the span-pairing fallback may resolve both to the same pending entry, causing the mismatch. This is a platform limitation (Hermes does not expose the necessary cross-reference), not an Nio implementation defect.

Workaround: make concurrent tool invocations distinguishable by varying the tool input (e.g., add a unique `request_id` or `caller_id` parameter) or by dispatching through separate tool names per caller.

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
| `nio.risk_level` | Nio risk level of the entry — same values, but present on **any** entry carrying one, including a `session_scan` entry that has a risk level and no guard decision. Absent when the entry has none. Not a log level — see the severity note above | guard decision · session scan | all |
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

Audit LogRecords also carry the **built-in `trace_id` / `span_id`** of the
turn that was active when they were written (the turn root's ids), so an
audit entry can be pulled up next to the trace it belongs to. Entries
written while no turn is open (`SessionStart`, the first event of a
session) carry none rather than claiming an association they don't have.

### Content records

The conversation itself — reasoning, replies, tool arguments, tool
results — is split between the **traces** and the **logs** signal
**by size**, not by kind. Small bodies ride on the span so a trace is
readable on its own; large ones stay in the logs signal, where there is
no attribute ceiling and no cost to a trace query, and join back to their
span by id.

#### The size rule

The budget is **2 KB of UTF-8 per span attribute**
(`SPAN_CONTENT_LIMIT`, `src/scripts/lib/content/span-content.ts`).

| Content | Span side | Logs side |
| --- | --- | --- |
| Assistant reply (`text`) | `nio.chat.reply` on the `chat` span — all `text` blocks of the call joined in order | a `text` record **only** when the reply exceeded the budget |
| Tool arguments (`tool_input`) | `gen_ai.tool.call.arguments` on the `execute_tool` span | a `tool_input` record when the arguments exceeded the budget, when the tool call never produced a span (guard-denied / interrupted), or from the source-free `PostToolUse` producer (see below) |
| Tool result (`tool_output`) | never | always a `tool_output` record |
| Reasoning (`thinking`) | never | always a `thinking` record |

**One body, one owner.** A body is never on the wire twice. If the span
attribute is present and `nio.content.truncated` is **absent**, the span
holds the whole thing and no log record was emitted for it. If
`nio.content.truncated` is `true`, the span holds a preview and the log
record — full fidelity, up to the configured per-kind limit — is
authoritative. That is the whole consumer-side rule:

> read the span attribute; join the logs only when
> `nio.content.truncated` is set, or when the attribute is missing.

**Where the split comes from.** Measured live against SigNoz on
2026-08-06, in UTF-8 bytes per record:

| type | n | avg | p50 | p90 | max | >2 KB | >8 KB |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `text` | 16 | 170 | 150 | 294 | 360 | 0 | 0 |
| `tool_input` | 137 | 764 | 248 | 2133 | 8171 | 14 | 0 |
| `tool_output` | 116 | 2267 | 371 | 7748 | 32768 | 27 | 10 |
| `thinking` | 21 | 0 | 0 | 0 | 0 | 0 | 0 |

Replies topped out at 360 bytes, so forcing a log join to read what the
model said bought nothing. Tool results reached the 32 KB cap and would
be paid for on every trace query. `thinking` measured zero only because
that host wrote its blocks empty (see the note further down) — on
platforms that do populate it, reasoning is the largest payload of all,
so it is treated like `tool_output`.

**Limitations of that sample — read before re-tuning the budget.** It was
collected *before* the exporter's concurrency limit was fixed, so every
export past the 30th in a turn was silently dropped. The drop was by
**arrival order, not by size**, so the shape of the distribution is
unbiased — but `n` is small, and these are counts of survivors, not of
what was produced. The 2 KB budget is therefore chosen on principle (it
is the same `MAX_ATTR_BYTES` every other nio span attribute already obeys,
and a conservative single-attribute ceiling across backends) and merely
*checked* against the sample, where it lands at the `tool_input` knee
(p90 = 2133). Do not re-derive it from these percentiles.

**Redaction runs before truncation, on both sides.** Both the span copy
and the log record go through the same `redactSecrets` → `truncateContent`
pipeline, in that order. Reversed, a secret straddling the cut point would
be sliced in half and the redactor — which matches contiguous text — would
never see it, leaving half a live credential on the wire.

**These records are OTLP-only.** They are never written to the local
`audit.jsonl`, and they are emitted **only for a session armed with
`/nio-monitor`** (an unarmed session never constructs a logger provider,
so there is nothing to emit through).

- `body` = the content itself: redacted first, then truncated
- `severityNumber` / `severityText` = `9` / `INFO` — content is not a verdict, so it carries no risk level and no `nio.risk_level` attribute
- built-in `trace_id` / `span_id` = the span this content belongs to

| Attribute | Description |
| --- | --- |
| `nio.content.type` | `thinking` / `text` / `tool_input` / `tool_output` |
| `nio.content.index` | Position of the source block within its LLM call; `0` for the out-of-band `tool_input` / `tool_output` records, which have no block sequence |
| `nio.content.fidelity` | `full` / `summary` — only on `thinking`. Follows the model provider, not the platform: Anthropic models return complete reasoning, OpenAI's reasoning series returns step summaries. Do not treat the two as interchangeable |
| `nio.content.truncated` | `true` only when the body was cut |
| `nio.content.original_bytes` | Pre-truncation UTF-8 byte length; only present when truncated |
| `nio.content.redactions` | Number of secrets replaced; only present when at least one was |
| `nio.trace_id` | Redundant plain-string copy of the built-in field |
| `nio.span_id` | Redundant plain-string copy of the built-in field |
| `gen_ai.tool.call.id` | Only on `tool_input` / `tool_output` |

**A record is never emitted with an empty body.** Emptiness is judged on
the final body — after redaction, after truncation — and applies to every
`nio.content.type`, since an empty body carries no information under any
of them. A body that redaction reduced to `[REDACTED]`, or that
truncation reduced to the truncation marker, is *not* empty and is still
emitted: both still say something happened.

> **Observed: no `thinking` records from Claude Code.** In one session
> sampled on 2026-08-06, all 382 `thinking` blocks in the transcript had
> `thinking: ""` with only `signature` populated, so — with the rule above
> — that session produced no `thinking` content records at all (before the
> rule, it produced 21 records with an empty body and
> `nio.content.fidelity = 'full'`, which read as "the model reasoned, and
> its reasoning was blank"). This is what the host wrote to its
> transcript, not something nio drops: nio reads the field the host
> provides. Treat it as one measurement, not as a property of the
> platform — what a transcript carries can vary by model and by thinking
> level, and this repo has already been wrong in this exact way once
> (Codex was recorded as having no thinking text on the strength of an
> `effort=medium` sample; `effort=high` produced it). If you need to know
> whether reasoning is being captured on a given setup, measure that
> setup.

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
| `thinking` | the `chat` span | **turn close**, in the same batch as the span tree — a chat span id does not exist until `buildSpanTree` mints it |
| `text` | the `chat` span | **turn close**, as above — and *only* when the reply exceeded the 2 KB span budget; otherwise it is `nio.chat.reply` on the span and no record is emitted |
| `tool_input` (from the call's `tool_use` block) | the `chat` span | **turn close**, as above — requires a `ConversationSource`, and only when the tool span could not carry the arguments (no exact `tool_use_id` match, or over budget) |
| `tool_input` (out of band) | the `execute_tool` span | Claude Code / Codex / Hermes: **`PostToolUse`**. OpenClaw / Pi / opencode: **when the tool span opens** — the runtime has the params on the pre-side and an outcome, not params, on the post-side. Either way the tool span's id was pre-allocated at `PreToolUse` and survives the deferral |
| `tool_output` | the `execute_tool` span | **when the tool call finishes** (`PostToolUse` on the hook platforms, `onPostTool` on the in-process ones) — same pre-allocated id |

So an out-of-band record reaches the backend *before* the span it names,
by up to the remaining length of the turn (longer if the turn had to be
recovered after a crash). The ids match either way; only "log references
a span I haven't seen" alerting needs to allow for it.

Emitting the in-process family's `tool_input` on the **pre** side is what
puts a guard-denied call's arguments on the wire there: the call never
runs, so no post-side event fires, and on a streaming platform there may
be no assistant message announcing it either. Pinned by
`content-wiring.test.ts`'s "emits tool_input on a call the guard DENIED"
case.

**`tool_input` has two producers, on purpose.** Neither subsumes the
other, so they are not deduplicated:

- The **chat-call `tool_use` block** exists only when a
  `ConversationSource` could be built (a readable transcript, Hermes's
  `post_llm_call` envelope, opencode's accumulated parts). On the hook
  platforms it is also the only producer that covers calls which never
  reach `PostToolUse` — anything the guard denied, and interrupted calls.
  It never carries a tool *result*: no `ContentBlock` has a field for one.
- The **out-of-band record** needs no source at all, so it is the only
  producer in a degraded session (no `transcript_path`, unreadable
  session file, a streaming platform whose events never arrived). Without
  it, losing the chat layer would silently cost the arguments too,
  leaving only `nio.tool_summary`'s 300-char prefix.

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
    path: "~/.nio/audit.jsonl"      # audit log + (sibling) traces-state-store-<session>.json
    max_size_mb: 100                # rotation threshold for the local file
  content_limits:                   # per-kind UTF-8 byte caps for content records; 0 = uncapped
    thinking: 65536
    text: 65536
    user_prompt: 32768
    tool_input: 16384
    tool_output: 32768
```

Per-signal gating: when `collector.endpoint` is empty, the corresponding provider factory returns `null` and the platform code skips emit. The audit-log local JSONL still works (controlled by `collector.logs.local`) even without an endpoint — handy for offline / air-gapped use.
