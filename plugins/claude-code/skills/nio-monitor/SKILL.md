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

**`off`** returns `removed`: `true` if a session was armed and is now disarmed, `false` if nothing was armed.

**`status`** returns:

- `monitor_all_sessions` — the global config flag. When `true`, every session is captured regardless of per-session state.
- `monitored` — whether the current session is being captured right now. This is the same verdict the hooks enforce, so it accounts for the 7-day expiry: a record older than that reads as `false`, because the hooks would reject it too.
- `pending_arm` — an `on` is waiting to bind to a session. It binds on the next hook event from the directory `on` was run in, and expires 60s after it was made.
- `armed_sessions` — how many live (unexpired) sessions are armed in total.
- `session_id` — the session id resolved from the environment, or `null` when the platform does not expose one.

**Reading a pending state.** On any platform where `on` returned `mode: pending` — which is every platform except Claude Code, Codex included — an immediately following `status` reports `monitored: false`, `pending_arm: true`, `armed_sessions: 0`. That is not a failure: capture has been requested and has not bound to a session yet. Tell the user monitoring starts with their next action. Once a hook event claims the arm, the same command reports `monitored: true` (when the platform exposes a session id) or simply `pending_arm: false` with `armed_sessions: 1`.

`status` is read-only. Running it never claims a pending arm and never expires a record — it only reports.

## Scope of Capture

When a session is armed, these are exported to the configured OTLP endpoint:

- **traces** — turn / tool-call spans
- **metrics** — tool-use and guard-decision counters
- **logs** — audit records

When it is not armed, none of the three leave the machine.

## What This Does Not Control

| Behaviour | Affected by this switch? |
|-----------|--------------------------|
| Guard blocking dangerous commands | No — always active |
| Risk scoring (Phase 0–6) | No — always active |
| Local `~/.nio/audit.jsonl` | No — always written |
| OTLP export of metrics/traces/logs | **Yes** |

## Notes

- Capture takes effect from the **next** hook event; the currently executing tool call is not retroactively captured.
- There is no backfill. Anything that happened before `on` is not captured.
- Records expire after 7 days as a backstop. Claude Code, Hermes, and OpenClaw clear the record as soon as the session ends, so the backstop rarely matters there. Codex has no session-end hook to key off, so an armed Codex session relies on the 7-day expiry or a manual `off` — worth knowing if you reuse the same session id across `codex resume` calls.
- To capture every session without arming each one, set `collector.monitor_all_sessions: true` in `~/.nio/config.yaml`.
