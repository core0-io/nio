# Nio

Execution assurance and observability for autonomous AI agents. Provides code scanning, runtime guard, and OTEL collector.

## Skill

This project provides a unified Claude Code skill: `/nio`

```
/nio scan <path>          — Scan code for execution risks (15 static + 7 behavioural rules)
/nio action <description> — Evaluate runtime action safety (allow/deny/confirm)
/nio report               — Agent execution audit log + diagnostics summary
/nio doctor               — Validate config + dry-run OAuth/LLM connectivity
/nio config <level>       — Set protection level (strict/balanced/permissive)
/nio external-score       — Snapshot current scores from external scoring endpoints
/nio monitor [on|off|status] — Arm/disarm OTLP telemetry capture for this session
```

**Telemetry capture is off by default.** A configured `collector.endpoint` does not by itself export anything: every session stays silent until `/nio monitor on` arms it (or `collector.monitor_all_sessions: true` is set globally). All three OTLP signals are behind that gate; the local `~/.nio/audit.jsonl` and guard enforcement are not. Gate implementation: `src/scripts/lib/monitor-{store,gate,check,commands}.ts`, consulted at every hook entry point before any OTEL provider is constructed.

Alongside the unified `/nio`, each capability is also exposed as a **focused single-purpose skill** for sharper passive (natural-language) discovery on the LLM-driven platforms (**Claude Code, Codex, Pi, and opencode** — OpenClaw/Hermes keep the unified `/nio`): `nio-scan`, `nio-action`, `nio-report`, `nio-config`, `nio-doctor`, `nio-external-score`, `nio-monitor`. Source of truth: `plugins/shared/skills/<name>/SKILL.md` (synced by `scripts/sync-shared.js`). These are pure LLM-driven skills (no `command-dispatch`/`command-tool`); script-running ones (action/config/doctor/external-score) **sibling-reference** the kept `nio` skill's bundled scripts via `../nio/scripts/<cli>.js` rather than duplicating the bundle.

## Project Structure

