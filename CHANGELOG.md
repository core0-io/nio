# @core0-io/ffwd-agent-guard

## 1.0.3

### Patch Changes

- - **YAML-only config**: runtime config is now exclusively `~/.ffwd-agent-guard/config.yaml`. JSON fallback removed; `setup.sh --reset-config` generates `config.yaml` directly.
  - **`/pattern/flags` regex syntax**: user-supplied regex patterns in config now accept the literal `/pattern/flags` form (e.g. `'/\b(INSERT|UPDATE)\b/i'`) for case-insensitive and other flag combinations. Plain patterns still work for backward compat. Applied everywhere user regex is compiled (Phase 2 runtime + Phase 3 static file_scan_rules).
  - **Config load errors now visible**: YAML syntax errors and Zod validation failures previously failed silently. They now print to stderr and write a `config_error` entry to `~/.ffwd-agent-guard/audit.jsonl`, with per-process dedup. Runtime continues with defaults (fail-open).
  - **`action_guard_rules.secret_patterns` now wired up**: previously declared in the schema but never consumed. User regexes are now evaluated against network request bodies; matches emit a new `SECRET_LEAK_USER` finding (high) with the pattern source in the title.

  - **User `dangerous_patterns` no longer mislabeled**: matches were being reported as `DANGEROUS_COMMAND` / "Dangerous command: pipe to shell" regardless of which user pattern fired. They now have their own rule_id `DANGEROUS_PATTERN` and a title echoing the matching pattern source.
  - **Phase 2 collects all findings per action**: `analyzeBashCommand` no longer short-circuits the function on the first critical hit. Every rule set is evaluated on every command; the decision is unchanged (aggregated score still drives DENY), but audit logs now show every dimension a command touches — better signal for forensics and rule tuning.

  - `plugins/shared/skill/ACTION-POLICIES.md`: documented `DANGEROUS_PATTERN` and `SECRET_LEAK_USER` rule_ids, the `/pattern/flags` syntax, and rewrote "Exec Decision Logic" to reflect the non-short-circuiting behaviour.
  - Various `config.json` → `config.yaml` corrections across `docs/ARCHITECTURE.md`, `README.md`, plugin SKILL.md files, and `config.schema.json`.

  - +3 suites covering `dangerous_patterns` (5 cases), `secret_patterns` (3 cases), and the shared regex compiler (9 cases). 387/387 passing.

## 1.0.2

### Patch Changes

- Features

  Add guard.confirm_action config (allow | deny | ask, default allow) to control how each platform handles a confirm decision. Fixes OpenClaw incorrectly blocking the 0.5–0.8 balanced-mode range (no native interactive confirm); Claude Code can also force allow/deny instead of prompting.

  Refactor

  Consolidate skill docs under plugins/shared/skill/ as the single source of truth, synced to both platform plugin dirs during build — eliminates drift between Claude Code and OpenClaw copies.
  Restructure OpenClaw plugin layout: runtime files moved into plugins/openclaw/plugin/ subdir, isolated from skills/ to avoid false positives from OpenClaw's plugin validator.

  Fix

  Release flow now cleans up stale release artifacts before publishing a new version.

## 1.0.1

### Patch Changes

---
