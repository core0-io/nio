---
"@core0-io/nio": minor
---

**New `/nio external-score` subcommand — snapshot every enabled external scoring endpoint's current score.**

Adds a focused command that queries all enabled Phase 6 endpoints
(`guard.external_analyser`) and lists each one's live score, keyed by its
configured `name`. Unlike `/nio doctor` — which folds external probes in
with config-schema and LLM checks — this is a single-purpose snapshot:
one line per endpoint showing the score (and `reason`, if returned) on
success, or the error + hint on failure.

Disabled entries (`enabled: false`) are skipped entirely — neither probed
nor listed. The probe reuses doctor's silent `probeExternalAnalyser`, so
the command never writes to the audit log. Endpoints are queried
concurrently, mirroring how Phase 6 fires them at runtime.

Wiring:
- `handleExternalScore()` + `external-score` (alias `external`) case in
  `src/adapters/openclaw-dispatch.ts` — picked up automatically by OpenClaw
  (`nio_command` tool) and Hermes (`nio-cli.js`).
- New bundled `src/scripts/external-score-cli.ts` so Claude Code / Codex
  (which read `SKILL.md` and shell out to scripts) can run it via
  `node scripts/external-score-cli.js`.
- `SKILL.md` routing + subcommand section; `argument-hint` updated.
