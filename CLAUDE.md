# FFWD AgentGuard

Security and observability for AI coding agents. Provides code scanning, runtime guard, and OTEL collector.

## Skill

This project provides a unified Claude Code skill: `/ffwd-agent-guard`

```
/ffwd-agent-guard scan <path>          — Scan code for security risks (15 static + 7 behavioural rules)
/ffwd-agent-guard action <description> — Evaluate runtime action safety (allow/deny/confirm)
/ffwd-agent-guard report               — View security event audit log
/ffwd-agent-guard config <level>       — Set protection level (strict/balanced/permissive)
```

## Project Structure

- `plugins/shared/` — Shared config files (config.default.yaml, config.schema.json)
- `plugins/claude-code/` — Claude Code plugin (hooks, skills, setup)
- `plugins/openclaw/` — OpenClaw plugin (manifest, bundled plugin.js, setup)
- `src/` — TypeScript source (scanner, analysers, runtime guard, adapters)
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
guard:
  available_tools: []     # Phase 0: when non-empty, only these tools are available
  blocked_tools: []       # Phase 0: these tools are unconditionally blocked
  guarded_tools:          # Tools entering Phase 1-6 deep analysis
    Bash: exec_command
    Write: write_file
    Edit: write_file
    WebFetch: network_request
    WebSearch: network_request
collector:
  endpoint: ""            # OTLP base URL (appends /v1/traces, /v1/metrics, /v1/logs)
  api_key: ""
  timeout: 5000
  protocol: http          # http | grpc
  log: ""                 # Local JSONL metrics log path
audit:
  local: true             # Write to ~/.ffwd-agent-guard/audit.jsonl
  max_size_mb: 10         # Rotate when exceeded (0 = no rotation)
  otel: true              # Export audit logs via OTEL (uses collector endpoint)
```

Set `FFWD_AGENT_GUARD_HOME` to change the config directory (default: `~/.ffwd-agent-guard`).
