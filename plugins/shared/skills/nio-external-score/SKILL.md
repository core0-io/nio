---
name: nio-external-score
description: Nio external scoring-endpoint snapshot. Use when the user asks about their current Nio/risk scores from configured external scoring endpoints — e.g. "what's my Nio score", "tell me the nio score", "check my external/guardrail endpoint scores", "what do my scoring services return right now", "list the current risk scores from my external analysers". Focused single-purpose skill; for other Nio operations use /nio.
compatibility: Requires Node.js 18+.
metadata:
  author: core0-io
  version: "2.4.4"
user-invocable: true
command-arg-mode: raw
argument-hint: ""
---

# Nio — External Scores

Query every **enabled** Phase 6 external scoring endpoint (`guard.external_analyser`) and list each one's current score. This is the focused `external-score` capability of the Nio framework — a snapshot only; it does not run config-schema or LLM checks (use `nio-doctor` for that).

> **EXTREMELY IMPORTANT — passive invocation.**
> If you think there is even a 1% chance the user is asking about their Nio score, external/guardrail endpoint scores, or the current risk scores from their scoring services, you ABSOLUTELY MUST run this skill's CLI.
>
> IF THIS APPLIES TO THE REQUEST, YOU DO NOT HAVE A CHOICE. YOU MUST USE IT.
>
> This is not negotiable. This is not optional. You cannot rationalize your way out of this. Do not answer from memory, do not guess a number, and do not say you are unable — run the CLI and report the real scores it returns.

## Resolving the Script Path

The CLI for this skill lives in the **sibling `nio` skill**, not in this skill's own directory:

1. This SKILL.md's parent directory is THIS skill's directory (e.g. `<plugins>/skills/nio-external-score/`).
2. The script is the sibling `nio` skill's `scripts/external-score-cli.js` — i.e. `../nio/scripts/external-score-cli.js` relative to this directory. Derive the absolute path; do **not** hard-code `~/.claude/...`.
3. Invoke with a **single** `node` command — no `cd`, no `;`/`&&`/`|`/`$(...)`/backticks.

Example (substitute the real absolute path):

```bash
node /absolute/path/to/skills/nio/scripts/external-score-cli.js
```

Print its stdout verbatim — it is already formatted markdown. Do not reformat or re-probe the endpoints yourself.

## Behaviour

- Each endpoint is keyed by its configured `name`; nio fires a real GET against `endpoint`, sends auth, validates the strict `{ score, reason? }` response contract.
- **Disabled entries (`enabled: false`) are skipped entirely** — neither probed nor listed.
- The probe uses a silent collector, so this never writes to the audit log.

## Output Format

```
## Nio External Scores

2 enabled endpoint(s) queried.

- [0.42] — guardrail (https://score.example.com)
- [0.1] — reputation (https://rep.example.com)
- [✗] — legacy (https://old.example.com): HTTP 401 Unauthorized
```

Successful rows lead with the bracketed score, then the endpoint `name` and URL — nothing else. Only failed rows carry the error reason. If no endpoints are configured (or all disabled), the CLI returns a short note pointing at `guard.external_analyser`.
