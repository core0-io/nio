# Nio

Execution assurance and observability for autonomous AI agents. Provides code scanning, runtime guard, and OTEL collector.

## Skill

This project provides a unified Claude Code skill: `/nio`

```
/nio scan <path>          — Scan code for execution risks (15 static + 7 behavioural rules)
/nio action <description> — Evaluate runtime action safety (allow/deny/confirm)
/nio report               — View agent execution audit log
/nio config <level>       — Set protection level (strict/balanced/permissive)
```

## Project Structure

- `plugins/shared/` — Shared config + skill source of truth (`skill/SKILL.md`, `SCAN-RULES.md`, `ACTION-POLICIES.md`, `README.md`)
- `plugins/claude-code/` — Claude Code plugin (hooks, `skills/nio/` synced from shared, setup)
- `plugins/codex/` — Codex CLI plugin. Repo layout is flat (parallels cc/openclaw/hermes): manifest at `.codex-plugin/plugin.json` (with `interface{displayName,category,…}`); hooks at `hooks/hooks.json`; skills under `skills/nio/`; `setup.sh` at root. **No marketplace.json in the repo** — codex 0.128 schema requires `source.path` to be a non-empty `./<subdir>` and our flat layout has no such subdir, so `setup.sh` generates a valid marketplace.json at install time instead. Covers 5 of 6 Codex hook events (SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop) — **no SessionEnd / SubagentStop equivalent in Codex**, and `PermissionRequest` is deferred to phase 2. Skill content synced from `plugins/shared/skill/` via `scripts/sync-shared.js`; scripts mirrored from `plugins/claude-code/skills/nio/scripts/` by `scripts/build.js`. Codex CLI does **not** support custom slash commands — `/nio` is exposed only via `$nio` skill trigger or natural-language match. Adapter at `src/adapters/codex.ts` with `name='codex'` and default `native_tool_mapping = { Bash: exec_command }` (Codex's only first-party tool; writes/reads/fetches go through shell). `setup.sh` performs a full **nuke + cp install** on every invocation (no `codex plugin install` CLI exists in 0.128): wipes and rewrites `$CODEX_HOME/plugins/cache/nio/nio/<version>/` from `$SCRIPT_DIR`; wipes and rebuilds a Codex-valid marketplace catalog under `$NIO_HOME/codex-marketplace/`; writes a `hooks.json` with **absolute paths** into the cache dir (Codex runs hook commands with `cwd=session-cwd`, so plugin-relative paths can't resolve); edits `~/.codex/config.toml` to register the marketplace, enable the plugin, and set both `[features] codex_hooks = true` (stable) and `[features] plugin_hooks = true` (under-development; required for plugin-bundled hooks to fire). Same `setup.sh` works whether invoked from the repo or an extracted release zip. Hook scripts (`guard-hook.js` / `collector-hook.js` / `scanner-hook.js`) accept `--platform codex` to thread the platform tag through Phase 0–6 and the audit log; default platform stays `claude-code` for cc.
- `plugins/openclaw/` — OpenClaw plugin (`plugin/` subdir holds manifest + bundled `plugin.js`; `skills/nio/` synced from shared; setup.sh orchestrates both)
- `plugins/hermes/` — Hermes integration. Two surfaces:
  1. **Shell-hooks** (upstream PR #13296): `setup.sh` + `install-hook.py` merge **7 lifecycle event entries** into `~/.hermes/config.yaml` — all pointing at the same self-contained `scripts/hook-cli.js`, which internally dispatches `pre_tool_call` to the guard pipeline (Phase 0–6) and `post_tool_call` / `pre_llm_call` / `post_llm_call` / `on_session_start` / `on_session_end` / `subagent_stop` to the collector pipeline (OTEL traces + metrics + logs).
  2. **`/nio` slash command** via a tiny **Python plugin** (`plugins/hermes/python-plugin/`): `setup.sh` drops `plugin.yaml` + `__init__.py` + bundled `scripts/nio-cli.js` into `~/.hermes/plugins/nio/` and adds `nio` to the user's `plugins.enabled` opt-in list. The plugin's `register(ctx)` hooks `/nio` straight into Hermes's slash dispatch — bypasses the LLM, mirrors OpenClaw's `command-dispatch: tool` route. No pip install / wheel; Hermes auto-discovers any directory under `~/.hermes/plugins/<name>/`.
  Both `scripts/hook-cli.js` and `scripts/nio-cli.js` are built by `build.js` as single-file bundles (`splitting: false`) so a Hermes-only release zip (`nio-hermes-vX.zip`) has no dependency on the Claude Code plugin.
- `src/` — TypeScript source (scanner, analysers, runtime guard, adapters)
- `dist/` — Compiled JavaScript output (npm library export)
- `scripts/` — Build and release scripts

## Build

`pnpm run build` runs three passes in order:

1. `tsc -p tsconfig.lib.json` — emits unbundled `dist/` + `.d.ts` for the npm library export.
2. `bun scripts/build.js` — bundles `dist/adapters/openclaw-plugin.js` → `plugins/openclaw/plugin/plugin.js` and `src/scripts/*.ts` → `plugins/claude-code/skills/nio/scripts/`, then mirrors the compiled scripts to `plugins/openclaw/skills/nio/scripts/` and `plugins/codex/skills/nio/scripts/`.
3. `node scripts/sync-shared.js` — copies `plugins/shared/` config + `plugins/shared/skill/*` into each plugin's skill dir.

```bash
pnpm run build
```

## Release

Per-platform zip builds:

```bash
pnpm run release                   # All platforms
pnpm run release:claude-code       # Claude Code only
pnpm run release:codex             # Codex CLI only
pnpm run release:openclaw          # OpenClaw only
pnpm run release:hermes            # Hermes only
```

Full release workflow (versioned, tagged, published to GitHub):

```bash
pnpm bump                          # select + apply changesets; bumps version
                                   # in all 3 manifests (root, openclaw, marketplace)
git commit -am "release v$(jq -r .version package.json)"
pnpm tag                           # changeset tag → creates local git tags
git push --follow-tags
pnpm release:publish               # build + zip + gh release create (attaches to existing tag)
```

Contributors author changesets per PR with `pnpm version-select` (interactive: pick bump type + describe the change). Changesets accumulate in `.changeset/`; `pnpm bump` consumes them, updates `CHANGELOG.md`, and bumps versions.

## Configuration

Runtime config lives at `~/.nio/config.yaml` (or `$NIO_HOME/config.yaml`).
A template with all options is at `plugins/shared/config.default.yaml` (synced to each plugin dir during build). Two top-level sections:

```yaml
guard:
  protection_level: balanced
  confirm_action: allow          # What to do on confirm: allow | deny | ask
  file_scan_rules: {}            # Extra scan patterns (Phase 3 + scan command)
  action_guard_rules: {}         # Extra guard patterns (Phase 2 runtime analysis)
  llm_analyser: { enabled: false, api_key: "" }       # Phase 5 LLM analyser
  external_analyser: { enabled: false, endpoint: "" }  # Phase 6 external scoring API
  allowed_commands: []      # Phase 1 safe command prefixes
  permitted_tools: {}       # Per-platform + `mcp` strict allowlist (Phase 0)
  blocked_tools: {}         # Per-platform + `mcp` denylist (Phase 0; takes precedence)
  mcp_servers: {}           # Manual MCP server registry (server name → URLs / sockets / binaries / cliPackages)
  native_tool_mapping:      # Per-platform native tool → action type classification
    claude_code: { Bash: exec_command, Write: write_file, Edit: write_file, WebFetch: network_request, WebSearch: network_request }
    codex:       { Bash: exec_command }   # Codex's only native tool; everything else goes through shell
    openclaw: { exec: exec_command, write: write_file, web_fetch: network_request, browser: network_request }
  scoring_weights: {}       # Phase score aggregation weights

collector:
  endpoint: ""              # OTLP base URL (appends /v1/traces, /v1/metrics, /v1/logs)
  api_key: ""
  timeout: 5000
  protocol: http            # http | grpc
  metrics: { enabled: true }
  traces: { enabled: true }
  logs: { enabled: true, local: true, path: "~/.nio/audit.jsonl", max_size_mb: 100 }
```

Set `NIO_HOME` to change the config directory (default: `~/.nio`).
