---
name: nio-monitor
description: Nio telemetry capture switch. Use when the user wants to start or stop collecting telemetry for the current agent session — e.g. "start monitoring this session", "enable nio monitoring", "stop collecting", "is nio monitoring on". Focused single-purpose skill; for other Nio operations use /nio.
compatibility: Requires Node.js 18+.
metadata:
  author: core0-io
  version: "2.5.1"
user-invocable: true
command-arg-mode: raw
argument-hint: "[on|off|status]"
---

# Nio — Monitor

Turn telemetry capture on or off for the **current agent session**.

Nio captures nothing by default. Every session stays silent until it is explicitly armed here. Arming affects all three OTLP signals (metrics, traces, logs); it does **not** affect guard enforcement, which always runs, and does not affect the local audit log at `~/.nio/audit.jsonl`, which is always written.

> **Passive invocation.** If the user asks to start/stop monitoring, enable/disable telemetry, or check whether capture is on, you MUST run the CLI below rather than describing behaviour from memory.

## Resolving the Script Path

The CLI for this skill lives in the **sibling `nio` skill**, not in this skill's own directory:

1. This SKILL.md's parent directory is THIS skill's directory (e.g. `<plugins>/skills/nio-monitor/`).
2. The script is the sibling `nio` skill's `scripts/monitor-cli.js` — i.e. `../nio/scripts/monitor-cli.js` relative to this directory. Derive the absolute path; do **not** hard-code `~/.claude/...`.
3. Invoke with a **single** `node` command — no `cd`, no `;`/`&&`/`|`/`$(...)`/backticks.

## Routing

| Input | Action |
|-------|--------|
| `on`, `start`, or empty | Run `node ../nio/scripts/monitor-cli.js on` |
| `off`, `stop` | Run `node ../nio/scripts/monitor-cli.js off` |
| `status`, `show` | Run `node ../nio/scripts/monitor-cli.js status` |

## Interpreting the Output

The CLI prints JSON.

**`on`** returns `mode`:

- `direct` — the session id was resolved from the environment. Capture begins on the next tool call. Tell the user monitoring is on.
- `pending` — the session id was not available on this platform, so a pending arm was left in place. It is claimed by the next hook event from this directory, within 60 seconds. Tell the user monitoring will begin on their next action, and that it expires in 60s if nothing happens.

**`off`** returns:

- `removed` — `true` if at least one armed session record was deleted, `false` if there was nothing to delete. A live but unclaimed `pending_arm` is always cleared either way, so `removed: false` does **not** mean `off` did nothing.
- `removed_sessions` — how many armed records were deleted.
- `matched_by` — how they were chosen. `session` means the platform exposed a session id and only that one session was disarmed. `cwd` means it did not (Codex, Hermes and OpenClaw are always here), so `off` disarmed **every** session armed from the current directory — which is the only handle those platforms have on their own record, since it was created by a hook event under an id the CLI never sees. Tell the user which happened when `removed_sessions > 1`.

**`status`** returns:

- `monitor_all_sessions` — the global config flag. When `true`, every session is captured regardless of per-session state.
- `session_undetermined` — **read this before `monitored`.** `true` means the platform exposes no session id *and* something is armed, so this session's state genuinely cannot be read from here. Say exactly that; do not report capture as off. Recommend `off` (which disarms by directory) if the user wants it stopped.
- `monitored` — whether the current session is being captured right now, valid only when `session_undetermined` is `false`. It is the same verdict the hooks enforce, so it accounts for the 7-day expiry: a record older than that reads as `false`, because the hooks would reject it too.
- `pending_arm` — an `on` is waiting to bind to a session. It binds on the next hook event from the directory `on` was run in, and expires 60s after it was made.
- `armed_sessions` — how many live (unexpired) sessions are armed in total.
- `session_id` — the session id resolved from the environment, or `null` when the platform does not expose one.

**Reading a pending state.** On any platform where `on` returned `mode: pending` — which is every platform except Claude Code, Codex included — an immediately following `status` reports `monitored: false`, `pending_arm: true`, `armed_sessions: 0`, `session_undetermined: false`. That is not a failure: capture has been requested and has not bound to a session yet, and nothing is armed anywhere, so "not captured" is the honest answer. Tell the user monitoring starts with their next action. Once a hook event claims the arm, the same command reports `monitored: true` on a platform that exposes a session id; on one that does not it reports `pending_arm: false`, `armed_sessions: 1`, `session_undetermined: true` — capture is running, and this surface cannot tie it to this session.

