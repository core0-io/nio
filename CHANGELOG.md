# @core0-io/nio

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
