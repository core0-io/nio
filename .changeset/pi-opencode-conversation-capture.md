---
"@core0-io/nio": minor
---

Capture the full conversation on Pi and opencode

Both new platforms now produce the same trace shape the older ones do:
a turn root, one `chat <model>` span per LLM call, and tool spans nested
under the call that issued them — with the prompt, the assistant's reply,
its thinking, and each tool's arguments and result carried on the logs
signal as content records.

Pi reads its session JSONL (`~/.pi/agent/sessions/`), so its thinking
blocks arrive at full fidelity. opencode reconstructs from
`message.updated` / `message.part.updated` and is the **first platform
that reports both ends of an LLM call** (`time.created` + `time.completed`),
so its chat spans carry `nio.chat.timing = exact` rather than the
`inferred` or `synthetic` every other host is limited to.

Nothing is captured until the session is armed with `/nio-monitor on`.
The capture gate, the lazy provider construction behind it, and the
content pipeline all moved into the shared `InProcessPluginRuntime`, so
OpenClaw, Pi and opencode are governed by one implementation instead of
three. Provider construction now happens on first monitored use rather
than at plugin registration: an operator who never arms a session never
has an OTLP client stood up in their process.

**Behaviour change — Pi and opencode tool spans now go out at turn
close, not at tool completion.** That is what buys the nesting: the span
has to wait until the transcript says which LLM call issued it. The
price is crash-resilience — the in-process platforms hold turn state in
memory with no `traces-state-store-<session>.json` to replay, so tool
spans from a turn interrupted by a hard kill are lost rather than
partially exported. Two things deliberately do not wait: a `deny`
decision is still exported immediately, and the local `audit.jsonl` is
written as events happen, independent of the monitor gate. OpenClaw
keeps its eager per-tool export, because its source cannot reconstruct
`tool_use` and deferring would cost crash-resilience for no structural
gain.
