---
name: nio-report
description: Nio execution audit report. Use when the user wants to review recent agent execution activity — e.g. "show my nio report", "what did nio block recently", "show the audit log / recent activity", "any diagnostics / errors in nio". Read-only. Focused single-purpose skill; for other Nio operations use /nio.
compatibility: Requires Node.js 18+.
metadata:
  author: core0-io
  version: "2.5.1"
user-invocable: true
command-arg-mode: raw
argument-hint: ""
---

# Nio — Execution Report

Display recent agent execution events from the Nio audit log. This is the focused `report` capability of the Nio framework.

> **Passive invocation.** If the user asks what Nio blocked/confirmed recently, to see the audit log / recent activity, or for a diagnostics summary, you MUST read and format the audit log as below.

**This skill uses the Read tool only — there is no script to run.** Do not attempt to invoke any `report.js` / `report-cli.js` — none exist. The only action is: read `~/.nio/audit.jsonl` with the Read tool, parse each line as JSON, and format the output as shown below.

## Log Location

The audit log is stored at `~/.nio/audit.jsonl` (or `$NIO_HOME/audit.jsonl`). Each line is a JSON object with an `event` discriminator field: `guard` (one per tool-call evaluation), `session_scan`, `lifecycle`, `diagnostic`.

A `diagnostic` entry carries `source` (one of `config`, `oauth`, `llm`, `external_analyser`, `collector`, `scanner`, `hook`), `kind`, `severity`, `component`, `message`, optional `hint`. Aggregate diagnostics by `(source, kind, component, config_path)` into a Diagnostics summary section.

**Count occurrences as `suppressed_count ?? 1` per entry — never by counting lines.** A repeated diagnostic is written once and then collapsed for 60 s; when that window closes, one entry carrying `suppressed_count` and `window_started_at` stands for the repeats it swallowed, and NOT for itself. Counting lines under-reports a flood by orders of magnitude — a real 34 689-occurrence export failure occupies 12 lines. Report the occurrence count, and use `window_started_at` → `timestamp` to state how long the fault ran.

Old-format lines (no `event` field) are guard entries with `event_type: "pre"`.

## How to Display

1. Read `~/.nio/audit.jsonl` using the Read tool
2. Parse each line as JSON
3. Filter by `event` type — guard entries in the main table, scan entries in a separate section
4. Show recent events (last 50 by default)
5. If any events have `initiating_skill`, add a "Skill Activity" section grouping events by skill

## Output Format

```
## Nio Execution Report

**Events**: <total count>
**Blocked**: <deny count>
**Confirmed**: <confirm count>

### Recent Events

| Time | Tool | Type | Decision | Risk | Score | Phase | Top Finding | Skill |
|------|------|------|----------|------|-------|-------|-------------|-------|
| 14:30 | Bash | exec | DENY | critical | 0.95 | 2 | DANGEROUS_COMMAND | some-skill |

### Diagnostics

| Count | Source | Kind | Component |
|-------|--------|------|-----------|
| 2 | oauth | token_failed | scorer_primary |

### Summary
<Brief analysis of agent execution behaviour and any patterns of concern>
```

If the log file doesn't exist, inform the user that no execution events have been recorded yet, and suggest enabling hooks via `./setup.sh` or by adding the plugin.
