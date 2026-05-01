# @core0-io/nio

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
