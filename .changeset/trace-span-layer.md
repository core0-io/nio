---
"@core0-io/nio": minor
---

Traces now have a three-layer span model instead of a flat turn: `session`
(one per host session, its own trace, linked from every turn by span link)
⇢ `invoke_agent UserPromptSubmit` (turn root, as before) → `chat <model>`
(one per LLM call, reconstructed from the platform's conversation data at
turn close) → `execute_tool <name>` (nested under the chat call that issued
it, when that attribution is knowable). Consumers building queries or
alerts against the previous flat `turn → tool` shape should account for
the new `chat` layer in between on Claude Code, Codex, and Hermes — the
tool span's parent is no longer always the turn root. OpenClaw is a
documented exception: `chat` and `execute_tool` stay siblings there (see
`docs/COLLECTOR-SIGNALS.md`).

A second, related change: on Claude Code, Codex, and Hermes, finished tool
spans are no longer exported the instant `PostToolUse` fires. They're held
until the turn closes (`Stop` / `SubagentStop` / `SessionEnd`) so they can
be nested under the right `chat` span, then the whole tree is exported
together. **Backends will see tool spans arrive later and in a different
order than before** — batched at turn end instead of streaming in as tools
run. The guard's deny/confirm-denied span is the one exception and still
exports immediately, since a blocked action is a security event that
shouldn't wait on the turn. If the host process crashes before the turn
closes, the parked tree is flushed by the next hook event or `SessionStart`,
tagged `nio.turn.incomplete: true`.

MCP tool calls (`mcp__<server>__<tool>`) now also carry their own
`nio.mcp.server` / `nio.mcp.tool` dimensions on the tool span, split out
from the raw tool name, so "how much of this agent's work goes through
MCP" and "which server is slow" are queryable without string-matching.
