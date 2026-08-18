---
"@core0-io/nio": minor
---

On **Claude Code, Codex and Hermes**, traces now carry a `chat` layer
alongside the turn's tool spans: `invoke_agent UserPromptSubmit` (turn root,
as before) → `chat <model>`, one span per LLM call, reconstructed at turn
close from whatever record the host keeps (Claude Code and Codex session
files, Hermes's `post_llm_call` envelope). Each chat span carries the model,
its token usage, its finish reason, and how much its timestamps can be
trusted (`nio.chat.timing`: `exact` / `inferred` / `synthetic`).

Pi, opencode and OpenClaw are **not** covered yet. Their conversation
sources ship in this release but nothing routes a turn through them, so
those platforms keep the flat `turn → tool` shape until the in-process
runtime is wired up in a following release.

Tool spans still export the instant a tool finishes, so they are siblings
of the chat spans, not children — both hang off the turn root. Which call
issued a tool is recoverable as data instead of parentage: match the tool
span's `gen_ai.tool.call.id` against the issuing chat span's
`nio.chat.tool_call_ids`.

Queries and alerts written against the previous flat shape are unaffected —
the turn root is still every tool span's parent — but a turn on the three
covered platforms now also contains `chat` spans, so span counts per trace
go up accordingly. A turn with no readable conversation record degrades to
the previous shape rather than failing.
