# MCP Server Setup

Core0 AgentGuard can run as an MCP (Model Context Protocol) server, providing security tools to any MCP-compatible AI agent.

## Configuration

Add to your MCP configuration:

```json
{
  "mcpServers": {
    "ffwd-agent-guard": {
      "command": "npx",
      "args": ["-y", "@core0-io/ffwd-agent-guard"]
    }
  }
}
```

## Available Tools

| Tool | Description |
|------|-------------|
| `skill_scanner_scan` | Scan a directory for security risks |
| `registry_lookup` | Look up a skill's trust level |
| `registry_attest` | Register a skill with a trust level |
| `registry_revoke` | Revoke a skill's trust |
| `registry_list` | List all registered skills |
| `action_scanner_decide` | Evaluate an action's safety |
