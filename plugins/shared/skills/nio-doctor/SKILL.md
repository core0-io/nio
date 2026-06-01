---
name: nio-doctor
description: Nio config validator + connectivity check. Use when the user wants to validate their Nio setup — e.g. "run nio doctor", "is my nio config valid / working", "test my OAuth / external endpoint / LLM connectivity", "why isn't my scorer firing". Focused single-purpose skill; for other Nio operations use /nio.
compatibility: Requires Node.js 18+.
metadata:
  author: core0-io
  version: "2.4.4"
user-invocable: true
command-arg-mode: raw
argument-hint: ""
---

# Nio — Doctor

Validate the current configuration end-to-end. Doctor catches issues *before* they cause silent failures during real tool calls. This is the focused `doctor` capability of the Nio framework.

> **Passive invocation.** If the user asks whether their Nio setup/config is valid or working, to test OAuth/LLM/external-endpoint connectivity, or why a scorer isn't firing, you MUST run the CLI below rather than reasoning about it from memory.

## Resolving the Script Path

The CLI for this skill lives in the **sibling `nio` skill**, not in this skill's own directory:

1. This SKILL.md's parent directory is THIS skill's directory (e.g. `<plugins>/skills/nio-doctor/`).
2. The script is the sibling `nio` skill's `scripts/doctor-cli.js` — i.e. `../nio/scripts/doctor-cli.js` relative to this directory. Derive the absolute path; do **not** hard-code `~/.claude/...`.
3. Invoke with a **single** `node` command — no `cd`, no `;`/`&&`/`|`/`$(...)`/backticks.

Example (substitute the real absolute path):

```bash
node /absolute/path/to/skills/nio/scripts/doctor-cli.js
```

Print its stdout verbatim — it is already formatted markdown.

## What Doctor Checks

1. **Configuration** — re-runs schema validation against the live `~/.nio/config.yaml`, flagging any field with a path + message.
2. **External analysers** — fires each enabled `guard.external_analyser` endpoint (OAuth entries do a real `client_credentials` grant) and reports ✓ with the returned score or ✗ with the underlying error + a `hint:` line.
3. **LLM analyser** — flags `guard.llm_analyser.enabled=true` paired with an empty `api_key`.

Collector reachability is intentionally **not** probed (OTLP gateways often need routing headers a bare probe wouldn't send). Doctor never writes to the audit log — its probes use a scoped collector discarded after the command returns.

## Output Format

A markdown checklist with ✓ / ✗ per check and inline `hint:` lines, e.g.:

```
## Nio Doctor

### Configuration
- ✓ ~/.nio/config.yaml loaded successfully

### External Analysers (1 configured)
- ✓ guardrail (https://score.example.com) — score 0.42 [oauth]
```
