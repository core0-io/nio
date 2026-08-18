---
"@core0-io/nio": minor
---

Capture the conversation on OpenClaw, Pi and opencode too

The three in-process hosts now produce the same trace and content shape
the hook-driven ones already did. A monitored turn there carries
`invoke_agent` (turn root) → one `chat <model>` span per LLM call,
reconstructed at turn close, plus the model's reply and each tool's
arguments and result on the logs signal as content records — redacted for
secret shapes in free text, then truncated, then placed by size (under
2 KB on the span, larger bodies in the logs signal at full fidelity under
`collector.content_limits`). Reasoning ("thinking") follows what the host
publishes: Pi and opencode expose reasoning blocks and emit them, OpenClaw
publishes reasoning to no hook Nio subscribes to and produces no thinking
record.

Each host is reconstructed from what it actually keeps: Pi replays its
session JSONL under `~/.pi/agent/sessions/`; opencode rebuilds from the
`message.updated` / `message.part.updated` snapshots it publishes, and is
the one host that reports both ends of an LLM call, so its chat spans
carry `nio.chat.timing = exact`; OpenClaw rebuilds from its `llm_output`
event stream, whose timestamps are synthesised, so its chat spans are
`nio.chat.timing = synthetic`.

**Tool spans are unchanged and stay siblings of the chat spans** — every
tool span is still exported the moment the tool finishes and still hangs
off the turn root, so a long turn stays visible while it runs and a
crash mid-turn does not take the completed tool spans with it. Which
call issued a tool remains recoverable as data rather than parentage:
match `gen_ai.tool.call.id` on the tool span against
`nio.chat.tool_call_ids` on the chat span.

**Two differences from the hook-driven hosts, both deliberate.**

Their tool spans carry `gen_ai.tool.call.arguments` and
`gen_ai.tool.call.result` capped at 2048 characters and redacted by JSON
key name only, so a secret in a command string or in tool output is
removed from the new content record but still rides that span attribute.
No hook-driven host puts a tool result on a span at all. Closing that gap
means changing an attribute helper shared with the hook path, which is
out of scope here.

And the one-owner size rule does not hold there: `tool_input` /
`tool_output` records are emitted unconditionally rather than only when
the body overflowed the span budget, so a small tool body is sent twice.
These hosts keep turn state in memory with nothing on disk to replay, so
the log record — emitted as the call happens — is the copy that survives
a mid-turn crash or a mid-turn `off`, and a call the guard denies
contributes its arguments for the same reason.

Queries written against the previous flat shape are unaffected — the
turn root is still every tool span's parent — but a turn on these three
hosts now also contains `chat` spans, so span counts per trace go up.
A turn with no readable conversation record degrades to the previous
shape rather than failing. Nothing is captured until the session is
armed; the local `audit.jsonl` is unchanged and carries no content.
