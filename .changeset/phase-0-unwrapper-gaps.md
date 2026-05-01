---
"@core0-io/nio": patch
---

**Phase 0 unwrapper — close two indirect-channel gaps** (`bash <(echo "...")`
and `echo X | xargs CMD`) that emitted only audit-only D16 hits and slipped
through `permitted_tools.mcp` / `blocked_tools.mcp` policies.

Both surfaced when the user ran the e2e mcp-detection task — Steps 29 and 31
came back ALLOW where the spec said DENY, even though the tools were
explicitly listed in the policy.

| Gap | Pre-fix | Fix |
|-----|---------|-----|
| **U5 process-sub + echo decode**: `bash <(echo "curl URL ...")` extracted only `echo "..."`. D2 saw `echo`, not `curl`, didn't fire. Only D16 obfuscation_fallback hit the URL substring → audit-only → filtered out before the deny gate. | When `<(...)` is preceded by a shell-execution binary (`bash`/`sh`/`zsh`/`dash`/`ksh`/`busybox`/`source`/`.`) AND the inner is `echo "X"` / `printf "X"`, also emit X as a fragment. The substituted output IS the command being executed by the shell consumer. |
| **U11 xargs feeder synthesis**: `echo URL \| xargs curl -d ...` extracted only `curl -d ...` — without the URL. D2 walked tokens, found curl, but `parseCurlArgs` returned `url: undefined` because the URL token (xargs would've appended it from stdin) was missing. Same downstream: D16 audit-only → filtered → ALLOW. | When `xargs CMD` has a pipe-upstream feeder of the form `echo X` / `printf X`, also emit `CMD X` as an extra fragment so detectors see the appended arguments xargs would deliver. |

Conservative scope: only `echo`/`printf` feeders. Other potential xargs
feeders (`cat FILE`, `seq`, `find -print0`) need file/process modeling and
are deferred until real-world traffic shows them.

Tests: +7 unit tests in `unwrappers.test.ts` (U5 echo decode + regression
`bash <(curl X)` / negative `tee >(echo X)` / negative `bash >(echo X)`; U11
feeder synthesis for echo + printf + regression). +2 integration tests
locking in the user's audit Steps 29 / 31 deny under denylist mode.

Docs: Stage 1 U5 / U11 rows in `docs/phases/phase-0-tool-gate.html` and the
matching prose in `plugins/shared/skill/SCAN-RULES.md`.
