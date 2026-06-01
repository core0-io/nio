---
"@core0-io/nio": minor
---

**Each `/nio` capability is now also a focused single-purpose skill (Claude Code + Codex).**

Alongside the unified `/nio`, six focused skills are added for sharper
passive (natural-language) discovery and direct slash use: `nio-scan`,
`nio-action`, `nio-report`, `nio-config`, `nio-doctor`, and
`nio-external-score`. Each carries its own focused `description` so the
model routes intent precisely (e.g. "what's my Nio score" →
`nio-external-score`, "scan this repo for risks" → `nio-scan`) instead of
matching the broad unified skill and re-routing.

Scope and mechanics:
- Synced only to the LLM-driven platforms — Claude Code and Codex. OpenClaw
  (tool-dispatch via the single `nio_command` tool) and Hermes (`nio-cli.js`)
  keep using the unified `/nio`. The unified `/nio` is unchanged.
- Source of truth: `plugins/shared/skills/<name>/SKILL.md`, synced by
  `scripts/sync-shared.js`; versions tracked in `scripts/sync-versions.js`.
- Script-running skills (action/config/doctor/external-score) sibling-reference
  the kept `nio` skill's bundled scripts via `../nio/scripts/<cli>.js` — no
  multi-MB bundle duplication. `nio-scan` / `nio-action` carry their companion
  `SCAN-RULES.md` / `ACTION-POLICIES.md`.
- New `src/scripts/doctor-cli.ts` (bundled) so `/nio-doctor` — and the unified
  `/nio doctor` — can run as a standalone command on Claude Code / Codex,
  closing the gap where doctor had no invocable CLI on those platforms.
- Hooks (guard/collector/scanner) are untouched — splitting skills does not
  affect the PreToolUse/PostToolUse pipeline.
