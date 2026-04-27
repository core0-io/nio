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
2. `bun scripts/build.js` — bundles `dist/adapters/openclaw-plugin.js` → `plugins/openclaw/plugin/plugin.js` and `src/scripts/*.ts` → `plugins/claude-code/skills/nio/scripts/`, then mirrors the compiled scripts to `plugins/openclaw/skills/nio/scripts/`.
3. `node scripts/sync-shared.js` — copies `plugins/shared/` config + `plugins/shared/skill/*` into each plugin's skill dir.

```bash
pnpm run build
```

## Release

Per-platform zip builds:

```bash
pnpm run release                   # All platforms
pnpm run release:claude-code       # Claude Code only
pnpm run release:openclaw          # OpenClaw only
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
  available_tools: {}       # Per-platform + `mcp` tool allowlist (Phase 0)
  blocked_tools: {}         # Per-platform + `mcp` tool denylist (Phase 0)
  guarded_tools:            # Per-platform tool → action type mapping
    claude_code: { Bash: exec_command, Write: write_file, Edit: write_file, WebFetch: network_request, WebSearch: network_request }
    openclaw: { exec: exec_command, write: write_file, web_fetch: network_request, browser: network_request }
  scoring_weights: {}       # Phase score aggregation weights

collector:
  endpoint: ""              # OTLP base URL (appends /v1/traces, /v1/metrics, /v1/logs)
  api_key: ""
  timeout: 5000
  protocol: http            # http | grpc
  metrics: { enabled: true, local: true, log: "~/.nio/metrics.jsonl", max_size_mb: 100 }
  traces: { enabled: true }
  logs: { enabled: true, local: true, path: "~/.nio/audit.jsonl", max_size_mb: 100 }
```

Set `NIO_HOME` to change the config directory (default: `~/.nio`).
