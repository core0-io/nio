---
"@core0-io/nio": minor
---

**A monitored session now exports conversation content, not just audit
metadata.** This is the biggest privacy-relevant change in this release —
read it before arming `/nio-monitor` against an endpoint you don't fully
trust.

When a session is armed, nio now captures the model's reasoning
("thinking"), its reply text, tool arguments, and tool output. Each body
is redacted for known secret shapes (API key prefixes, AWS keys, GitHub
tokens, JWTs, PEM blocks, `Authorization` headers) and then truncated —
in that order, so a secret straddling the cut point cannot survive as a
half-credential.

Placement is by **size**, not by kind. A body under 2 KB rides its span:
the reply on `nio.chat.reply`, tool arguments on
`gen_ai.tool.call.arguments`, so the trace reads without a log join. A
body over that goes to the logs signal at full fidelity, and the span
keeps a preview flagged `nio.content.truncated`. Every body has one
owner — a body the span carries in full produces no log record at all,
and one that overflows produces exactly one, alongside the truncated
span preview. Thinking and tool output are always logs-side. The logs-side
caps are the new `collector.content_limits` config keys — thinking and
reply text ≤64 KB each, tool arguments ≤16 KB, tool output ≤32 KB, all
overridable, `0` = uncapped. None of this touches the local
`~/.nio/audit.jsonl`: content records are OTLP-only.

The user prompt and assistant reply on the turn span
(`nio.turn.user_prompt` / `nio.turn.assistant_reply`) are now scanned for
secrets in free text too. They previously went through a redactor that
only inspects JSON key names, so a credential pasted into a prompt passed
straight through it — and because that redactor truncates by character
count, a PEM block straddling its 2048-character cut would have lost the
`-----END …-----` marker that makes it recognisable. The scan runs first,
so the block is replaced before anything can cut it.

Content is captured on all six hosts. The pipeline above describes the
hook-driven ones (Claude Code, Codex, Hermes); OpenClaw, Pi and opencode
run the same pipeline through the shared in-process runtime, with one
residual difference documented in "Capture the conversation on OpenClaw,
Pi and opencode too".

None of this is new capture surface for an *unarmed* session — it stays
exactly as silent as before. It is new for anyone who has already armed
`/nio-monitor` or set `collector.monitor_all_sessions: true`: your
outbound OTLP traffic now includes prose, not just verdicts and counters.
See the `nio-monitor` skill's "Scope of Capture" for the full list.
