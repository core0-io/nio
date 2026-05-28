---
"@core0-io/nio": patch
---

**Test isolation + trace pipeline e2e task docs.**

`pnpm test` used to silently pollute `~/.nio/audit.jsonl` on every
run. Integration tests construct `HookAdapter` instances and call
`evaluateHook` without passing `auditOpts`, so `writeAuditLog`
fell back to `resolveAuditPath(undefined)` →
`${NIO_HOME ?? ~/.nio}/audit.jsonl`. Tests never set `NIO_HOME`, so
each test run appended ~100 fake guard entries to the developer's
real audit log, making it unreliable for debugging real activity.

Fix: new tiny `src/tests/helpers/isolate-nio-home.ts` pins
`process.env.NIO_HOME` to a per-process `mkdtempSync()` tmpdir if
not already set. Wired in via `node --import` at the front of the
`test` script in `package.json` — runs once per test process before
any production module is imported. Subprocess-spawning tests
(`hook-cli.test.ts`, `nio-cli.test.ts`) already pass an isolated
`NIO_HOME` via the spawned child's env and are unaffected.

Verified: a full `pnpm test` run no longer adds entries to
`~/.nio/audit.jsonl` (measured the per-platform count delta — 0
new entries).

**Also adds two e2e task docs** for the trace pipeline:

- `e2e-test/hermes-trace-e2e-task.md` — sandbox-isolated
  (`NIO_HOME=$(mktemp -d)`), three benign `terminal` commands,
  verify 4 spans (1 turn root + 3 tool children) reach OTLP under
  `service.name=nio-hermes`. Never touches the user's real
  `~/.nio/` or `~/.hermes/plugins/nio/`.
- `e2e-test/openclaw-trace-e2e-task.md` — sandbox NIO_HOME + parallel
  daemon via `openclaw --profile trace-e2e gateway`, nio plugin
  installed into `~/.openclaw-trace-e2e/` via setup.sh's
  `--openclaw-home` flag. Real launchctl-managed gateway keeps
  running undisturbed.

Each doc's "regression coverage" section names the commits the smoke
pins so future changes can be cross-checked.
