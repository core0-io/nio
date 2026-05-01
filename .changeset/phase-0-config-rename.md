---
"@core0-io/nio": minor
---

**Breaking config schema change.** Phase 0 / MCP-routing config keys have
been renamed for clarity. Existing `~/.nio/config.yaml` files using the
old names continue to load (unknown fields are stripped, not rejected),
but settings under the old keys are silently ignored — update any custom
config to the new keys.

| Old key                           | New key                               | Why |
| --------------------------------- | ------------------------------------- | --- |
| `guard.available_tools`           | `guard.permitted_tools`               | Old name read as descriptive ("here are the tools that exist"). The actual semantic is a strict allowlist — when non-empty for a namespace, only listed tools pass Phase 0. The new name pairs naturally with `blocked_tools`. |
| `guard.guarded_tools`             | `guard.native_tool_mapping`           | Old name suggested a third allow/deny list parallel to `available_tools` / `blocked_tools`. It's actually a tool-name → action-type classification table for platform-native tools (Bash, Edit, Write, terminal, …) that decides which Phase 1–6 rule set runs. MCP tools are dynamic and not in this map. |
| `guard.mcp_endpoints`             | `guard.mcp_servers`                   | Old name implied URL-only targets, but entries also list `binaries` and `cliPackages` — neither of which are endpoints. The structure is a server registry keyed by server name; the TS types already used `MCPServerEntry` / `MCPRegistry`, and auto-discovered upstream config files use the field name `mcpServers`. |

Internal/adapter API also renames the constructor option:
`new ClaudeCodeAdapter({ guardedTools })` → `new ClaudeCodeAdapter({ nativeToolMapping })`
(same for `OpenClawAdapter` and `HermesAdapter`). The Phase 0 deny risk
tag `TOOL_GATE_UNAVAILABLE` is now `TOOL_GATE_NOT_PERMITTED`, with the
deny reason updated to `Tool "X" is not permitted (permitted_tools)`.
