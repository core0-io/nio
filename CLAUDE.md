# FFWD AgentGuard

Security framework for AI agents. Provides code scanning, runtime action evaluation, and trust management.

## Skill

This project provides a unified Claude Code skill: `/ffwd-agent-guard`

```
/ffwd-agent-guard scan <path>          — Scan code for security risks (16 detection rules)
/ffwd-agent-guard action <description> — Evaluate runtime action safety (allow/deny/confirm)
/ffwd-agent-guard patrol [run|setup|status] — Daily security patrol for OpenClaw environments
/ffwd-agent-guard trust <subcommand>   — Manage skill trust levels (lookup/attest/revoke/list)
/ffwd-agent-guard report               — View security event audit log
/ffwd-agent-guard config <level>       — Set protection level (strict/balanced/permissive)
```

## Project Structure

- `skills/ffwd-agent-guard/` — Claude Code skill definition and supporting files
- `src/` — TypeScript source (scanner rules, registry, action detectors, MCP server)
- `data/` — Registry storage (`registry.json`)
- `dist/` — Compiled JavaScript output

## Build

Scripts in `src/scripts/` compile to `skills/ffwd-agent-guard/scripts/`:

```bash
npm run build
```

## Configuration

Runtime config lives at `~/.ffwd-agent-guard/config.json` (or `$FFWD_AGENT_GUARD_HOME/config.json`).
A template with all options is at `config.default.json` in the repo root. Full schema:

```json
{
  "level": "balanced",
  "auto_scan": false,
  "metrics": {
    "endpoint": "",
    "api_key": "",
    "timeout": 5000,
    "log": ""
  }
}
```

Set `FFWD_AGENT_GUARD_HOME` to change the config directory (default: `~/.ffwd-agent-guard`).
