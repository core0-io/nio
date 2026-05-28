# @core0-io/nio

## 2.4.2

### Patch Changes

- ff53ac9: **Deny-path trace span emission + allow-path guard-attrs parity across platforms.**

  Before this change, when the guard blocked a tool call (`risk_score=1`, any deny threshold crossed, or tool-gate hit), the audit log and `nio.decision.count` metric captured the verdict — but **no `execute_tool` span ever reached OTLP traces**. Reason: spans were opened in `PreToolUse` and closed in `PostToolUse`; on deny, `PostToolUse` never fires, so the span sat orphaned in the state file. Trace UIs were silently missing exactly the events most worth investigating.

  OpenClaw already handled this correctly via its in-memory `pendingGuardAttrs` bridge; this change brings claude-code, codex, and hermes to parity, and adds three new attributes everywhere.

  **What changes on a deny / confirm-denied call:**

  ```text
  Trace span: execute_tool Bash       ← same name as allow; discrimination via attrs + status
    status:       ERROR                 (reason in span.exception message)
    start / end:  real evalStartMs → end-of-guard       (not a ~0ms synthesized span)
    attributes:
      gen_ai.tool.name              = "Bash"
      gen_ai.tool.call.id           = "<tool_use_id>"
      gen_ai.tool.call.arguments    = redacted JSON
      nio.tool_summary              = "rm -rf /"
      nio.platform / nio.turn_number / nio.cwd
      nio.guard.decision            = "deny"
      nio.guard.risk_level          = "critical"
      nio.guard.risk_score          = 1
      nio.guard.risk_tags           = "BASH_RMRF"
      nio.guard.phase_stopped       = 2          ← new
      nio.guard.top_finding_rule    = "BASH_RMRF" ← new
      nio.guard.eval_ms             = 47          ← new
  ```

  **Allow spans now carry the same `nio.guard.*` set** (decision = `allow` / `confirm_allowed`). Previously this was OpenClaw-only — claude-code, codex, and hermes recorded the guard decision in metrics + audit log but never on the tool span itself, so trace UIs couldn't filter "all high-risk allow calls." Now they can.

  **Cross-process plumbing.** Claude Code and Codex run guard-hook (PreToolUse, sync) and collector-hook (PostToolUse, separate process); they can't share an in-memory map. A new `pending_guard_attrs` field on `CollectorState` bridges via the existing on-disk state file: guard-hook parks the attrs on every decision, collector-hook PostToolUse drains and merges them into the closing span. Hermes runs as a single dispatcher and openclaw as an in-process daemon, so they use simpler in-process paths.

  **New API surface (internal):**

  - `HookOutput`: optional `phaseStopped?: number` + `topFindingRule?: string`. Plumbed from `ActionDecision` through `runtimeDecisionToHookOutput` for runtime denies (`phase_stopped` = 1–6) and from the early tool-gate path with `phase_stopped: 0`.
  - `nioGuardAttributes(decision, riskLevel, riskScore, riskTags?, phaseStopped?, topFindingRule?)`: two new optional params; backwards-compatible.
  - `recordPreToolUse(state, key, name, summary, attrs?, startMs?)`: optional `startMs` override so deny-path emission stamps the real eval-start time onto the span.
  - `setPendingGuardAttrs` / `takePendingGuardAttrs`: new helper pair on `traces-collector` for the disk-backed bridge between separate hook processes.
  - `CollectorState.pending_guard_attrs?: Record<spanKey, Record<string, unknown>>`: new state-file field; reset by `ensureTurn` / `endTurn` alongside `pending_spans`.

  **Span name decision.** `execute_tool <toolName>` for both allow and deny, matching gen_ai semantic conventions. Filtering allow vs deny is via `nio.guard.decision` + span status — not via name suffix — so the same span name aggregates across attempts of the same tool.

  **Genuinely missing from a deny span** (acceptable — the tool didn't run):

  - `gen_ai.tool.call.result` (no output)
  - `nio.tool.duration_ms` (no tool execution wall-clock — replaced by `nio.guard.eval_ms` which measures the guard evaluation window instead)

  **Tests added (14, full suite 1093/1093 green):**

  - `nioGuardAttributes` extended cases (`phase_stopped` = 0/non-zero/undefined, `top_finding_rule`)
  - `recordPreToolUse` honours caller-supplied `startMs` + falls back to `Date.now()` when omitted
  - `setPendingGuardAttrs` / `takePendingGuardAttrs` lifecycle (set / take / preserve siblings / drain on absent key / no mutation of input state)
  - `ensureTurn` resets `pending_guard_attrs` on new turn
  - collector-core PostToolUse drains `pending_guard_attrs` and merges them into the closing span (end-to-end with `InMemorySpanExporter`)
  - Deny-path one-shot span emit produces ERROR status + full deny attribute set + real wall-clock from `evalStartMs` (end-to-end)
  - Smoke regression: guard-hook deny path doesn't crash when no collector is configured (tracerProvider/loggerProvider stay null)

  **Docs updated:**

  - `docs/COLLECTOR-SIGNALS.md`: `nio.guard.*` attribute rows flipped from "OpenClaw only" to "all"; new attribute rows added; deleted the "Claude Code adoption queued as follow-up" note; new paragraph documenting the deny / confirm-denied synchronous emission contract.
  - `docs/ARCHITECTURE.md`: Claude Code box updated to show guard-hook's new TracerProvider responsibilities (synchronous deny-span emission + `pending_guard_attrs` bridge to collector-hook).

  **Files touched:**

  - `src/adapters/types.ts`, `src/adapters/hook-engine.ts` — HookOutput extension + plumbing
  - `src/scripts/lib/traces-collector.ts` — `nioGuardAttributes` signature, `recordPreToolUse` `startMs` param, `setPendingGuardAttrs` / `takePendingGuardAttrs` helpers
  - `src/scripts/lib/traces-state-store.ts` — `pending_guard_attrs` field + ensureTurn / endTurn reset
  - `src/scripts/lib/collector-core.ts` — PostToolUse handler drains the bridge
  - `src/scripts/guard-hook.ts` — tracerProvider setup + deny-emit + per-decision bridge write
  - `src/scripts/hook-cli.ts` — hermes pre_tool_call: time eval, set bridge, deny-emit
  - `src/adapters/openclaw-plugin.ts` — time eval, pass new fields, add `nio.guard.eval_ms`

- f335650: **Hermes trace pipeline — five bug fixes for end-to-end span delivery.**

  Hermes was silently dropping every `execute_tool` span before this
  release — only the `invoke_agent UserPromptSubmit` root reached
  OTLP backends, child tool spans never showed up. Five distinct
  bugs along the path; fixing only one in isolation wouldn't have
  restored the pipeline.

  **1. ESM sentinel beside bundled CLIs (commit `97fe3a5`).** Bun
  emits the hook-cli / guard-hook / nio-cli bundles as ESM (`import` at
  the top) but writes them with a `.js` extension. Node walks up from
  the script file to the nearest `package.json` to decide ESM vs CJS,
  and the install dirs (`~/.hermes/plugins/nio/scripts/`, the Claude
  Code plugin cache, etc.) have no parent declaring `"type": "module"`.
  So every hook invocation crashed with:

  ```text
  SyntaxError: Cannot use import statement outside a module
  ```

  Fix: `scripts/build.js` writes a minimal `{"type":"module"}` to
  `package.json` beside each bundle output dir; `plugins/hermes/setup.sh`
  explicitly copies the sentinel alongside the two CLIs (its install
  flow copies individual files, not a recursive directory).

  **2. `provider.getTracer()` instead of global `trace.getTracer()`
  (commit `7818cb7`).** Bun's single-file bundle ships two physical
  copies of `@opentelemetry/api` (one direct, one via
  `@opentelemetry/sdk-trace-node`). `provider.register()` writes the
  global to API-instance A; `trace.getTracer()` reads from API-instance
  B and gets a no-op tracer. Spans get `.startSpan()`/`.end()`/
  `.forceFlush()`'d silently — never reach `SimpleSpanProcessor`, never
  reach `OTLPTraceExporter`, no `TraceService/Export` RPC fires.

  Fix: three call sites in `traces-collector.ts` (`recordPostToolUse`,
  `recordPostTaskToolUse`, `endTurn`) now use `provider.getTracer(...)`
  directly with the locally-passed `NodeTracerProvider`, bypassing the
  global registry entirely.

  **3. Pending state migration on session-id promotion (commit
  `8bc988b`).** Hermes's `pre_tool_call` shell-hook payload sometimes
  arrives with `session_id=""` while the matching `post_tool_call`
  carries the real session id. `ensureTurn()` was treating that as a
  session change between the two hook-cli subprocess invocations,
  wiping `pending_spans` mid-flight. Post then couldn't find the
  pre's entry and `recordPostToolUse` early-returned.

  Fix: when previous state was on a sentinel session (`""` or
  `"unknown"`) and a real session arrives, migrate `pending_spans` +
  `pending_guard_attrs` into the new turn instead of resetting.

  **4. Non-deterministic `turn_trace_id` + sentinel passthrough
  (commit `58a4242`).** `turn_trace_id` was derived from
  `MD5(session_id + ":" + turn_number)`. Identical (session, turn)
  combinations produced identical 32-char hex forever, so a Hermes
  session at turn N today derived the same trace id as turn N
  yesterday — yesterday's span ids appeared stitched into today's
  trace tree. Worse, the session-promotion fix in #3 was incorrectly
  resetting `turn_number` to 1 each time, so every promoted turn
  across one entire Hermes session re-derived `MD5(real:1)` and
  collapsed onto a single trace id.

  Fix (two parts):

  - `turn_trace_id` is now a fresh 16-byte random hex per turn,
    generated in `ensureTurn` and persisted to the state file. PRE/POST
    processes share it via state-file load rather than re-deriving.
  - `ensureTurn` ignores sentinel `session_id` when prev holds a real
    session — falls back to `prev.session_id` and continues the
    current turn instead of resetting.

  **5. Composite spanKey fallback for Hermes pre/post asymmetry
  (commit `42f194c`).** Hermes's `pre_tool_call` doesn't carry
  `tool_call_id` while `post_tool_call` does (the asymmetry is at
  `agent/agent_runtime_helpers.py invoke_tool()` —
  `get_pre_tool_call_block_message()` is called without threading the
  in-scope `tool_call_id`). Old `spanKey()` used
  `tool_use_id || ${tool_name}:${Date.now()}` as key — pre saved under
  a random timestamp-based key, post looked up the real
  `tool_use_id`, lookup missed.

  Fix:

  - `spanKey()` fallback is now DETERMINISTIC —
    `${tool_name}:${tool_summary}` instead of `${tool_name}:${Date.now()}`.
  - New `resolveSpanKey()` in collector-core's `PostToolUse` path
    tries the primary spanKey first, then the composite fallback if
    the primary missed. Handles asymmetric platforms where pre's
    spanKey is the composite but post's is the real tool_use_id.

  **End-to-end verified** against the bundled `~/.hermes/plugins/nio/scripts/hook-cli.js`
  with an OTLP HTTP sink intercepting the wire payload. Two
  consecutive turns under one Hermes session produce 4 spans each
  (1 turn root + 3 tool children) with distinct trace ids and
  correct parent-child structure.

- f335650: **Promote `nio.platform` + `gen_ai.agent.name` to OTel resource attributes.**

  Three telemetry-identity attributes were previously per-span (or
  per-log) attributes only, making them invisible as top-level
  dimensions in most OTLP backends:

  ```text
  Before:
    service.name      = "nio"          (shared across all four platforms)
    nio.platform      = span attribute (each tool span)
    gen_ai.agent.name = on turn span + log records only
  ```

  After this release, all three live on the OTel `Resource` that every
  provider (tracer / logger / meter) constructs — so every signal nio
  emits (every span, log record, metric data point) carries them
  automatically at the resource level. SigNoz and similar backends
  surface resource attributes as primary service selectors / filter
  columns:

  ```text
  After:
    service.name      = "nio-<platform>"     (nio-hermes / nio-openclaw / nio-claude-code / nio-codex)
    nio.platform      = "<platform>"         (raw value, no parsing)
    gen_ai.agent.name = "<configured value>" (only when user set agent_name)
  ```

  Provider factory signatures all gain `(platform: string, agentName?: string)`:

  ```ts
  createTracerProvider(config, platform, agentName?)
  createLoggerProvider(config, platform, agentName?)
  createMeterProvider(config, platform, agentName?)
  ```

  A shared `buildNioResource(platform, agentName?)` helper in
  `traces-collector.ts` is the single source of truth.

  Threaded through every provider call site:
  `src/scripts/guard-hook.ts`, `src/scripts/collector-hook.ts`,
  `src/scripts/scanner-hook.ts`, `src/scripts/hook-cli.ts`
  (runHermesCollector + pre_tool_call branch), `src/adapters/openclaw-plugin.ts`.

  `agent_name` is read from config and passed only when configured;
  empty/unset means "no `gen_ai.agent.name` on the resource". The
  span-level fallback used by `endTurn()` still defaults to platform
  for unconfigured users, so the turn-span behaviour is unchanged.

  **Breaking change**: `service.name` changes from `"nio"` to
  `"nio-<platform>"`. Existing SigNoz / Grafana / Datadog dashboards
  filtered on `service.name="nio"` will not match new data — re-target
  to `service.name=nio-*` (wildcard) or filter on
  `nio.platform` instead. Historical data is unaffected.

- f335650: **Test isolation + trace pipeline e2e task docs.**

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

## 2.4.1

### Patch Changes

- f19f260: **`agent_name` config field — telemetry identity alias.**

  Adds an optional top-level `agent_name` field to `~/.nio/config.yaml`. When set, it overrides the platform-derived value on `gen_ai.agent.name` in **traces** and **log records**, and lands as the `agent_name` field in `~/.nio/audit.jsonl`. Use it to split telemetry by deployment / machine / user when multiple installations share a collector backend ("alice-laptop", "ci-runner-3", "prod-scoring-east").

  ```yaml
  # ~/.nio/config.yaml
  agent_name: "alice-laptop"
  ```

  After:

  ```text
  trace span attributes:
    nio.platform        = "claude-code"        ← underlying CLI host
    gen_ai.agent.name   = "alice-laptop"       ← operator alias

  audit.jsonl line:
    { "event": "guard", "platform": "claude-code", "agent_name": "alice-laptop", ... }
  ```

  When `agent_name` is empty / unset, behaviour is identical to before (`gen_ai.agent.name` falls back to platform; audit entries omit the `agent_name` field). `nio.platform` is never overridden — the two axes are independent so backends can slice on host AND deployment.

  **Metrics intentionally not extended.** Adding `gen_ai.agent.name` as a metric label would multiply every (metric × agent) combination into a separate time series and inflate the backend's cardinality budget. Query `nio.platform` for host-level metric slicing.

  Plumbing changes:

  - `NioConfigSchema`: optional top-level `agent_name: string`.
  - `genAiInvokeAgentAttributes(sessionId, agentName, extra?)`: signature renamed (`platform` → `agentName`); function no longer re-aliases platform.
  - `endTurn(provider, state, platform, agentName, cwd, transcriptPath?)`: new `agentName` parameter inserted between platform and cwd.
  - `dispatchCollectorEvent` options: new optional `agentName: string`.
  - `auditEntryAttributes`: emits `gen_ai.agent.name` when entry carries `agent_name`.
  - `buildGuardAuditEntry`: new trailing optional `agentName` parameter.
  - Audit log entry types (`AuditGuardEntry`, `AuditScanEntry`, `AuditLifecycleEntry`, `AuditHookEntry`): optional `agent_name?: string`.
  - Hook entrypoints (`guard-hook`, `collector-hook`, `scanner-hook`) read `agent_name` from config and thread it through; `lib/config-loader.ts` exports a new `loadAgentName()` lightweight helper.

  11 new tests in `agent-name.test.ts` cover schema acceptance, the trace attribute helper, log attribute emission (set / empty / absent), and audit entry shape (set / unset / empty). Full suite 1079/1079 green.

## 2.4.0

### Minor Changes

- 253c0e5: **Install-time operator-config support + setup-flag rename.**

  Two changes ship together; both touch every `setup.sh` (the four per-plugin scripts, the root dispatcher, and `install.sh`).

  ### `--config <path>` (new)

  Operators can now hand a pre-tuned `~/.nio/config.yaml` to a user and have it applied during install in a single step instead of "download then manually copy":

  ```bash
  curl -fsSL https://core0-io.github.io/nio/install.sh | bash -s -- --config /path/to/nio.yaml
  # or post-clone
  ./setup.sh --config /path/to/nio.yaml
  ```

  The flag goes through the same code path as the `/nio config import <path>` slash command (Phase 1 of this work): schema validation → full `/nio doctor` probe suite against the **incoming** config (external_analyser reachability, OAuth token fetch, LLM key sanity, collector connectivity) → only if every probe passes does the overwrite proceed → previous file preserved as `config.yaml.bak.<ISO-stamp>`. If any probe fails, the install aborts non-zero and the live config is not touched.

  The path is local-file only (no URL fetching — the install host is the one that has to be able to reach the analyser/collector endpoints during the doctor probe). `NIO_CONFIG=<path>` env var works as a fallback when the flag isn't given. `install.sh` resolves the path to absolute before forwarding to the extracted setup.sh so the path still resolves from `/tmp/nio-install-XXXXXX/`.

  ### `--reset-config` → `--reset-to-defaults` (BREAKING)

  The old `--reset-config` flag is renamed to `--reset-to-defaults` to remove the ambiguity introduced by `--config <path>` (both contain the word `config`; they do very different things — reset to bundled template vs. apply a file). There is **no compat alias**: the old name now errors as `Unknown option: --reset-config`. Anyone with `--reset-config` in CI scripts, install playbooks, or muscle memory needs to switch.

  The pair now reads cleanly: `--reset-to-defaults` (what state we reset _to_) vs `--config <path>` (what file we read _from_). They are mutually exclusive — passing both errors at arg-parse time.

  ### Other notes

  - `/nio config import <path>` slash command also ships in this release with the same doctor-gate semantics (Phase 1).
  - `handleDoctor()` in `src/adapters/openclaw-dispatch.ts` was refactored into a thin wrapper over `runDoctor(configOverride?)` that returns `{ ok, report }`, so the import path and the live `/nio doctor` command share the exact same probe logic.
  - 17 new tests across `dispatch-config-import.test.ts` (11 cases) and `config-cli.test.ts` (4 import cases + 2 rename cases). Full suite 1068/1068 green.

## 2.3.7

### Patch Changes

- **`approve_hook` finally works when `hermes` is a bash wrapper.** 2.3.6 still
  failed silently on the user's VPS where `hermes` is `#!/usr/bin/env bash` —
  the shebang-sniff gave us `/usr/bin/env`, which got handed to the Python
  heredocs and immediately exited; both strategies appeared to "return without
  writing", with no stderr to show what happened.

  Three fixes:

  1. **Python discovery with import validation.** Each candidate now has to
     actually `import agent.shell_hooks` (or `import yaml`, depending on
     strategy) before we trust it. Search order:

     - shebang sniff of `hermes` (works for real Python `hermes` scripts)
     - **parse the wrapper itself** for `exec /path/to/python …` lines —
       this catches uv-tool / pipx / venv-activator style wrappers no
       matter where their venv lives (no hardcoded path guessing needed)
     - known fallback layouts under `~/.hermes/{,hermes-agent/}venv/bin/python{,3}`

  2. **Strategy 2 (direct allowlist write) uses `$INSTALL_PY`**, not the
     Hermes-specific Python. Direct write only needs yaml + stdlib; any
     working Python (including system `/usr/bin/python3` on Ubuntu) works.
     `$INSTALL_PY` was already validated against `import yaml` at the top
     of `setup.sh`, so this strategy now always has a working interpreter
     even when no Hermes-API-capable Python can be found.

  3. **Captured exit codes + unbuffered stderr.** The Python invocations no
     longer end in `|| true` — we capture `strategy1_rc` and `strategy2_rc`
     and surface them in the final error message. `python -u` keeps stderr
     live so any Python-side error message survives to the user's terminal
     instead of being lost mid-buffer.

  A new diagnostic banner prints up-front which Python each strategy
  resolved to, so the next failure mode (whatever it is) immediately tells
  you whether interpreter discovery was the issue.

  Smoke-tested against a fixture mirroring the user's VPS (bash-wrapper
  `hermes` + pre-existing non-Nio allowlist entry): strategy 2 writes 7 Nio
  entries + preserves the 1 non-Nio entry, schema verified end-to-end.

