---
name: nio-config
description: Nio configuration viewer/editor. Use when the user wants to view or change Nio settings — e.g. "show my nio config", "set nio to strict/balanced/permissive", "what protection level am I on", "reset nio config". Focused single-purpose skill; for other Nio operations use /nio.
compatibility: Requires Node.js 18+.
metadata:
  author: core0-io
  version: "2.5.0"
user-invocable: true
command-arg-mode: raw
argument-hint: "[show|strict|balanced|permissive|reset]"
---

# Nio — Configuration

View or update the Nio configuration. This is the focused `config` capability of the Nio framework. Configuration lives at `~/.nio/config.yaml` (or `$NIO_HOME/config.yaml`).

> **Passive invocation.** If the user asks to see their Nio config, check/change the protection level, or reset config, you MUST use the CLI below rather than describing settings from memory.

## Resolving the Script Path

The CLI for this skill lives in the **sibling `nio` skill**, not in this skill's own directory:

1. This SKILL.md's parent directory is THIS skill's directory (e.g. `<plugins>/skills/nio-config/`).
2. The script is the sibling `nio` skill's `scripts/config-cli.js` — i.e. `../nio/scripts/config-cli.js` relative to this directory. Derive the absolute path; do **not** hard-code `~/.claude/...`.
3. Invoke with a **single** `node` command — no `cd`, no `;`/`&&`/`|`/`$(...)`/backticks.

## Routing

| Input | Action |
|-------|--------|
| `config`, `show`, or empty | Run `node ../nio/scripts/config-cli.js show` and present the JSON |
| `strict` / `balanced` / `permissive` | Read `~/.nio/config.yaml`, update only `guard.protection_level` (preserve all other settings), write back, confirm to the user |
| `reset` | Run `node ../nio/scripts/config-cli.js reset` |

## Protection Levels

| Level | allow | confirm | deny | Behaviour |
|-------|-------|---------|------|----------|
| `strict` | 0 – 0.5 | — | 0.5 – 1.0 | Block all risky actions |
| `balanced` (default) | 0 – 0.5 | 0.5 – 0.8 | 0.8 – 1.0 | Block dangerous, confirm risky — good for daily use |
| `permissive` | 0 – 0.9 | — | 0.9 – 1.0 | Only block critical threats |

For the full field reference (guard / collector sections, external_analyser, permitted/blocked tools, etc.) see the unified `/nio config` documentation. Set `NIO_HOME` to change the config directory (default: `~/.nio`).
