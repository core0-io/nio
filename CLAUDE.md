# FFWD AgentGuard

Security and observability for AI coding agents. Provides code scanning, runtime guard, and OTEL collector.

## Skill

This project provides a unified Claude Code skill: `/ffwd-agent-guard`

```
/ffwd-agent-guard scan <path>          — Scan code for security risks (15 static + 7 behavioral rules)
/ffwd-agent-guard action <description> — Evaluate runtime action safety (allow/deny/confirm)
/ffwd-agent-guard report               — View security event audit log
/ffwd-agent-guard config <level>       — Set protection level (strict/balanced/permissive)
```

## Project Structure

- `plugins/shared/` — Shared config files (config.default.yaml, config.schema.json)
- `plugins/claude-code/` — Claude Code plugin (hooks, skills, setup)
- `plugins/openclaw/` — OpenClaw plugin (manifest, bundled plugin.js, setup)
- `src/` — TypeScript source (scanner, analyzers, runtime guard, adapters)
- `dist/` — Compiled JavaScript output (npm library export)
- `scripts/` — Build and release scripts

## Build

Scripts in `src/scripts/` compile to `plugins/claude-code/skills/ffwd-agent-guard/scripts/`:

```bash
npm run build
```

## Release

```bash
npm run release                    # All platforms
npm run release:claude-code        # Claude Code only
npm run release:openclaw           # OpenClaw only
```

## Configuration

Runtime config lives at `~/.ffwd-agent-guard/config.json` (or `$FFWD_AGENT_GUARD_HOME/config.json`).
A template with all options is at `plugins/shared/config.default.yaml` (synced to each plugin dir during build). Full schema:

```yaml
level: balanced
collector:
  endpoint: ""
  api_key: ""
  timeout: 5000
  log: ""
```

Set `FFWD_AGENT_GUARD_HOME` to change the config directory (default: `~/.ffwd-agent-guard`).
