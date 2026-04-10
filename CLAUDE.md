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

- `skills/ffwd-agent-guard/` — Claude Code skill definition and supporting files
- `src/` — TypeScript source (scanner, analyzers, runtime guard, adapters)
- `dist/` — Compiled JavaScript output

## Build

Scripts in `src/scripts/` compile to `skills/ffwd-agent-guard/scripts/`:

```bash
npm run build
```

## Configuration

Runtime config lives at `~/.ffwd-agent-guard/config.yaml` (or `$FFWD_AGENT_GUARD_HOME/config.yaml`).
A template with all options is at `config.default.yaml` in the repo root. Full schema:

```yaml
level: balanced
collector:
  endpoint: ""
  api_key: ""
  timeout: 5000
  log: ""
```

Set `FFWD_AGENT_GUARD_HOME` to change the config directory (default: `~/.ffwd-agent-guard`).
