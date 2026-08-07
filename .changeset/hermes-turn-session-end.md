---
"@core0-io/nio": patch
---

Fix `/nio monitor on` silently switching itself off on Hermes.

Hermes fires `on_session_end` at the end of every **turn**, not at the
end of the session — measured on a live install, one continuous run under
a single `session_id` produced 1 `SessionStart` against 6 `SessionEnd`,
interleaved with 7 prompts and 134 tool-call pairs. Nio treated each of
those as a real teardown and deleted the session's arm record, so an
armed Hermes session captured at most one turn and then went silent, with
`monitored-sessions.json` left looking as though the user had never armed
anything.

Nio now ignores `SessionEnd` for arm-record cleanup on Hermes only; the
session span and per-turn state handling are unchanged, and every other
platform still clears its record on session end. As on Codex and
opencode, a Hermes arm is now cleared by `/nio monitor off` or the 7-day
expiry backstop.