## 2.3.6

### Patch Changes

- **`approve_hook` actually approves now, even when Hermes's API doesn't.**
  On the user's Hermes version (and likely others), calling
  `register_from_config(cfg, accept_hooks=True)` from a fresh Python process
  returns `0` without ever writing `~/.hermes/shell-hooks-allowlist.json` —
  even though the same function works at Hermes-own startup. 2.3.5 surfaced
  this with a loud error; 2.3.6 fixes it.

  We read `agent/shell_hooks.py` in a real Hermes install to learn the
  allowlist schema:

  ```json
  {"approvals": [
    {"event": "...", "command": "...",
     "approved_at": "ISO8601Z",
     "script_mtime_at_approval": "ISO8601Z" | null}
  ]}
  ```

  One entry per `(event, command)` pair; JSON dumped with `indent=2,
sort_keys=True`; atomic write via `tempfile.mkstemp` + `os.replace`;
  `fcntl.flock` on the sibling `.lock` file for cross-process safety.

  `approve_hook`'s strategy 2 (previously: probe `hermes hooks accept/
approve/...` subcommands that don't exist on any known Hermes version)
  is replaced with a direct allowlist write that mirrors Hermes's own
  `_record_approval` exactly:

  - **Merge-safe**: any pre-existing approvals (e.g. from other hook
    handlers the user has approved) are preserved untouched.
  - **Idempotent**: existing `(event, command)` matches are dropped
    and re-added with fresh `approved_at` + current script mtime
    (same "filter-then-append" rule Hermes uses).
  - **Locked**: `fcntl.flock` on the `.lock` sibling so a concurrent
    `hermes` process can't clobber the file mid-write.
  - **Atomic**: mkstemp + `os.replace`, no half-written file possible.

  Strategy 1 (`register_from_config`) still runs first; if it writes the
  file on a given Hermes version, great — strategy 2 is skipped via the
  verify-after check.

  Smoke-tested three scenarios with the actual schema:

  1. Fresh install (no allowlist file) → 7 Nio entries written.
  2. Pre-existing `/usr/bin/other-hook` approval → preserved + 7 added.
  3. Stale Nio entries + non-Nio approval → stale refreshed (new
     `approved_at`), non-Nio preserved, total stays 8.

  `hermes hooks doctor` should now show ✓ for every event after a clean
  `curl … | bash` install with `y` at the consent prompt.

## 2.3.5

### Patch Changes

- **Two install-time UX bugs.** Both surfaced on a real Ubuntu install where
  the user pressed `y` at the consent prompt, saw "Hooks approved", and then
  `hermes hooks doctor` showed every event **not allowlisted**; and where
  the user's Ubuntu had a stale `~/.claude` directory (no `claude` binary)
  that auto-detect still treated as "Claude Code installed".

  | Gap                                                                                                                                                                                                                                                                                                                 | Pre-fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Fix |
  | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- |
  | **False-success in `approve_hook`**: `register_from_config(accept_hooks=True)` returned 0 on the user's Hermes version without actually writing `~/.hermes/shell-hooks-allowlist.json`. The bash `if` saw exit code 0 and printed `Hooks approved. Verify with: hermes hooks doctor` — but the allowlist was empty. | `approve_hook` is now multi-strategy with **verify-after-each**. Strategy 1: `register_from_config()` via Hermes's venv Python, with the config read directly through `yaml.safe_load("$HERMES_CONFIG")` (not Hermes's `load_config()`, which on some versions caches or reads a different path). Strategy 2: probes `hermes hooks accept` / `approve` / `allowlist add` / `add` for an existing subcommand and invokes whichever exists once per unique Nio command string. After every strategy, the bash side reads `shell-hooks-allowlist.json` and checks for our `hook-cli.js` signature. `Hooks approved` is only printed on real success; total failure prints a loud multi-line error with concrete workarounds and returns non-zero so `APPROVED=1` is set only when the allowlist was actually written. |
  | **Dir-only auto-detect**: `install.sh` checked `[ -d "$HOME/.<agent>" ]` only — stale leftover dirs from uninstalled agents were treated as "installed". User got Claude Code install/uninstall runs they didn't ask for.                                                                                           | Auto-detect now requires both the dir AND the CLI binary on `PATH`. Dir-only matches print a warning and get skipped: `~/.claude is here but 'claude' isn't on PATH`. Users can still force-install with `--platform NAME`. The empty-detect error message also mentions the `~/.local/bin` PATH gotcha, since "I installed Hermes but PATH isn't refreshed yet" is the typical Ubuntu trip.                                                                                                                                                                                                                                                                                                                                                                                                                       |

  If you're hitting the `approve_hook` symptom, this release will at minimum
  **tell you** when the allowlist write failed (instead of pretending it
  worked). If your Hermes has an approval CLI command the install script
  hasn't probed yet, the error message asks for `hermes hooks --help` output
  so we can add it as a strategy.

