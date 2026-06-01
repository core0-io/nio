---
"@core0-io/nio": patch
---

**Fix: `/nio doctor` and `/nio external-score` no longer self-block under the outer guard.**

The `NIO_SELF_INVOCATION` whitelist still listed only the original six
bundled scripts, so when `doctor-cli.js` / `external-score-cli.js` were
run via a shell-exec tool (e.g. Claude Code's `Bash`) the outer guard
hook skipped the self-invocation short-circuit and ran full Phase 1-6
analysis on the command. Phase 6's external scorer then flagged nio's own
read-only diagnostic commands — whose entire job is to reach those
scoring endpoints — denying them with an `EXTERNAL_SCORE` critical
verdict.

Both scripts are now added to the whitelist regex so they short-circuit
after Phase 0 like the other bundled scripts. Same safety envelope: an
exact `/skills/nio/scripts/<name>.js` path, no shell metacharacters, and
`blocked_tools` (Phase 0) still applies. Unit and integration coverage is
extended to the full eight-script set.
