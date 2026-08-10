---
"@core0-io/nio": patch
---

Key the telemetry capture gate to the SESSION's working directory on the
in-process platforms (Pi, opencode, OpenClaw), instead of the host
process's.

Those three load Nio as a module inside one long-running agent process
that serves many sessions, so `process.cwd()` there is a constant fixed
when the host was launched — it says nothing about any individual
session. The monitor gate used it to decide whether a session may claim
the pending arm written by `/nio monitor on`, and the cwd match is what
stops two projects on one machine sharing an arm. The effect was that the
match could not distinguish sessions at all: every session presented the
same directory, so an arm made in one project's session could be consumed
by a session in another, and a session whose directory was not the host's
launch directory could never claim its own arm and stayed silent.

Pi now reports each session's `ctx.cwd`, and opencode its plugin
`directory`; both `/nio monitor on` and the gate use it, so the two sides
of the comparison agree. OpenClaw exposes no per-session directory (a
session there is a conversation, not a checkout) and keeps the process
directory on both sides, unchanged. `nio.cwd` on the exported spans now
also names the session's directory rather than the host's.

`/nio monitor on` additionally resolves symlinks in the directory it
stores, so an arm made in a path under a symlinked parent (every `/tmp`
and `/var` path on macOS) is claimable.

Capture stays off by default, the local audit log stays ungated, and a
session in a directory that does not match a pending arm still cannot
claim it.
