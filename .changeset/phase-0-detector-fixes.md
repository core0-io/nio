---
"@core0-io/nio": patch
---

**Phase 0 MCP detector — fix three compounding bugs** that let `blocked_tools.mcp`
deny-by-tool-name be bypassed via Python heredocs, raw TCP, and similar indirect
channels. A user e2e audit found a Python heredoc using `json.dumps({'name':'X'})`
actually controlled real Home Assistant lights despite the tool being explicitly
blocked.

| Bug | Symptom | Fix |
|-----|---------|-----|
| D7 `detectLanguageRuntime` never extracted tool names from inline source bodies (only walked URLs) | Hits emitted `tool: undefined`, candidates collapsed to `${server}__*`, never matched a bare blocked_tools entry | D7 now calls `extractToolFromJsonBody(fragment.command)` like D2/D3/D8/D9 do |
| `extractToolFromJsonBody` used strict `JSON.parse` — rejected Python single-quoted dict literals (`{'name':'X'}`, the shape `json.dumps({...})` generates in source) | V6 e2e vector slipped through despite containing the tool name as a literal | Falls back to single→double-quote substitution before giving up on a `{...}` slice |
| `blocked_tools.mcp` matcher was literal-equality only — when a detector resolved a server but couldn't extract the tool (raw `nc`, opaque body), candidates `[server__*, server]` never matched a bare `blocked_tools` entry | `permitted_tools` mode already biased toward deny on these; denylist mode did not | When a hit has `tool: undefined` AND `blocked_tools.mcp` lists any entry that could be a tool on the resolved server (bare entry, or `server__tool` matching the resolved server), the call is denied. Trade-off (documented): over-denies indirect calls to non-blocked tools on the same server. Users wanting fine-grained allow + deny on one server should use `permitted_tools.mcp` allowlist mode |

**Latent fix** in `extractToolFromJsonBody`: when the first `{...}` slice failed to
parse, the function fell back to scanning for the next `{` — but `open` (the slice
start position) was `const` and never reset. Multi-blob bodies could mis-slice.

The user's V1–V6 audit table is now locked in as `Integration: 6-vector e2e
regression` in `src/tests/integration.test.ts`, plus new D7 tool-extraction unit
tests, parser fallback unit tests, and matcher-bias integration tests (+23 tests).
