---
"@core0-io/nio": major
---

**Breaking: project renamed from `ffwd-agent-guard` to `nio`.** Hard cutover — no backcompat shims.

- **npm package**: `@core0-io/ffwd-agent-guard` → `@core0-io/nio`. Existing consumers must update imports.
- **Config directory**: `~/.ffwd-agent-guard/` → `~/.nio/`. Old configs are not migrated; re-run `setup.sh` to regenerate.
- **Environment variable**: `FFWD_AGENT_GUARD_HOME` → `NIO_HOME`.
- **Slash command**: `/ffwd-agent-guard` → `/nio`.
- **Plugin IDs**: Claude Code marketplace + plugin name `ffwd-agent-guard` → `nio`. OpenClaw plugin id `ffwd-agent-guard` → `nio`.
- **OTEL schema**: service name `agentguard` → `nio`; all `agentguard.*` attributes + metrics (`agentguard.tool_use.count`, `agentguard.turn.count`, `agentguard.decision.count`, `agentguard.risk.score`) renamed to `nio.*`. Existing dashboards and alert rules must update their queries.
- **TS exports**: `createAgentGuard` → `createNio`, `AgentGuardConfig` → `NioConfig`, `AgentGuardConfigSchema` → `NioConfigSchema`, `AgentGuardInstance` → `NioInstance`.
- **Skill directory**: `plugins/*/skills/ffwd-agent-guard/` renamed to `plugins/*/skills/nio/`.
- **Release zips** now named `nio-<target>-v<version>.zip`.
- **GitHub repo URL** updated in manifests to `github.com/core0-io/nio` (repo rename handled separately).