## 2.3.4

### Patch Changes

- **Hermes hooks survive past install (the step 2 fix).** Under release /
  `curl | bash`, `install.sh` creates `WORK_DIR=$(mktemp -d -t nio-install-XXXXXX)`,
  unpacks the Hermes plugin into `$WORK_DIR/hermes/`, runs `setup.sh`, then
  deletes `$WORK_DIR` via its EXIT trap. `setup.sh` was writing
  `node $SCRIPT_DIR/scripts/hook-cli.js …` into `~/.hermes/config.yaml` —
  which under the one-liner is exactly that ephemeral tmp path. By the time
  `hermes hooks doctor` (or the runtime itself) looked for the file, it
  was already gone, hence the **`script missing or not executable`** error
  on every event.

  `setup.sh` now distinguishes two paths:

  - **`HOOK_CLI_INSTALL`** — where the bundled `hook-cli.js` exists _now_
    (`$SCRIPT_DIR/scripts/hook-cli.js` under release, or
    `$REPO_ROOT/plugins/claude-code/skills/nio/scripts/hook-cli.js` under
    monorepo dev). Used as the `cp` source.
  - **`HOOK_CLI_REGISTERED`** — the path written into `config.yaml`.
    `$PLUGIN_DST/scripts/hook-cli.js` (i.e. `~/.hermes/plugins/nio/scripts/hook-cli.js`)
    under release — a persistent location that survives the installer
    exit. Identical to `HOOK_CLI_INSTALL` under monorepo dev where the
    source is already stable.

  Execution reordered to a 3-phase block so the stable file lands at the
  moment `install-hook.py` writes it into `config.yaml`:

  1. **install** case → `install_python_plugin` first (copies
     `hook-cli.js` into `HOOK_CLI_REGISTERED`'s parent).
  2. always → `install-hook.py` with `--hook-cli "$HOOK_CLI_REGISTERED"`.
  3. **uninstall** case → `revoke_hermes_allowlist` (consumes the JSON
     stdout from step 2) + `uninstall_python_plugin`.

  Pre-flight check switched from `HOOK_CLI` to `HOOK_CLI_INSTALL` — the
  registered path doesn't exist until `install_python_plugin` runs, so the
  old check would have always failed under the new flow. The startup banner
  now prints both paths so users can see what gets installed where vs. what
  `config.yaml` references.

  **For users currently on 2.3.2/2.3.3 with the broken `/tmp/nio-install-XXX`
  state:** just upgrade. Re-install self-heals — the dedupe predicate from
  2.3.2 already recognized the `/hermes/scripts/` marker in the stale tmp
  paths, and this release rewrites all of them to the stable destination
  during the merge. `hermes hooks doctor` then shows ✓ for every event.

  Smoke-tested end-to-end against a release-shaped fixture (curl|bash-style
  tmp work dir + isolated `HERMES_CONFIG_PATH`): fresh install registers the
  stable path and the file survives an explicit deletion of the tmp work
  dir; uninstall strips hooks + `plugins.enabled` + allowlist entry; and a
  re-install over a broken 7-entry-tmp-path fixture collapses to 7 entries
  all pointing at the stable destination.

## 2.3.3

### Patch Changes

- **Hot-fix for the 2.3.2 uninstall regression.** Bash function-order bug:
  the new `revoke_hermes_allowlist` helper was declared after the UNINSTALL
  branch that calls it, so a real `curl … | bash -s -- --uninstall` exited
  with `setup.sh: line 224: revoke_hermes_allowlist: command not found` and
  `ERROR: hermes install/setup failed`. `bash -n` doesn't validate function
  declaration order, so the 2.3.2 syntax smoke test missed it.

  Moved the function definition next to `uninstall_python_plugin()`, before
  the UNINSTALL branch. Verified end-to-end on a real fixture: uninstall now
  strips hook entries, removes `"nio"` from `plugins.enabled`, and
  successfully calls `agent.shell_hooks.revoke()` via Hermes's own venv
  Python — exit code 0.

  If you installed 2.3.2 and need to uninstall, either upgrade to 2.3.3
  first (`curl -fsSL https://core0-io.github.io/nio/install.sh | bash` —
  re-install is idempotent and self-heals stale entries) and then run
  `--uninstall`, or edit `~/.hermes/config.yaml` by hand to remove the
  `hooks:` block and `nio` from `plugins.enabled`.

## 2.3.2

### Patch Changes

- **Hermes uninstall + re-install no longer leaves stale hook entries.**
  A user's Ubuntu VM ended up with 14 dead hook entries in
  `~/.hermes/config.yaml` (pointing at deleted `/tmp/nio-install-XXX/hermes/...`
  paths from two prior `curl|bash` installs) and `--uninstall` was a silent
  no-op. Diagnosed to a single overly-narrow predicate in
  `plugins/hermes/install-hook.py` that powers both the merge dedupe and the
  uninstall strip.

  | Gap                                                                                                                                                                                                                                                                                                                                                                                                      | Pre-fix                                                                                                                                                                                                                                                                                                                                                                                                                                   | Fix |
  | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
  | **Predicate matched dev paths only**: `entry_targets_nio` required the substring `/skills/nio/scripts/`, which is present only when `setup.sh` resolves the monorepo-dev branch. Release / `curl\|bash` installs write `…/hermes/scripts/…` (or `/tmp/nio-install-XXX/hermes/scripts/…`) — predicate returned False → uninstall stripped nothing, re-install stacked beside the "unrelated" prior entry. | Predicate keyed on the `--platform hermes` flag (unique to Nio's snippet) plus a 3-marker path-segment fallback (`/skills/nio/scripts/`, `/hermes/scripts/`, `/plugins/nio/scripts/`). Recognizes every install layout — dev, release, and the upcoming stable plugin path.                                                                                                                                                               |
  | **`merge_event` collapsed only the first stale entry**: the rewrite loop returned after fixing one entry; the user's two-tmp-path config kept the second stale entry on every re-install.                                                                                                                                                                                                                | Rewrote the branch to remove ALL existing Nio entries from the event list and insert a single canonical entry at the position of the first removed one (user's relative hook ordering preserved). New status `deduped` surfaces stack-collapse in the install summary (`deduped=7`). Confirmation prompt added with a tailored message when dedupe fires.                                                                                 |
  | **`uninstall()` ignored `plugins.enabled`**: `setup.sh:install_python_plugin()` appends `"nio"` to `plugins.enabled`, but uninstall never stripped it. The directory was deleted while the registration stayed.                                                                                                                                                                                          | `uninstall()` now removes `"nio"` from `plugins.enabled`, collapses an emptied list, and drops the `plugins:` block if no siblings remain. Tolerant of duplicate `"nio"` entries from stacked installs.                                                                                                                                                                                                                                   |
  | **Orphan allowlist entries after uninstall**: removing entries from `config.yaml` left their counterparts dangling in `~/.hermes/shell-hooks-allowlist.json` (harmless but unclean).                                                                                                                                                                                                                     | New `revoke_hermes_allowlist()` helper in `setup.sh`, symmetric with `approve_hook()`: invokes Hermes's own venv Python to call `agent.shell_hooks.revoke()` for each Nio command we just stripped. Gracefully degrades (stderr warning, exit 0) when `hermes` is missing or its venv is broken. Driven by a new `--print-revoke-list` flag on `install-hook.py` that emits a single `{"nio_revoke_candidates":[…]}` JSON line on stdout. |
  | **No-PyYAML fallback predicate was equally narrow**: `has_nio_entry` used the same `/skills/nio/scripts/` substring check.                                                                                                                                                                                                                                                                               | Widened in the same shape as `entry_targets_nio` (flag + marker fallback) so PyYAML-less environments stay consistent.                                                                                                                                                                                                                                                                                                                    |

  Smoke-tested on a fixture that mirrors the user's VM (14 entries across two tmp-path prefixes):

  - **Uninstall** strips all 14 entries + removes `nio` from `plugins.enabled` + preserves
    unrelated user hooks + emits revoke JSON with 2 unique candidates.
  - **Re-install over the same broken state** dedupes 14 → 7 entries all pointing at the
    current path, with `deduped=7` in the install summary.
  - **False-positive guard**: a third-party `hook-cli.js` entry with neither
    `--platform hermes` nor any Nio path marker is left alone.

  No impact on Claude Code / Codex / OpenClaw uninstalls — those already use
  stable plugin identifiers (`claude plugin uninstall nio@nio`, marketplace
  name, `openclaw plugins uninstall nio`) and were confirmed robust.

  The latent issue that writes the ephemeral `/tmp/nio-install-XXX/...` path into
  `config.yaml` in the first place is **scoped to a follow-up patch** — this
  release ensures both the diagnosis (uninstall) and recovery (re-install
  dedupes) paths work, even with the path-fragility still in play.

## 2.3.1

### Patch Changes

- **Installer fixes surfaced by a real `curl | bash` install on Ubuntu**:
  the script bailed on missing `unzip`, the Hermes consent prompt silently
  skipped, and the post-install "Restart your agent session" hint was
  misleading on a fresh box where nothing was running yet.

  | Gap                                                                                                                                                                                                                                                                                                                                  | Pre-fix                                                                                                                                                                                                                                                                                                                                                                                                                                 | Fix |
  | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
  | **Missing `unzip` on stock Ubuntu**: `install.sh` hard-required `unzip`. Ubuntu / Debian / Fedora / RHEL ship `python3` by default but not `unzip`, so the one-liner exited with `ERROR: 'unzip' is required but not on PATH.` before fetching anything.                                                                             | Pre-check now prefers `unzip`, falls back to `python3 -m zipfile -e` (or `python`). Errors only if neither is present, and the message points at `apt-get install unzip` as the obvious remediation.                                                                                                                                                                                                                                    |
  | **Hermes consent prompt skipped under `curl \| bash`**: the prompt was gated on `[ -t 0 ] && [ -t 1 ]`. Under `curl … \| bash`, stdin is the curl pipe, so `[ -t 0 ]` is false and `plugins/hermes/setup.sh` jumped straight to the "Approve later" path — users never saw the interactive prompt the docs promised.                 | Switched to `[ -r /dev/tty ] && [ -w /dev/tty ]` and read the answer from `/dev/tty` instead of stdin (the standard installer pattern used by rustup / nvm / get-docker). Genuine non-TTY environments (CI, Docker `-d`, systemd, `nohup </dev/null`) still fail the `/dev/tty` check and fall through cleanly.                                                                                                                         |
  | **"Restart your agent session" misleading on first install**: the post-install hint said _restart_, but a fresh box has no agent process to restart yet — the user just needs to **start** one. Also the Hermes `setup.sh` Next-steps led with "Approve the hook on first run" before "Restart", inverting the natural mental model. | `install.sh` + `docs/install.html` now say "Start a new agent session"; the install.html bullet adds an explicit sub-clause for the only real _restart_ case (a `hermes gateway` already running with stale config). Hermes `setup.sh`'s unapproved-branch heredoc reordered so step 1 is "start a new session" (consent is its natural side-effect, not a separate action), step 2 is the headless pre-approve path, step 3 is verify. |

  Docs: `docs/install.html` prereq strings now read "unzip _or_ python3"; the
  Hermes consent caveat explains the `/dev/tty` mechanic and enumerates the
  non-TTY scenarios that genuinely need `--accept-hooks` / `HERMES_ACCEPT_HOOKS=1`;
  the manual-install paragraph mentions either extraction tool.

  No behaviour change for users who already had `unzip` installed, ran the
  installer from a real TTY, or were re-installing on a box with a running
  agent — all three changes only widen previously-failing paths.

## 2.3.0

### Minor Changes

- Two headline shifts in this release: first-class Codex CLI support, and a single hosted installer that replaces the per-platform zip dance.

  ## Codex CLI plugin (new platform)

  Codex CLI joins Claude Code, OpenClaw, and Hermes as a fully supported platform. The plugin lives at `plugins/codex/` and runs the same Phase 0–6 guard pipeline as the other platforms.

  - **Layout.** Flat repo layout (`.codex-plugin/plugin.json` manifest with `interface{displayName,category,…}`, `hooks/hooks.json`, `skills/nio/`, root-level `setup.sh`). Skill content syncs from `plugins/shared/skill/` and bundled scripts mirror from the Claude Code plugin.
  - **Hooks.** Subscribes to `SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop`. `PermissionRequest` is deferred to a later phase.
  - **Adapter.** `CodexAdapter` (`src/adapters/codex.ts`) registers as `name='codex'` with the default native tool mapping `{ Bash: exec_command }` — Codex's only first-party tool is `Bash`, so writes / reads / fetches reach the guard via shell.
  - **Slash command.** Codex CLI does not support custom slash commands, so `/nio` is exposed via the `$nio` skill trigger and natural-language match against `SKILL.md`.

  ### Install / setup behaviour

  Codex 0.128 has no `codex plugin install` subcommand and never auto-installs from a registered marketplace, so `plugins/codex/setup.sh` performs a full nuke + cp install on every run:

  - Wipes and rewrites `~/.codex/plugins/cache/nio/nio/<version>/` from the unzipped plugin source — this is what Codex actually loads at session start.
  - Generates a Codex-valid marketplace catalog under `~/.nio/codex-marketplace/` (Codex 0.128's marketplace schema rejects the repo's flat layout, so the catalog is built fresh at install time).
  - Writes a `hooks.json` into the cache directory with **absolute paths**. Codex runs hook commands with `cwd=session-cwd`, so plugin-relative `./skills/...` paths can't resolve at runtime.
  - Edits `~/.codex/config.toml` to register `[marketplaces.nio]`, enable `[plugins."nio@nio"]`, and set both `[features] codex_hooks = true` (stable; gates the global hook system) and `[features] plugin_hooks = true` (still under-development in 0.128, but required for plugin-bundled `hooks.json` to load).

  The same `setup.sh` works whether invoked from the repo or from an extracted release zip, and accepts `--platform codex` so the cross-platform top-level installer can delegate to it.

  ### Tests

  PreToolUse stdin fixtures captured from a real Codex 0.128 session back a new integration test suite (`src/tests/codex-*.test.ts`) that exercises the adapter end-to-end against those fixtures.

  ## Hosted curl-piped installer (`install.sh`)

  A single hosted installer at `https://core0-io.github.io/nio/install.sh` replaces the per-platform "download zip → unzip → cd → setup.sh" recipe:

  ```bash
  curl -fsSL https://core0-io.github.io/nio/install.sh | bash
  ```

  Auto-detects which agent CLIs are installed (`~/.claude` / `~/.codex` / `~/.openclaw` / `~/.hermes`) and runs the matching per-platform `setup.sh` for each. Supports:

  - `--platform NAME` — repeatable; one of `claude-code` / `codex` / `openclaw` / `hermes`. Skips auto-detect and installs only the named platform(s).
  - `--uninstall` — combine with `--platform` to scope.
  - `--reset-config` — overwrites `~/.nio/config.yaml` from the bundled template.
  - `--cc-home` / `--codex-home` / `--openclaw-home` / `--hermes-home` — forwarded past the `bash -s --` boundary to the per-platform `setup.sh` for relocated agent home directories.
  - `NIO_VERSION=v2.3.0` env — pin a specific release tag instead of querying the GitHub API. Useful on shared CI IPs hitting the unauthenticated 60 req/hr limit.

  The installer is platform-agnostic orchestration only — it lives on GitHub Pages, decoupled from the release zips. Per-platform `setup.sh` files stay inside the versioned release artifacts and can be invoked directly when the curl-piped path is undesirable.

  ## Single tabbed install page

  The four `docs/install-<platform>.html` pages collapse into one `docs/install.html` with five tabs: **Auto-detect** (default, recommended), **Claude Code**, **Codex CLI**, **OpenClaw**, **Hermes**. Each tab carries its own prerequisites, a condensed description of what `setup.sh` does on that platform, verify steps, and any platform-specific caveat. Tab state syncs with the URL hash (`#tab=<name>`), so deep-links from the README and getting-started page jump straight to the right platform. Each tab is decorated with the platform's official brand mark (sourced from upstream repos and the brand pages of each project).

  ## README simplifications

  `README.md` is now operator-focused: the duplicated `Critical: restart-required` bullet leaves `## At a glance`, `## Quick start` collapses into three subsections (`### 1. Install`, `### 2. Configure and run`, `### 3. Upgrade`) plus a single surviving `<details>` block (`./setup.sh --reset-config`), and the skill command listing moves below `## Architecture` as `## Skill usage` so readers see the guard pipeline before the commands that poke at it.

  Sub-sections that used to live in `## Quick start` move to where they fit better:

  - `Custom install paths (.claude / .openclaw moved elsewhere)` — moves to `docs/install.html`.
  - `Install from source` — folds into the existing `## Development` section.
  - The four-row platform zip table and four `<details>One-liner install</details>` blocks — replaced by the single curl-piped one-liner above.

  `### 3. Upgrade` makes explicit that `--reset-config` overwrites the existing `config.yaml` with the upgraded bundled template, so user-tuned fields (`allowed_commands`, `permitted_tools`, `collector.endpoint`, `scoring_weights`, …) are wiped and have to be re-applied on top of the new defaults. The release notes recommend backing up `~/.nio/config.yaml` first.

## 2.2.0

### Minor Changes

- Phase 0 gains a new MCP Tool Routing layer that detects MCP-style tool
  invocations across every documented invocation channel (D1 through D16)
  and unwraps every documented composition style (U1 through U16). Combined
  with the renamed permitted_tools.mcp allowlist and blocked_tools.mcp
  denylist, this enforces fine-grained MCP server / tool gating regardless
  of how a call is dressed up.

  This release also unifies the Collector pipeline: audit-log routing,
  attribute / label keys across logs / metrics / traces, and the OpenClaw
  trace surface all align with the same single-source-of-truth helpers.
  Cross-signal queries and cross-platform dashboards no longer need to
  OR-query parallel schemas.

  ## MCP Tool Routing (Phase 0)

  A new server registry under guard.mcp_servers resolves MCP servers from
  URL, unix socket, binary name, and CLI package. Detectors then walk
  every known channel (D1 mcporter, D2 HTTP clients including unix-socket,
  D3 HTTPie, D4 raw TCP / unix-domain, D5 Bash builtin TCP socket, D6
  PowerShell HTTP, D7 language runtimes for Python / Node / Ruby / Perl /
  PHP / Deno / Bun, D8 stdio JSON-RPC pipe, D9 stdin redirect / here-string,
  D10 FIFO cross-command, D11 package runners npx / uvx / pipx, D12 MCP
  server self-launch audit-only, D15 compile-and-run audit-only, D16 plain
  registry-URL mention audit-only obfuscation fallback).

  Detectors run after Stage 1 unwrappers (U1 through U16) so wrapped
  invocations also fire across shell wrappers, heredoc / here-string,
  process and command substitution, source / script, encoded-decode pipes,
  string-concat folding, xargs / find / parallel / watch / time / env,
  remote-shell tools, editor command escapes, background tools, and
  compile-and-run combos.

  ### Phase 0 detector closures (post-launch fixes)

  A user e2e audit found indirect channels still bypassed
  blocked_tools.mcp deny-by-tool-name. Five compounding bugs are fixed:

  - D7 now extracts tool names from inline source bodies (formerly only
    walked URLs), so language-runtime hits no longer collapse to
    ${server}\_\_\*.
  - The body-extraction parser falls back to single-quote to double-quote
    substitution before giving up, so Python single-quoted dict literals
    (the shape json.dumps({...}) produces in source) are recognised.
  - The blocked_tools.mcp matcher is biased toward deny when a detector
    resolves a server but cannot extract the tool. Trade-off: over-denies
    indirect calls to non-blocked tools on the same server (use
    permitted_tools.mcp for fine-grained allow + deny on one server).
  - Latent: the body parser's slice-start position is now reset between
    scan attempts so multi-blob bodies do not mis-slice.
  - U5 process-substitution + echo-decode and U11 xargs feeder synthesis
    now emit the inner / appended text as an executable fragment so
    detectors see the synthesized argv. Previously these slipped through
    with only audit-only D16 hits, filtered out before the deny gate.

  ### Sensitive-path coverage

  Phase 3's SENSITIVE_FILE_PATHS rule expands to fragment-match MCP
  config and persistence paths regardless of prefix - the Claude Code MCP
  config, shell rc files, the macOS LaunchAgents directory, and others.
  These deny under all three protection levels (strict / balanced /
  permissive).

  ## Breaking: Phase 0 config schema rename

  Existing ~/.nio/config.yaml files using the old names continue to load
  (unknown fields are stripped, not rejected), but settings under the old
  keys are silently ignored - update any custom config to the new keys.

  | Old key               | New key                   |
  | --------------------- | ------------------------- |
  | guard.available_tools | guard.permitted_tools     |
  | guard.guarded_tools   | guard.native_tool_mapping |
  | guard.mcp_endpoints   | guard.mcp_servers         |

  Rationale: permitted_tools pairs naturally with blocked_tools and
  expresses the strict-allowlist semantic; native_tool_mapping is a
  tool-name to action-type classification table for native tools (not a
  third allow/deny list); mcp_servers is a server registry keyed by
  server name (entries also list binaries and CLI packages, neither of
  which are endpoints, and the new name matches upstream config field
  naming).

  Adapter constructor option also renames: the guardedTools field on
  ClaudeCodeAdapter, OpenClawAdapter, and HermesAdapter constructors is
  now nativeToolMapping.

  The Phase 0 deny risk tag TOOL_GATE_UNAVAILABLE is now
  TOOL_GATE_NOT_PERMITTED, with the deny reason updated to match.

  ## Breaking: OTLP signal attribute alignment

  OTLP logs and metrics signal attribute / label keys now align with
  the trace signal. Cross-signal queries work with the same key names.

  Metrics (nio.tool_use.count, nio.turn.count, nio.decision.count,
  nio.risk.score):

  - tool_name to gen_ai.tool.name
  - decision to nio.guard.decision
  - risk_level to nio.guard.risk_level
  - event to nio.event
  - platform to nio.platform

  Metric instrument names are unchanged.

  Audit log (emitAuditLog OTEL LogRecord projection):

  - nio.tool_name to gen_ai.tool.name
  - nio.session_id to gen_ai.conversation.id + session.id
  - nio.decision to nio.guard.decision
  - nio.risk_level to nio.guard.risk_level
  - nio.risk_score to nio.guard.risk_score
  - nio.risk_tags to nio.guard.risk_tags
  - New: gen_ai.tool.call.id (from tool_use_id)
  - New: nio.tool_summary, nio.task_id, nio.task_summary, nio.cwd,
    nio.transcript_path (previously inside the JSON body only)
  - New: nio.event_type

  The flat-attribute set is now built by a shared auditEntryAttributes
  helper that pulls guard-decision keys from nioGuardAttributes in
  traces-collector - same single-source-of-truth pattern the trace
  signal uses.

  The local audit.jsonl JSONL line shape is unchanged (still the verbatim
  AuditEntry); only the OTEL flat-attribute projection moved.

  Action required: any saved dashboard query / alert filtering on the
  old keys must be updated before upgrading.

  ## Audit log routing fix

  Claude Code and Hermes hook event audit records (PreToolUse,
  PostToolUse, TaskCreated, TaskCompleted, Stop, SubagentStop,
  SessionStart, SessionEnd, UserPromptSubmit) now route to audit.jsonl
  instead of the misnamed metrics.jsonl. They flow through the same
  writeAuditLog pipeline as guard, scan, and lifecycle entries, picking
  up OTEL Logs export and rotation for free.

  Audit-log path now reads consistently from collector.logs.path. The
  cross-process trace state file (traces-state-store.json) sits next to
  the audit log so a single config setting controls both.

  The obsolete collector.metrics.{local,log,max_size_mb} config keys are
  removed; pre-cleanup config.yaml files continue to load. After updating,
  ~/.nio/metrics.jsonl and (if upgrading from a build that wrote it)
  ~/.nio/collector-state.json can safely be deleted.

  Internal: traces-collector is now a pure-function module - all state
  IO moved to a new traces-state-store module that owns the persistence.

  ## Cross-platform trace pipeline unification

  OpenClaw plugin trace emission now routes through the same
  traces-collector pure functions used by Claude Code and Hermes. Span
  names and attribute keys are unified across all three platforms
  (invoke_agent UserPromptSubmit, execute_tool tool-name, gen_ai.\*
  semantic-convention attributes); cross-platform observability
  dashboards no longer have to OR-query two parallel schemas.

  Internal: OpenClaw holds per-session CollectorState in memory (no
  on-disk state file - single process); Claude Code and Hermes continue
  to bridge state across hook processes via traces-state-store.json.

  ## Other fixes

  - parseMcpToolName now handles the Hermes platform.
  - hermes-setup script handles the --reset-config flag.
  - Default collector service entry removed from the config template
    (leftover from early scaffolding).

  ## Tests, tooling, docs

  - New Integration: 6-vector e2e regression block in
    src/tests/integration.test.ts locks in the user's CC audit table
    (V1 through V6).
  - Steps 29 / 31 composition closures locked in as integration tests
    under denylist mode.
  - Roughly thirty new unit / integration tests across detectors,
    unwrappers, parsers, and matcher bias.
  - e2e-test/mcp-detection-e2e-task.md rewritten as full
    synthesized-eval - every step from 1 onward feeds a base64-encoded
    PreToolUse envelope to a local helper that pipes to guard-hook.js
    against a scratch config. No real exec; reproducible matrix across
    Claude Code, OpenClaw, and Hermes.
  - Added Biome as the project formatter and linter.
  - Refreshed README, ARCHITECTURE, COLLECTOR-SIGNALS,
    install-claude-code, install-openclaw, install-hermes.
  - New GitHub Pages content: MCP Tool Routing material merged into the
    Phase 0 page; Collector Signals split into four pages (overview,
    traces, metrics, logs) with unified attribute tables; section anchor
    links; responsive layout for narrow viewports.

## 2.1.0

### Minor Changes

- # v2.1.0 — Hermes lifecycle, `/nio` slash dispatch, semantic-bypass guard

  ## Features

  ### Hermes Agent — full integration

  - **Shell-hook adapter** (initial bring-up — relies on upstream [Hermes PR #13296](https://github.com/NousResearch/hermes-agent/pull/13296)). New `HermesAdapter` parses snake_case envelope; `setup.sh` merges hook entries into `~/.hermes/config.yaml`.
  - **7 lifecycle events** wired through one `hook-cli.js` binary that internally dispatches `pre_tool_call` to the Phase 0–6 guard pipeline and `post_tool_call` / `pre_llm_call` / `post_llm_call` / `on_session_start` / `on_session_end` / `subagent_stop` to the OTEL collector. Same command string across all events → one Hermes allowlist approval covers them all.
  - **`/nio` slash command via tiny Python plugin** (`plugins/hermes/python-plugin/`). Drops into `~/.hermes/plugins/nio/`, registers `/nio` with Hermes's command-dispatch — `/nio config show` / `/nio scan ./src` / `/nio action ...` skip the LLM entirely. No pip install / wheel / entry-points; Hermes auto-discovers user plugins.
  - **Self-contained release zip** `nio-hermes-vX.zip` (new `pnpm run release:hermes` target). Bundles `hook-cli.js` + `nio-cli.js` as `splitting:false` single-file outputs; no dependency on the Claude Code plugin dir.
  - **Top-level `setup.sh` dispatcher** detects Hermes via `--hermes-home` / `HERMES_CONFIG_PATH`, supports `--accept-hermes-hook` for non-interactive allowlist approval. One-shot `setup.sh --accept-hooks` calls Hermes's own `register_from_config(accept_hooks=True)` from the venv Python — no chat session, no LLM tokens.

  ### Semantic-bypass guard (Phase 3/4 enhancement)

  - **`DESTRUCTIVE_FS` behavioural rule** (severity: critical). Catches `shutil.rmtree`, `os.remove/unlink/rmdir/removedirs`, `pathlib.Path.unlink/rmdir`, `fs.rmSync({recursive:true})`, `fs.rm`, `fs.rmdirSync`, `fs.unlinkSync`, `fsPromises.*` — semantic equivalents of literal recursive-delete shell commands that previously slipped past Phase 2's literal-string regex.
  - **`exec_command` inline-code unwrap.** Phase 3/4 used to gate on `action.type === 'write_file'` only. Now also unwraps `python -c` / `node -e` / `bash -c` / `perl -e` / `ruby -e` / `php -r` / heredoc forms via a new `extractInlineCode()` util and runs static + behavioural analysers on the inline body. Closes the bypass where an agent retried with `python3 -c "import shutil; shutil.rmtree(...)"` after the literal shell command got blocked.
  - **Short-circuit scoring symmetry.** When a phase's individual score crossed the deny threshold, weighted-average aggregation with clean earlier-phase zeros was diluting the verdict (Phase 4 critical 0.95 averaged with Phase 2 0.35 → final 0.56 → `confirm`). `buildResult` now takes an optional `shortCircuitScore` and uses `max(aggregate, triggering)`. `shutil.rmtree`-style ops now deny under `balanced` symmetrically with their literal shell counterparts at Phase 2.

  ### OpenClaw — session boundary hooks

  - New `api.on('session_start', ...)` and `api.on('session_end', ...)` registrations in the OpenClaw plugin. Resets turn counters, emits new `AuditLifecycleEntry { lifecycle_type: 'session_start' | 'session_end' }`, defensively force-flushes any in-flight turn span on session teardown.

  ### `nio-cli.ts`

  Single-binary unified dispatcher for `/nio <subcommand>...`. Cross-process consumers (Hermes Python plugin) shell out to it; OpenClaw still uses `dispatchNioCommand` in-process. Subcommands match the SKILL.md surface: `scan` / `action` / `config` / `report` / `reset`.

  ## Fixes

  - **Hermes setup.sh refresh allowlist on re-approve.** `register_from_config` is no-op when the entry already exists, so post-rebuild re-approvals never updated `script_mtime_at_approval`. setup.sh now revokes-then-registers, preserving idempotency on first install while making rebuilds refresh cleanly.
  - **Hermes setup.sh prefers Hermes venv Python** for `install-hook.py`. System `python3` often lacks PyYAML; the fallback line-based merger couldn't tell a partial install (only `pre_tool_call`) from a complete one (all 7 events). Tightened fallback to refuse any pre-existing `hooks:` block when PyYAML is missing.
  - **Hermes setup.sh wired into top-level dispatcher.** Previous `./setup.sh` only enumerated Claude Code + OpenClaw; Hermes was silently skipped even when `~/.hermes/` existed.
  - **Hermes guard path emits OTEL.** `pre_tool_call` runs `recordGuardDecision` (metric) + dispatches `PreToolUse` through `collector-core` (saves pending_span state so `post_tool_call` can close a tool span) + emits OTLP `/v1/logs` for the audit entry — bringing parity with Claude Code's parallel guard-hook + collector-hook chain.
  - **OpenClaw setup.sh scrubs stale plugin paths** in `~/.openclaw/openclaw.json` before install. OpenClaw's CLI validates every entry in `plugins.load.paths` upfront — a single dangling path (e.g. from a previous release-zip layout) failed the whole `plugins install` command and `plugins uninstall` couldn't pre-clean because it hit the same validator.
  - **Hermes `install-hook.py` multi-event merge** with `width=10_000` PyYAML dump (long command strings stop wrapping across lines, `grep`-friendly). Per-event idempotency: status reports `added` / `added-alongside` / `rewrote-path` / `already-installed` per event.
  - **Hermes consent flow uses `register_from_config`, not `hooks doctor --accept-hooks`.** The doctor path doesn't run `register_from_config` so `--accept-hooks` was silently no-op there. Now invokes `register_from_config(load_config(), accept_hooks=True)` directly via the Hermes venv Python.

  ## Internal

  - **`collector-hook.ts` refactored** — extracted the platform-agnostic core into `src/scripts/lib/collector-core.ts`. Both Claude Code's `collector-hook.ts` (stdin wrapper) and Hermes's `hook-cli.ts` collector branch share one `dispatchCollectorEvent({event, input, platform, config, meterProvider, tracerProvider})`. `toolSummary()` now recognises Claude Code, Hermes, and OpenClaw tool names.
  - **Type widening:**
    - `TaintSink.kind` gains `'file_destructive'`
    - `AuditLifecycleEntry.lifecycle_type` gains `'session_start' | 'session_end'`
    - `dispatchCollectorEvent` event union gains `'SessionEnd'` (Hermes-driven)
      Each is additive — only TS strict exhaustive-switch consumers see a soft break.

  ## Docs

  - README.md / `docs/ARCHITECTURE.md` / CLAUDE.md updated to describe both Hermes surfaces (shell-hooks + Python plugin) and the new `/nio` dispatch.
  - `docs/ARCHITECTURE.md` shell-hook diagram redrawn to show the guard-vs-collector split inside `hook-cli.js`; new `/nio slash command (Hermes Python plugin)` subsection documents directory layout + 4-step routing.
  - "Contract at a glance" table now contrasts `/nio` dispatch routes across all three platforms.

  ## Tests

  **634 passing** (was 519 at v2.0.2, +115 new):

  - `inline-code.test.ts` — 31 cases covering Python / Node / Shell / Perl / Ruby / PHP `-c|-e|-r|-eval` flag forms, all heredoc variants (`<<EOF`, `<<'EOF'`, `<<-EOF`), pipeline + chained command boundaries, regression guards for benign `node index.js foo` etc.
  - `collector-core.test.ts` — 21 cases for the platform-agnostic dispatcher (`toolSummary` cross-platform, `spanKey`, `writeToLog`, `dispatchCollectorEvent` event routing).
  - `hook-cli.test.ts` — extended with collector-path coverage for all 6 Hermes lifecycle events.
  - `nio-cli.test.ts` — 9 cases for the unified slash dispatcher (subcommand routing, multi-argv + single-arg styles, output normalisation).
  - Existing `action-orchestrator.test.ts` extended with `exec_command` inline-code coverage (Python heredoc, Node `-e`, regression guards).
  - Existing `behavioural-analyser.test.ts` / `py-behavioural.test.ts` extended with destructive-fs sink detection.

  ## Upgrading

  After installing v2.1.0:

  ```bash
  # Refresh Hermes hooks (now 7 lifecycle events; one approval covers all)
  bash plugins/hermes/setup.sh --accept-hooks

  # Restart any running Hermes gateway so it loads the new config + allowlist
  hermes gateway run --replace
  ```

## 2.0.2

### Patch Changes

- - **`/nio action` no longer self-denies on Claude Code** ([`8e7fa60`](../../commit/8e7fa60), [`2a49651`](../../commit/2a49651)) — the outer guard hook could previously deny the skill's own `Bash` invocation of `action-cli.js` because the Bash command string literally contained the user-typed payload (`rm -rf /` etc.). Now Phase 0 still runs (`blocked_tools` is authoritative), but Phase 1–6 is skipped for strictly-matched Nio self-calls; `action-cli` performs the single authoritative content analysis in its subprocess. Adds `src/adapters/self-invocation.ts` with 22 unit + 6 integration tests.
  - **Docs drift after earlier rename** ([`2a49651`](../../commit/2a49651), [`549f7ef`](../../commit/549f7ef)) — leftover `engine.ts` / `RuntimeDecision` references in `docs/ARCHITECTURE.md` cleaned up.

  - **4 CVE patches, 0 vulnerabilities in `pnpm audit`** ([`dcd29d6`](../../commit/dcd29d6)):

    - `protobufjs` forced to **≥7.5.5** (resolves to 8.0.1) via `pnpm.overrides` — patches [GHSA-xq3m-2v4x-88gg](https://github.com/advisories/GHSA-xq3m-2v4x-88gg) (**critical**, arbitrary code execution; reached through `@grpc/grpc-js` and OTEL `otlp-transformer`).
    - `axios` bumped from `^1.6.7` to `^1.15.0` — patches [GHSA-3p68-rc4w-qgx5](https://github.com/advisories/GHSA-3p68-rc4w-qgx5) (NO_PROXY bypass → SSRF) and [GHSA-fvcv-3m26-pcqx](https://github.com/advisories/GHSA-fvcv-3m26-pcqx) (cloud-metadata exfiltration via header injection).
    - `follow-redirects` forced to **≥1.16.0** via `pnpm.overrides` (axios 1.15.2 still pins the vulnerable 1.15.11) — patches [GHSA-r4q5-vmmm-2653](https://github.com/advisories/GHSA-r4q5-vmmm-2653) (custom auth headers leak across cross-domain redirects).

  - **Terminology refactor — all 6 phases now `XxxAnalyser` classes with uniform `.analyse()`** ([`75821f4..255b8ab`](../../compare/75821f4..255b8ab)). The word "runtime" was overloaded (class name, phase alias, directory name). Restored intent:

    | Before                                            | After                                                                                                                      |
    | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
    | `RuntimeAnalyser` (orchestrator class)            | `ActionOrchestrator`                                                                                                       |
    | `RuntimeAnalyserOptions`                          | `ActionOrchestratorOptions`                                                                                                |
    | `RuntimeDecision`                                 | `ActionDecision`                                                                                                           |
    | `checkAllowlist` (function)                       | `AllowlistAnalyser` class                                                                                                  |
    | `analyzeAction` (function)                        | `RuntimeAnalyser` class (Phase 2)                                                                                          |
    | `NioInstance.runtimeAnalyser` field               | `.orchestrator`                                                                                                            |
    | `createNio()` return `{scanner, runtimeAnalyser}` | `{scanner, orchestrator}`                                                                                                  |
    | `.analyze(ctx)` method (US)                       | `.analyse(ctx)` (UK, matches `Analyser`)                                                                                   |
    | `analyzeDataflows`                                | `analyseDataflows`                                                                                                         |
    | `src/adapters/engine.ts`                          | `src/adapters/hook-engine.ts`                                                                                              |
    | `src/core/analysers/runtime/index.ts`             | `src/core/action-orchestrator.ts`                                                                                          |
    | `src/core/analysers/runtime/decision.ts`          | `src/core/action-decision.ts`                                                                                              |
    | Flat `allowlist.ts` / `runtime.ts`                | `allowlist/index.ts` / `runtime/index.ts` (directory form, consistent with `static/`, `behavioural/`, `llm/`, `external/`) |

    No behaviour change; 491 → 519 tests, all green.

  - **Directory consistency** ([`255b8ab`](../../commit/255b8ab)) — all phase analysers now live in sub-directories with `index.ts`, matching the existing `static/` / `behavioural/` / `llm/` / `external/` pattern.
  - **`pnpm bump` now propagates to GitHub Pages** ([`3875352`](../../commit/3875352)) — `sync-site-version.js` chained into `version-update`; topbar badge + footer release-tag links across 15 HTML pages update at bump time, not only at build time.
  - **Search discoverability** ([`549f7ef`](../../commit/549f7ef)) — `nio-agent-guard` added as primary alias across `package.json`, `plugin.json`, and `marketplace.json` keywords; all 15 HTML pages gained `<meta name="description">` + `<meta name="keywords">`.

  - **`NOTICE` + `LICENSES/agentguard-MIT.txt`** ([`89db2f7`](../../commit/89db2f7)) — Apache-2.0 §4(d) NOTICE listing upstream attributions (including the MIT copyright of GoPlusSecurity/agentguard, from which early code was drawn). Preserved verbatim in `LICENSES/`; both files ship with npm tarball.
  - **Community health files** ([`224947a`](../../commit/224947a)) — `SECURITY.md` (private disclosure flow, scope, supported versions), `CONTRIBUTING.md` (dev setup, Conventional Commits, changeset workflow, PR checklist), `.github/ISSUE_TEMPLATE/` (bug, feature, config routing security reports to GitHub Advisories), PR template.
  - **Public library exports** ([`cceecd1`](../../commit/cceecd1)) — `AllowlistAnalyser`, `RuntimeAnalyser` (Phase 2), `GuardRulesConfig`, plus the renamed orchestrator types.

## 2.0.1

### Patch Changes

- - **GitHub Pages docs site** (78a9bb9) — new `/docs/` tree (getting-started,
    install guides, skill reference, configuration, pipeline overview + scoring +
    Phase 0–6 = 15 pages), sticky frosted topbar with GitHub pill, collapsible
    sidebar driven by a single nav config, mobile hamburger, back-to-top. The
    home page's protection-level pill becomes a rotating-neon dropdown that
    re-runs the Phase 0–6 simulation under the selected mode.
  - **Direct `/nio` slash-command dispatch on OpenClaw** (16636f4) — the OpenClaw
    adapter now routes `/nio <args>` straight into an in-process subcommand
    router (`config`, `action`, `scan`, `report`, `reset`), bypassing the LLM
    so results are immediate and deterministic.
  - **Version badge auto-sync** (f075c66) — topbar pill + footer version on
    every GitHub Pages page are now `<a>` links to the matching GitHub release
    tag, regenerated at build time from `package.json` via
    `scripts/sync-site-version.js`. `pnpm run build` / `pnpm bump` keep the site
    in sync without hand edits.

  - **Positioning: execution assurance, not security** (77c1088) — reframed
    Nio across all user-facing surfaces (README, `skills/nio/{README,SKILL}.md`,
    `openclaw.plugin.json`, CLAUDE.md, plugin manifests, setup banners, GitHub
    Pages site, LLM self-prompt, audit-log empty-state strings) from "Security
    and observability for AI coding agents" to "Execution assurance and
    observability for autonomous AI agents." The Skill's scan/report/action
    output headers now read "Nio Execution Risk Scan Report" / "Nio Execution
    Report". "Defense Pipeline" renamed to "Execution Pipeline" on the docs
    site. Compatibility table tightened: full hook support is Claude Code +
    OpenClaw only, other platforms are skill-only.
  - **Licence: Apache-2.0** (5c07be9, cfc5cc2) — switched from MIT to Apache-2.0
    and added per-file SPDX headers across the source tree.
  - **README: self-contained one-liner install blocks** (e0763de) — each
    platform's install block now stands alone (copy-paste-done), and the
    redundant "Maintained by" footer was dropped (3c2aa3e).
  - **Branding: Nio wordmark replaces FFWD logo** (17cede9).

  - **Bundled scanner runs outside the repo** (66b11a9) — inlined
    `@babel/traverse` into the release bundles so skills/plugins scripts load
    correctly when extracted to `~/.claude` / `~/.openclaw`, not just in the
    source checkout.

  - **GitHub Pages font loading** (f1c7973) — fonts externalized out of
    `index.html` into `assets/` so pages share the same font set without
    inlining.

  - **E2E skill smoke test split from guard honeypot task** (125e783) — the
    smoke test now verifies only that each `/nio` subcommand routes and
    returns a structured response, independent of what the scan/action
    detectors find.

## 2.0.0

### Major Changes

- 6ec2068: **Breaking: project renamed from `ffwd-agent-guard` to `nio`.** Hard cutover — no backcompat shims.

  - **npm package**: `@core0-io/ffwd-agent-guard` → `@core0-io/nio`. Existing consumers must update imports.
  - **Config directory**: `~/.ffwd-agent-guard/` → `~/.nio/`. Old configs are not migrated; re-run `setup.sh` to regenerate.
  - **Environment variable**: `FFWD_AGENT_GUARD_HOME` → `NIO_HOME`.
  - **Slash command**: `/ffwd-agent-guard` → `/nio`.
  - **Plugin IDs**: Claude Code marketplace + plugin name `ffwd-agent-guard` → `nio`. OpenClaw plugin id `ffwd-agent-guard` → `nio`.
  - **OTEL schema**: service name `agentguard` → `nio`; all `agentguard.*` attributes + metrics (`agentguard.tool_use.count`, `agentguard.turn.count`, `agentguard.decision.count`, `agentguard.risk.score`) renamed to `nio.*`. Existing dashboards and alert rules must update their queries.
  - **TS exports**: `createAgentGuard` → `createNio`, `AgentGuardConfig` → `NioConfig`, `AgentGuardConfigSchema` → `NioConfigSchema`, `AgentGuardInstance` → `NioInstance`.
  - **Skill directory**: `plugins/*/skills/ffwd-agent-guard/` renamed to `plugins/*/skills/nio/`.
  - **Release zips** now named `nio-<target>-v<version>.zip`.
  - **GitHub repo URL** updated in manifests to `github.com/core0-io/nio` (repo rename handled separately).

- - **Project renamed `ffwd-agent-guard` → `nio`** — hard cutover, no backcompat shims (6ec2068)

    - npm package: `@core0-io/ffwd-agent-guard` → `@core0-io/nio`
    - Config directory: `~/.ffwd-agent-guard/` → `~/.nio/` (not migrated; re-run `setup.sh`)
    - Environment variable: `FFWD_AGENT_GUARD_HOME` → `NIO_HOME`
    - Slash command: `/ffwd-agent-guard` → `/nio`
    - Plugin IDs (Claude Code marketplace + OpenClaw): `ffwd-agent-guard` → `nio`
    - OTEL schema: service name `agentguard` → `nio`; all `agentguard.*` attributes
      and metrics (`agentguard.tool_use.count`, `.turn.count`, `.decision.count`,
      `.risk.score`) renamed to `nio.*` — **update dashboards and alert rules**
    - TS exports: `createAgentGuard` → `createNio`, `AgentGuardConfig` → `NioConfig`,
      `AgentGuardConfigSchema` → `NioConfigSchema`, `AgentGuardInstance` → `NioInstance`
    - Skill directory: `plugins/*/skills/ffwd-agent-guard/` → `plugins/*/skills/nio/`
    - Release zips now named `nio-<target>-v<version>.zip`

  - **`guard.allowlist_mode`** (2d9295f) — new `continue` (default) / `exit` modes
    control what happens on allowlist match. Default `continue` no longer
    short-circuits Phase 2–6, so `llm_analyser` / `external_analyser` /
    `dangerous_patterns` can't be silently bypassed by the static allowlist.
  - **MCP tool gate covers mcporter shell invocations** (3698415) — when a
    guarded tool is `Bash` / `exec`, the Phase 0 gate scans the command for
    `mcporter <server>.<tool>` (with or without `call`, `npx`/`bunx`, flags, `--`,
    or `'server.tool(args)'` syntax) and matches against the same `mcp`
    allow/block lists. Denied hits log as
    `Tool "server__tool" is blocked (…; invoked via mcporter)`.

  - **Claude Code `UserPromptSubmit` hook now registered** (1ed1f8b) — collector
    plugin was missing this hook registration, so turn spans were missing
    `nio.turn.user_prompt` and started late.

  - **README install flow rewritten** (752750f) — primary path is now
    "download release zip → unzip → `./setup.sh`". `git clone` moved to
    "Install from source" for contributors.
  - **Rule count corrected `16 → 15`** across `ARCHITECTURE.md`, shared
    `SCAN-RULES.md`, and the excalidraw flow diagram.
  - **Removed `docs/SECURITY-POLICY.md`** — unreferenced duplicate of
    ARCHITECTURE / SCAN-RULES / ACTION-POLICIES carrying stale paths.
  - **GitHub Pages landing** (e2287d0, 6ba5dae, fab9e0e) — defense-pipeline
    diagram served from `core0-io.github.io/nio/`, linked from the README.
  - README architecture ASCII diagram: fixed misaligned inner box
    (`Static + Behavioural` line).

  - **MIT license added** (959589c) — `LICENSE` at repo root; `"license": "MIT"`
    in root + OpenClaw `package.json` and `openclaw.plugin.json` (matches the
    existing Claude Code plugin manifest).
  - `.lsp/` removed; `tsconfig.lib.tsbuildinfo` untracked; `*.tsbuildinfo` and
    `.lsp/` added to `.gitignore`.
  - Deleted unused `assets/ag-flow.html`.

## 1.0.4

### Patch Changes

- Features

  Cross-platform MCP tool gate (79941c7) — new mcp key under guard.available_tools / blocked_tools matches parsed MCP tool names across platforms. One entry like blocked_tools.mcp: ['HassTurnOff'] now blocks hass**HassTurnOff on OpenClaw AND mcp**hass**HassTurnOff on Claude Code. Accepts bare tool names (any server) or server-qualified server**tool form.
  sensitive_path_patterns regex field (828022b) — regex companion to the substring-based sensitive_paths. Closes gaps where substring matching can't handle dynamic segments (/abc/<id>/fff), bare-relative paths (raw_files/foo.txt), or case-insensitive variants.
  Fixes

  setup.sh is now a real installer (9d7aef6) — previously only synced files and assumed the plugin was already installed; fresh users hit silent failures where hooks never fired. Now handles three states: fresh install (registers marketplace + runs claude plugin install), stale marketplace path (fixes + reinstalls), and already-installed (syncs cache). Uninstall on both CC + OpenClaw now calls the platform CLIs.
  Docs

  Phase 0 MCP namespace in ARCHITECTURE.md (c85d25a) — documents the per-platform + mcp tool-gate layout.
  config.default.yaml rewritten (bundled with 828022b) — every field under guard.action_guard_rules + file_scan_rules now documents matching semantics, syntax, and examples. Calls out the sensitive_paths leading-slash footgun explicitly.
  ACTION-POLICIES.md "User-Supplied Sensitive Path Patterns" section (bundled with 828022b).
  Tests

  tests (e333088) across 3 new suites — action-guard-rules.test.ts (29), file-scan-rules.test.ts (13), guard-config.test.ts (15). Suite: 444/444 passing (was 387).

- e333088: - **New `action_guard_rules.sensitive_path_patterns` field**: regex companion to the existing substring-based `sensitive_paths`. Closes a gap where the substring matcher (`includes("/" + pattern)` OR `endsWith(pattern)`) couldn't match dynamic path segments (`/abc/<id>/fff`), bare-relative paths anchored at position 0 (`raw_files/foo.txt`), or case-insensitive variants. Accepts the same `/pattern/flags` syntax as other regex fields. Invalid entries are silently skipped.

  - **`config.default.yaml` rewritten**: every field under `guard.action_guard_rules` and `guard.file_scan_rules` now has detailed comments covering purpose+severity, exact matching semantics, regex syntax, and copy-paste examples. The `sensitive_paths` block calls out the leading-slash footgun explicitly (`/etc/` becomes `//etc/` internally and almost never matches — use `etc/`).

  - **`plugins/shared/skill/ACTION-POLICIES.md`**: added "User-Supplied Sensitive Path Patterns" section documenting both layers (substring + regex) and how they feed the `SENSITIVE_PATH` finding.

  - **+57 tests** across 3 new suites — `action-guard-rules.test.ts` (29), `file-scan-rules.test.ts` (13), `guard-config.test.ts` (15) — covering the user-extension path of every previously untested field under `guard.*` (positive, negative, matcher-branch-specific, invalid-regex-skip). Suite is now 444/444 passing (was 387).

## 1.0.3

### Patch Changes

- - **YAML-only config**: runtime config is now exclusively `~/.ffwd-agent-guard/config.yaml`. JSON fallback removed; `setup.sh --reset-config` generates `config.yaml` directly.
  - **`/pattern/flags` regex syntax**: user-supplied regex patterns in config now accept the literal `/pattern/flags` form (e.g. `'/\b(INSERT|UPDATE)\b/i'`) for case-insensitive and other flag combinations. Plain patterns still work for backward compat. Applied everywhere user regex is compiled (Phase 2 runtime + Phase 3 static file_scan_rules).
  - **Config load errors now visible**: YAML syntax errors and Zod validation failures previously failed silently. They now print to stderr and write a `config_error` entry to `~/.ffwd-agent-guard/audit.jsonl`, with per-process dedup. Runtime continues with defaults (fail-open).
  - **`action_guard_rules.secret_patterns` now wired up**: previously declared in the schema but never consumed. User regexes are now evaluated against network request bodies; matches emit a new `SECRET_LEAK_USER` finding (high) with the pattern source in the title.

  - **User `dangerous_patterns` no longer mislabeled**: matches were being reported as `DANGEROUS_COMMAND` / "Dangerous command: pipe to shell" regardless of which user pattern fired. They now have their own rule_id `DANGEROUS_PATTERN` and a title echoing the matching pattern source.
  - **Phase 2 collects all findings per action**: `analyzeBashCommand` no longer short-circuits the function on the first critical hit. Every rule set is evaluated on every command; the decision is unchanged (aggregated score still drives DENY), but audit logs now show every dimension a command touches — better signal for forensics and rule tuning.

  - `plugins/shared/skill/ACTION-POLICIES.md`: documented `DANGEROUS_PATTERN` and `SECRET_LEAK_USER` rule_ids, the `/pattern/flags` syntax, and rewrote "Exec Decision Logic" to reflect the non-short-circuiting behaviour.
  - Various `config.json` → `config.yaml` corrections across `docs/ARCHITECTURE.md`, `README.md`, plugin SKILL.md files, and `config.schema.json`.

  - +3 suites covering `dangerous_patterns` (5 cases), `secret_patterns` (3 cases), and the shared regex compiler (9 cases). 387/387 passing.

## 1.0.2

### Patch Changes

- Features

  Add guard.confirm_action config (allow | deny | ask, default allow) to control how each platform handles a confirm decision. Fixes OpenClaw incorrectly blocking the 0.5–0.8 balanced-mode range (no native interactive confirm); Claude Code can also force allow/deny instead of prompting.

  Refactor

  Consolidate skill docs under plugins/shared/skill/ as the single source of truth, synced to both platform plugin dirs during build — eliminates drift between Claude Code and OpenClaw copies.
  Restructure OpenClaw plugin layout: runtime files moved into plugins/openclaw/plugin/ subdir, isolated from skills/ to avoid false positives from OpenClaw's plugin validator.

  Fix

  Release flow now cleans up stale release artifacts before publishing a new version.

## 1.0.1

### Patch Changes

---
