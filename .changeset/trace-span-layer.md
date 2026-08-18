---
"@core0-io/nio": minor
---

Traces now carry a `chat` layer between the turn root and its tool spans:
`invoke_agent UserPromptSubmit` (turn root, as before) → `chat <model>`,
one span per LLM call, reconstructed at turn close from whatever record
the host platform keeps (Claude Code and Codex session files, Hermes's
`post_llm_call` envelope, Pi's session JSONL, OpenClaw's and opencode's
event streams). Each chat span carries the model, its token usage, its
finish reason, and how much its timestamps can be trusted
(`nio.chat.timing`: `exact` / `inferred` / `synthetic`).

Tool spans still export the instant `PostToolUse` fires, so they are
siblings of the chat spans rather than children. Which call issued a tool
is recoverable as data instead of parentage: match the tool span's
`gen_ai.tool.call.id` against the issuing chat span's
`nio.chat.tool_call_ids`.

Consumers building queries or alerts against the previous flat
`turn → tool` shape are unaffected — the turn root is still every tool
span's parent — but a turn now also contains `chat` spans, and span counts
per trace go up accordingly. A platform with no readable conversation
record degrades to the previous shape rather than failing.
