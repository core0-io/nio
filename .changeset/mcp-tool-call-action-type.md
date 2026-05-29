---
"@core0-io/nio": patch
---

**MCP tool calls are now first-class actions through the guard pipeline.**

Before this change, MCP tool invocations on every platform (Claude Code,
Codex, OpenClaw, Hermes) silently allowed through the hook with **no
audit log entry and no Phase 1–6 analysis at all**. The bypass was the
same line on every platform: `mapToolToActionType()` returned `null` for
any tool absent from the platform's `native_tool_mapping`, so
`buildEnvelope()` returned `null`, and `evaluateHook` short-circuited at
`if (!envelope) return { decision: 'allow' };` — skipping `writeAuditLog`
as well. A Hermes user could trigger `mcp_config_db_update_current_config`
on a firewall config DB and find zero record of it in
`~/.nio/audit.jsonl`.

**What changes:**

- New `mcp_tool_call` action type (`src/types/action.ts`) with
  `McpToolCallData { server: string | null, tool: string, args: object }`.
- New `buildMcpEnvelope` helper plus an MCP fallback path inside
  `evaluateHook` (`src/adapters/hook-engine.ts`). When an adapter cannot
  classify a tool via `nativeToolMapping`, the engine checks the platform's
  MCP convention via `parseMcpToolName` and constructs an `mcp_tool_call`
  envelope. The envelope flows through Phase 1–6: Phase 3 statically scans
  the JSON-serialised `args` (matching against `*.json` and `*` file
  patterns); Phase 5 LLM and Phase 6 external scorers receive the full
  `{server, tool, args}` payload.
- Orchestrator additions for `mcp_tool_call` in Phase 3 / 4 content
  extraction and Phase 5 LLM synthetic-file branches
  (`src/core/action-orchestrator.ts`).
- `action-cli` and `openclaw-dispatch` gain `mcp_tool_call` subcommands
  for direct dev / SDK use.

**Hermes single-underscore naming compatibility.** Hermes flattens MCP
tool names with `_` separators (`mcp_<server>_<tool>`), which the
existing `__` double-underscore convention can't split. `parseMcpToolName`
on Hermes now also recognises the `mcp_` prefix and keeps the full tool
name as the local name (no prefix stripping). Users list the tool
verbatim in `permitted_tools.mcp` / `blocked_tools.mcp` — exactly as it
appears in the hook payload. The existing `<server>__<tool>` form is
still recognised when present and takes precedence.

**UNCATEGORIZED_TOOL audit fallback.** Truly unmapped non-MCP tools no
longer disappear from the audit log. The engine now writes a
`{decision: 'allow', risk_tags: ['UNCATEGORIZED_TOOL'], phase_stopped: 0}`
entry so `/nio report` and audit consumers see every tool invocation
that reached the hook.

**Docs.** Phase 0 walkthrough, configuration reference, and the
architecture overview describe the new fallback chain and the Hermes
MCP naming compatibility. Tests: 19 new test cases (4 adapter MCP
fallback paths, Phase 0 mcp gate in Hermes single-underscore mode,
UNCATEGORIZED_TOOL fallback, content scan over MCP args). 1119/1119
passing.