`status` is read-only. Running it never claims a pending arm and never expires a record — it only reports.

## Scope of Capture

When a session is armed, these are exported to the configured OTLP endpoint:

- **traces** — turn / tool-call spans, including the redacted user prompt that opened the turn (`nio.turn.user_prompt`, ≤2 KB) and per-call content-length counters (thinking/text character counts) on each LLM-call span
- **metrics** — tool-use and guard-decision counters
- **logs** — audit records, **plus conversation content**: model reasoning ("thinking"), assistant reply text, tool arguments, and tool output. Each is redacted for secrets and then truncated to a per-kind cap — thinking ≤64 KB, reply text ≤64 KB, tool arguments ≤16 KB, tool output ≤32 KB (configurable via `collector.content_limits`)

When it is not armed, none of the above leave the machine.

**This is the part of arming that matters most for privacy.** Turning monitoring on does not just start a counter — it starts sending what the model reasoned about and what it read/wrote, redacted but otherwise close to verbatim, to wherever `collector.endpoint` points. If that destination isn't fully trusted, treat `/nio-monitor on` accordingly.

## Known Limitation on OpenClaw

OpenClaw runs Nio inside a long-lived daemon rather than a fresh process per event, and OTEL metric counters there are cumulative for the life of that process. The practical consequence:

- A daemon where **no** session has ever been armed exports nothing at all — no exporter is even created.
- Once **any** session in that daemon has been armed and recorded a counter, the metrics exporter starts a periodic export and **keeps re-sending its accumulated counter totals roughly once a second until the daemon restarts** — including after `off`, after the session ends, and after the arm record is deleted.

What `off` does guarantee on OpenClaw is that **no new session data is collected**: no new spans, no new audit records, and no new counter increments. What it cannot do is silence the already-running periodic export of totals accumulated while armed. Restarting the OpenClaw daemon clears it.

Claude Code, Codex and Hermes are unaffected — each hook event is its own process, so nothing outlives it.

## What This Does Not Control

| Behaviour | Affected by this switch? |
|-----------|--------------------------|
| Guard blocking dangerous commands | No — always active |
| Risk scoring (Phase 0–4: pattern matching, static rules, behavioural AST analysis) | No — always active, fully local |
| Phase 5 LLM analyser (sends the content being evaluated to the Anthropic API) | No — gated by its own switch, `guard.llm_analyser.enabled`, **off by default** |
| Phase 6 external analyser (GET-only request to fetch a score; sends no evaluated content) | No — gated by its own switch, `guard.external_analyser` (empty list = off), **off by default** |
| Local `~/.nio/audit.jsonl` | No — always written |
| OTLP export of metrics/traces/logs | **Yes** |

**Phase 5 and Phase 6 are separate outbound paths that this switch does not touch.** Arming or disarming `/nio-monitor` has no effect on either — they are controlled entirely by their own config keys, and both ship disabled.

- **Phase 5** (`guard.llm_analyser`) sends the actual content under evaluation — the command, file, or action being scanned — to the Anthropic API for semantic analysis. It requires both `enabled: true` and an `api_key`; with the shipped defaults (`enabled: false`) it never runs.
- **Phase 6** (`guard.external_analyser`) is different in kind: every request is GET-only and carries no evaluated content in the body — it only fetches a `{score, reason?}` from an endpoint you configured. What it can leak is the fact that this machine is running nio and when a guard evaluation happened, not what was evaluated. It's off by default because the list is empty (`external_analyser: []`); nothing is contacted until you add an endpoint.

If you want to confirm your own machine sends nothing outbound regardless of monitoring state, check `~/.nio/config.yaml` for `guard.llm_analyser.enabled` and `guard.external_analyser` — both absent/false/empty means Phase 5 and Phase 6 are inert.

## Notes

- Capture takes effect from the **next** hook event; the currently executing tool call is not retroactively captured.
- There is no backfill. Anything that happened before `on` is not captured.
- Records expire after 7 days as a backstop. Claude Code, Hermes, and OpenClaw clear the record as soon as the session ends, so the backstop rarely matters there. Codex has no session-end hook to key off, so an armed Codex session relies on the 7-day expiry or a manual `off` — worth knowing if you reuse the same session id across `codex resume` calls.
- To capture every session without arming each one, set `collector.monitor_all_sessions: true` in `~/.nio/config.yaml`.
