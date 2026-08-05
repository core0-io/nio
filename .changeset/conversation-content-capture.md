---
"@core0-io/nio": minor
---

**A monitored session now exports conversation content, not just audit
metadata.** This is the biggest privacy-relevant change in this release —
read it before arming `/nio-monitor` against an endpoint you don't fully
trust.

When a session is armed, the logs signal carries the model's reasoning
("thinking"), its reply text, tool arguments, and tool output — each
redacted for known secret shapes (API key prefixes, AWS keys, GitHub
tokens, JWTs, PEM blocks, `Authorization` headers) and then truncated to a
per-kind cap: thinking and reply text ≤64 KB each, tool arguments ≤16 KB,
tool output ≤32 KB. These are new `collector.content_limits` config keys
(all overridable, `0` = uncapped) and none of it touches the local
`~/.nio/audit.jsonl` — content records are OTLP-only. The turn span itself
also now carries the redacted user prompt verbatim (`nio.turn.user_prompt`,
≤2 KB) and per-call content-length counters
(`nio.content.thinking_chars` / `nio.content.text_chars`) on each `chat`
span.

None of this is new capture surface for an *unarmed* session — it stays
exactly as silent as before. It is new for anyone who has already armed
`/nio-monitor` or set `collector.monitor_all_sessions: true`: your
outbound OTLP traffic now includes prose, not just verdicts and counters.
See `docs/COLLECTOR-SIGNALS.md`'s "Content records" section and the
`nio-monitor` skill's "Scope of Capture" for the full attribute list and
redaction details.
