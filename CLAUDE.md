# Core0 AgentGuard

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
/ffwd-agent-guard checkup              — Run agent health checkup with visual HTML report
```

## Project Structure

- `skills/ffwd-agent-guard/` — Claude Code skill definition and supporting files
- `src/` — TypeScript source (scanner rules, registry, action detectors, MCP server)
- `data/` — Registry storage (`registry.json`)
- `dist/` — Compiled JavaScript output

## Setup for Trust & Action CLI

The `trust` and `action` subcommands use CLI scripts that require the @core0-io/ffwd-agent-guard package:

```bash
cd skills/ffwd-agent-guard/scripts && npm install
```