- `plugins/shared/` — Shared config + skill source of truth. All skill sources live under `skills/<name>/`: the unified umbrella `skills/nio/` (`SKILL.md` + `README.md`) plus the focused per-capability skills (`skills/nio-scan/`, `skills/nio-action/`, …). Rule docs are owned by their capability — `SCAN-RULES.md` in `skills/nio-scan/`, `ACTION-POLICIES.md` in `skills/nio-action/`; `sync-shared.js` borrows a copy of each into the umbrella's dest dir (whose `SKILL.md` links them)
- `plugins/claude-code/` — Claude Code plugin (hooks, `skills/nio/` synced from shared, setup)
- `plugins/codex/` — Codex CLI plugin. Repo layout is flat (parallels cc/openclaw/hermes): manifest at `.codex-plugin/plugin.json` (with `interface{displayName,category,…}`); hooks at `hooks/hooks.json`; skills under `skills/nio/`; `setup.sh` at root. **No marketplace.json in the repo** — codex 0.128 schema requires `source.path` to be a non-empty `./<subdir>` and our flat layout has no such subdir, so `setup.sh` generates a valid marketplace.json at install time instead. Subscribes to SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop; PermissionRequest is deferred to phase 2. Skill content synced from `plugins/shared/skills/nio/` via `scripts/sync-shared.js`; scripts mirrored from `plugins/claude-code/skills/nio/scripts/` by `scripts/build.js`. Codex CLI does **not** support custom slash commands — `/nio` is exposed only via `$nio` skill trigger or natural-language match. Adapter at `src/adapters/codex.ts` with `name='codex'` and default `native_tool_mapping = { Bash: exec_command }` (Codex's only first-party tool; writes/reads/fetches go through shell). `setup.sh` performs a full **nuke + cp install** on every invocation (no `codex plugin install` CLI exists in 0.128): wipes and rewrites `$CODEX_HOME/plugins/cache/nio/nio/<version>/` from `$SCRIPT_DIR`; wipes and rebuilds a Codex-valid marketplace catalog under `$NIO_HOME/codex-marketplace/`; writes a `hooks.json` with **absolute paths** into the cache dir (Codex runs hook commands with `cwd=session-cwd`, so plugin-relative paths can't resolve); edits `~/.codex/config.toml` to register the marketplace, enable the plugin, and set both `[features] codex_hooks = true` (stable) and `[features] plugin_hooks = true` (under-development; required for plugin-bundled hooks to fire). Same `setup.sh` works whether invoked from the repo or an extracted release zip. Hook scripts (`guard-hook.js` / `collector-hook.js` / `scanner-hook.js`) accept `--platform codex` to thread the platform tag through Phase 0–6 and the audit log; default platform stays `claude-code` for cc.
- `plugins/pi/` — Pi extension. The release zip is itself a valid pi package (`package.json` with the `pi` manifest key and the `pi-package` keyword), so `setup.sh` prefers `pi install "$SCRIPT_DIR"` and falls back to copying the bundle into `~/.pi/agent/extensions/nio/` plus an explicit path entry in `settings.json`. Subscribes `tool_call` (blocking) / `tool_result` / `input` / `session_start` / `session_shutdown` / `agent_end` / `message_end` / `user_bash`. `/nio` is a real slash command via `pi.registerCommand`, bypassing the LLM. Pi is the only platform with an interactive channel, so a `confirm` verdict opens a real `ctx.ui.confirm` dialog with a timeout (`pi -p` print mode has `ctx.hasUI === false` and folds to the two-state behaviour). **Pi has no subagent concept**, so no Task spans are emitted. **Pi core has no MCP either, but the third-party `pi-mcp-adapter` package adds it** and is the de-facto default for Pi users, so `parseMcpToolName` carries a `pi` branch (Task 11b): the proxy tool `mcp` resolves its target from the `tool` / `server` parameters, and `directTools` mode is matched as `<server>_<tool>` / `mcp__<server>_<tool>` against servers read from `$PI_CODING_AGENT_DIR/mcp.json` (else `~/.pi/agent/mcp.json`). `toolPrefix: "none"` is undetectable by design. `setup.sh` exports `PI_CODING_AGENT_DIR="$PI_HOME"` before shelling out so `--pi-home` actually binds the `pi` CLI. Adapter at `src/adapters/pi.ts`; binding at `src/adapters/pi-plugin.ts`.
- `plugins/opencode/` — opencode plugin. No plugin-install CLI exists, so `setup.sh` does an idempotent nuke + copy into `~/.config/opencode/` (`plugins/nio.js`, `commands/nio.md`, `skills/`). Hooks: `tool.execute.before` (throws `NioBlockedError` to block) / `tool.execute.after` / `chat.message` / `permission.ask` / `event` / `dispose`. `tool.execute.after` does **not** fire when a tool throws, so the `session.idle` branch of `event` doubles as the safety net that reclaims the pending span. No plugin API for slash commands, so `/nio` is a `commands/nio.md` template that instructs the model to call the plugin-registered `nio_command` tool. MCP tool names are `<sanitize(server)>_<sanitize(tool)>`, handled by the two-tier `opencode` branch in `parseMcpToolName`. `setup.sh` writes the `{"type":"module"}` ESM sentinel into `$OC_HOME/plugins/` **only** when that shared directory holds no sibling plugin and no pre-existing `package.json`; it drops a `.nio-esm-sentinel` ownership marker at the same time, and `--uninstall` removes the pair only when that marker is present. Adapter at `src/adapters/opencode.ts`; binding at `src/adapters/opencode-plugin.ts`.
- `plugins/openclaw/` — OpenClaw plugin (`plugin/` subdir holds manifest + bundled `plugin.js`; `skills/nio/` synced from shared; setup.sh orchestrates both)
- `plugins/hermes/` — Hermes integration. Two surfaces:
  1. **Shell-hooks** (upstream PR #13296): `setup.sh` + `install-hook.py` merge **7 lifecycle event entries** into `~/.hermes/config.yaml` — all pointing at the same self-contained `scripts/hook-cli.js`, which internally dispatches `pre_tool_call` to the guard pipeline (Phase 0–6) and `post_tool_call` / `pre_llm_call` / `post_llm_call` / `on_session_start` / `on_session_end` / `subagent_stop` to the collector pipeline (OTEL traces + metrics + logs).
  2. **`/nio` slash command** via a tiny **Python plugin** (`plugins/hermes/python-plugin/`): `setup.sh` drops `plugin.yaml` + `__init__.py` + bundled `scripts/nio-cli.js` into `~/.hermes/plugins/nio/` and adds `nio` to the user's `plugins.enabled` opt-in list. The plugin's `register(ctx)` hooks `/nio` straight into Hermes's slash dispatch — bypasses the LLM, mirrors OpenClaw's `command-dispatch: tool` route. No pip install / wheel; Hermes auto-discovers any directory under `~/.hermes/plugins/<name>/`.
  Both `scripts/hook-cli.js` and `scripts/nio-cli.js` are built by `build.js` as single-file bundles (`splitting: false`) so a Hermes-only release zip (`nio-hermes-vX.zip`) has no dependency on the Claude Code plugin.
- `src/` — TypeScript source (scanner, analysers, runtime guard, adapters). `src/adapters/plugin-runtime.ts` holds the shared `InProcessPluginRuntime` that OpenClaw, Pi, and opencode all sit on: it owns config, the three OTEL providers, per-session collector state, guard-decision → span-attribute translation, orphan-span compensation on the block path, and turn flushing. Platform bindings only translate their host's event shapes into its semantic methods. Despite its name, `src/adapters/openclaw-dispatch.ts` is the **shared** `/nio` sub-command router and doctor implementation for every in-process platform — the Pi and opencode doctor probes live there.
- `dist/` — Compiled JavaScript output (npm library export)
- `scripts/` — Build and release scripts

## Build

`pnpm run build` runs three passes in order:

1. `tsc -p tsconfig.lib.json` — emits unbundled `dist/` + `.d.ts` for the npm library export.
2. `bun scripts/build.js` — bundles `dist/adapters/openclaw-plugin.js` → `plugins/openclaw/plugin/plugin.js`, `dist/adapters/pi-plugin.js` → `plugins/pi/extensions/nio/index.js`, `dist/adapters/opencode-plugin.js` → `plugins/opencode/plugins/nio.js`, and `src/scripts/*.ts` → `plugins/claude-code/skills/nio/scripts/`, then mirrors the compiled scripts to `plugins/openclaw/`, `plugins/codex/`, `plugins/pi/`, and `plugins/opencode/` `skills/nio/scripts/`. The Pi and opencode plugin bundles are single non-split builds so a per-platform release zip stands alone. No ESM sentinel is written next to the Pi bundle — `plugins/pi/package.json` is a real manifest that already declares `"type": "module"`.
3. `node scripts/sync-shared.js` — copies `plugins/shared/` config + the umbrella `plugins/shared/skills/nio/*` into each of the six plugin dirs' `skills/nio/` (claude-code, openclaw, codex, pi, opencode; plus config-only for hermes), and the focused `plugins/shared/skills/nio-*/` into Claude Code, Codex, Pi, and opencode. It also copies the root `README.md` into each plugin dir.

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
pnpm run release:pi                # Pi only
pnpm run release:opencode          # opencode only
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
  external_analyser: []     # Phase 6 — array of scoring endpoints (GET-only; bearer/oauth auth; optional headers; strict { score, reason? } response contract)
  allowed_commands: []      # Phase 1 safe command prefixes
  permitted_tools: {}       # Per-platform + `mcp` strict allowlist (Phase 0)
  blocked_tools: {}         # Per-platform + `mcp` denylist (Phase 0; takes precedence)
  mcp_servers: {}           # Manual MCP server registry (server name → URLs / sockets / binaries / cliPackages)
  native_tool_mapping:      # Per-platform native tool → action type classification
    claude_code: { Bash: exec_command, Write: write_file, Edit: write_file, WebFetch: network_request, WebSearch: network_request }
    codex:       { Bash: exec_command }   # Codex's only native tool; everything else goes through shell
    openclaw: { exec: exec_command, write: write_file, web_fetch: network_request, browser: network_request }
    pi:       { bash: exec_command, write: write_file, edit: write_file, read: read_file }   # Pi core has no network tool; network goes through bash
    opencode: { bash: exec_command, write: write_file, edit: write_file, apply_patch: write_file, read: read_file, webfetch: network_request, websearch: network_request }
  scoring_weights: {}       # Phase score aggregation weights

collector:
  endpoint: ""              # OTLP base URL (appends /v1/traces, /v1/metrics, /v1/logs)
  monitor_all_sessions: false  # false (default) = capture only sessions armed via /nio monitor on
  api_key: ""
  timeout: 5000
  protocol: http            # http | grpc
  metrics: { enabled: true }
  traces: { enabled: true }
  logs: { enabled: true, local: true, path: "~/.nio/audit.jsonl", max_size_mb: 100 }
```

Set `NIO_HOME` to change the config directory (default: `~/.nio`).
