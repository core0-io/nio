# Architecture

## Overview

Nio is a two-pipeline execution assurance framework for autonomous AI agents:

1. **Static Scan** — On-demand multi-engine code analysis (Static + Behavioural + LLM)
2. **Dynamic Guard** — Real-time hook protection via 6-phase ActionOrchestrator pipeline

```
┌─────────────────────────────────────────────────────────┐
│ Static Scan (on-demand, triggered by user)              │
│   /nio scan <path>                         │
│   → ScanOrchestrator → Static + Behavioural + LLM       │
│   → Finding[] → ScanResult                              │
│   → writes scan-cache for dynamic guard to read         │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ Dynamic Guard (real-time, every PreToolUse hook)        │
│   guard-hook → evaluateHook() → ActionOrchestrator      │
│   → 6-phase pipeline → allow / deny / confirm           │
└─────────────────────────────────────────────────────────┘
```

---

## Dynamic Guard: Phase 0–6 Pipeline

Every `PreToolUse` hook event flows through the guard pipeline.
Phase 0 is a tool-level gate (in `hook-engine.ts`). Phases 1–6 run in
the ActionOrchestrator, each producing a 0–1 score that can short-circuit
if it exceeds the deny threshold for the active protection level.

### High-Level Flow

```
                         ┌──────────────┐
                         │  Hook Event  │
                         │ (PreToolUse) │
                         └──────┬───────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Phase 0: Tool Gate (<1ms)  [hook-engine.ts, before envelope build]  │
│                                                                     │
│   tool_name ──► in blocked_tools? ──YES──► DENY (exit)             │
│                    │ NO                                              │
│                    ▼                                                 │
│              permitted_tools non-empty?                              │
│                    │ YES                                             │
│                    ▼                                                 │
│              tool_name in permitted_tools? ──NO──► DENY (exit)     │
│                    │ YES                                             │
│                    ▼                                                 │
│              tool_name in native_tool_mapping? ──NO──► ALLOW (exit) │
│                    │ YES                                             │
│                    ▼                                                 │
│              Build ActionEnvelope                                    │
│                    │                                                 │
│                    ▼                                                 │
│              Nio self-invocation? ──YES──► ALLOW silent (exit)     │
│                    │ NO                   [action-cli subprocess    │
│                    │                       runs Phase 1-6 itself]   │
│                    ▼                                                 │
│              proceed to Phase 1                                      │
└────────────────────┬────────────────────────────────────────────────┘
                     │ passed gate
                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Phase 1: Allowlist Gate (<1ms)                                      │
│                                                                     │
│   action ──► match safe prefix? ──YES──┐                           │
│                    │ NO                 ▼                           │
│                    │            allowlist_mode?                     │
│                    │           ┌────────┴────────┐                  │
│                    │           ▼                 ▼                  │
│                    │       continue             exit                │
│                    │      (default)                                 │
│                    │           │                 │                  │
│                    │           ▼                 ▼                  │
│                    │      hint only,        ALLOW (exit)            │
│                    │      continue                                  │
│                    ▼                                                 │
│              has shell metachar? ──YES──► skip allowlist, continue  │
│                    │ NO                                              │
│                    ▼                                                 │
│              match extra_allowlist? ──YES──► (same branch as above) │
└────────────────────┬────────────────────────────────────────────────┘
                     │ not matched / continue mode
                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Phase 2: Pattern Analysis (<5ms) → `runtime` score                  │
│                                                                     │
│   ┌─ Bash ──────────────────────────────────────────────┐           │
│   │  dangerous cmds · fork bombs · metachar injection   │           │
│   │  base64 decode · sensitive path targets             │           │
│   └─────────────────────────────────────────────────────┘           │
│   ┌─ Network ───────────────────────────────────────────┐           │
│   │  webhook exfil domains · high-risk TLDs             │           │
│   │  secret leak in HTTP body                           │           │
│   └─────────────────────────────────────────────────────┘           │
│   ┌─ File ops ──────────────────────────────────────────┐           │
│   │  path traversal · sensitive path detection          │           │
│   └─────────────────────────────────────────────────────┘           │
│                                                                     │
│   Finding[] → runtime score ──► ≥ deny threshold? ──YES──► DENY    │
└────────────────────┬────────────────────────────────────────────────┘
                     │ below deny threshold
                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Phase 3: Static Analysis (<50ms) → `static` score                   │
│ [Write/Edit only — skip for Bash/WebFetch]                          │
│                                                                     │
│   file content ──► 15 regex rules ──► base64 decode pass           │
│   (SHELL_EXEC, REMOTE_LOADER, OBFUSCATION, WEBHOOK_EXFIL, ...)    │
│                                                                     │
│   Finding[] → static score ──► ≥ deny threshold? ──YES──► DENY     │
└────────────────────┬────────────────────────────────────────────────┘
                     │ below deny threshold
                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Phase 4: Behavioural Analysis (<200ms) → `behavioural` score          │
│ [Write/Edit only — JS/TS/Python/Shell/Ruby/PHP/Go]                  │
│                                                                     │
│   file content ──► LanguageExtractor ──► ASTExtraction              │
│                         │                                           │
│        ┌────────────────┼────────────────┐                          │
│        ▼                ▼                ▼                           │
│   ┌─────────┐    ┌───────────┐    ┌──────────┐                     │
│   │ JS/TS   │    │  Python   │    │ Shell/   │                     │
│   │ (Babel  │    │  (regex)  │    │ Ruby/    │                     │
│   │  AST)   │    │           │    │ PHP/Go   │                     │
│   └────┬────┘    └─────┬─────┘    └────┬─────┘                     │
│        └───────────────┼───────────────┘                            │
│                        ▼                                            │
│              Dataflow Tracker (language-aware)                       │
│              source → sink taint propagation                        │
│                        │                                            │
│                        ▼                                            │
│              Cross-file Context Aggregation                         │
│              capability detection (C2, eval)                        │
│                                                                     │
│   Finding[] → behavioural score ──► ≥ deny threshold? ──YES──► DENY │
└────────────────────┬────────────────────────────────────────────────┘
                     │ below deny threshold
                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Phase 5: LLM Analysis (2–10s) → `llm` score                        │
│ [Optional — gated on llm.api_key config]                            │
│                                                                     │
│   action context ──► Claude semantic analysis                       │
│   (Write: file content, Bash: shell script, Network: request JSON) │
│                                                                     │
│   Finding[] → llm score ──► ≥ deny threshold? ──YES──► DENY        │
└────────────────────┬────────────────────────────────────────────────┘
                     │ below deny threshold
                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Phase 6: External Scoring APIs → `external` scores (0..N endpoints) │
│ [Optional — gated on guard.external_analyser config]                │
│                                                                     │
│   GET <endpoint>?<query…>&start=<iso>&end=<iso>                    │
│       Authorization: Bearer <token>                                 │
│   ← { score: 0.0–1.0, reason?: string }                            │
│                                                                     │
│   All enabled endpoints run concurrently; each contributes via      │
│   its own `weight`. Any endpoint ≥ deny threshold ──► DENY (exit).  │
└────────────────────┬────────────────────────────────────────────────┘
                     │ below deny threshold
                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Final: Weighted Score Aggregation                                   │
│                                                                     │
│   final = Σ(weight[phase] × score[phase]) / Σ(weight[phase])      │
│           (only over phases that ran)                               │
│                                                                     │
│   final score ──► protection level thresholds ──► ALLOW/CONFIRM/DENY│
└─────────────────────────────────────────────────────────────────────┘
```

### Which phases run per action type

| Phase | Bash | Write/Edit | WebFetch | MCP tool call | Read/Grep/Glob/etc. |
|-------|------|------------|----------|---------------|---------------------|
| 0 Tool Gate | yes | yes | yes | yes | yes |
| 1 Allowlist | yes | yes | yes | runs, no match | skip (no envelope) |
| 2 Pattern Analysis | yes | yes | yes | runs, no built-in rules | skip |
| 3 Static Analysis | skip | yes (file content) | skip | yes (args as `.json`) | skip |
| 4 Behavioural Analysis | skip | yes (.js/.ts/.py/.sh/.rb/.php/.go) | skip | skip (not executable) | skip |
| 5 LLM (optional) | yes | yes | yes | yes | skip |
| 6 External API (optional) | yes | yes | yes | yes | skip |

Native tools absent from `native_tool_mapping` follow a fallback chain in `evaluateHook`:

1. If the tool name matches the platform's MCP convention, it dispatches as `mcp_tool_call` (server / tool / args inferred from the hook payload) and runs through Phase 1–6. Phase 3 / 5 / 6 see the JSON-serialised arguments; Phase 1 (allowlist) and Phase 2 (pattern) execute but currently have no MCP-specific rules — user-defined `action_guard_rules` don't route to MCP today.
2. Otherwise it is allowed through with a `UNCATEGORIZED_TOOL:<tool_name>` risk tag in the audit entry (`phase_stopped: 0`) and Phase 1–6 are skipped. The colon-suffixed tool name (same shape as `EXTERNAL_SCORE:<scorer>`) lets downstream queries group / filter by which tool was unmapped without joining on `tool_name`.

### Phase 0: Tool Gate (<1ms)

Runs in `hook-engine.ts` before envelope building. Four checks in order:

1. **blocked_tools** — if tool is listed → DENY
2. **permitted_tools** — if list is non-empty and tool is not listed → DENY
3. **native_tool_mapping** — if tool is mapped → continue to Phase 1 with the mapped action type
4. **MCP fallback** — if the tool name matches an MCP convention (see MCP routing below) → continue to Phase 1 as a synthetic `mcp_tool_call` action; otherwise → ALLOW with a `UNCATEGORIZED_TOOL:<tool_name>` audit entry (skip Phase 1–6)

After Phase 0 and envelope construction (but before Phase 1), a further
short-circuit fires when the incoming `exec_command` is Nio invoking its
own bundled CLI — e.g. the skill's `/nio action ...` flow running
`node <skills-dir>/nio/scripts/action-cli.js …` via `Bash`. Such calls
pass silently (no audit entry); the spawned `action-cli` subprocess then
runs its own full Phase 1–6 on the real envelope. This avoids a double
content analysis and prevents the outer hook from denying a skill query
just because the Bash command string embeds a literal dangerous token.
Detection is a strict regex on the command shape
(`isNioSelfInvocation` in [src/adapters/self-invocation.ts](../src/adapters/self-invocation.ts));
any shell metacharacter in the command disqualifies the match.

`permitted_tools` and `blocked_tools` are keyed by platform (`claude_code`,
`codex`, `openclaw`, `hermes`, `pi`, `opencode`) with one reserved
cross-platform key `mcp`.
Incoming MCP tool names are parsed into `{server?, local}`:

- Claude Code / Codex: `mcp__<server>__<tool>` (double underscore).
- OpenClaw: `<server>__<tool>` (double underscore).
- Hermes: either `<server>__<tool>` (double underscore — server-qualified) or
  the flattened `mcp_<...>` single-underscore form Hermes emits when it can't
  preserve the separator. The single-underscore form has no reliable server /
  tool split, so the full tool name is kept as the local name and `server` is
  unset — list it verbatim in `permitted_tools.mcp` (e.g.
  `mcp_config_db_get_current_config`), no prefix stripping.
- opencode: `<sanitize(server)>_<sanitize(tool)>` where
  `sanitize = s.replace(/[^a-zA-Z0-9_-]/g, "_")` — there is no fixed
  delimiter, so the parser works in two tiers: longest matching server
  prefix from the registry, else keep the **full** tool name as `local`
  with `server` unset (same convention as Hermes's flattened form). With
  no MCP servers configured nothing is treated as MCP. opencode's sixteen
  built-in tool names short-circuit the fallback tier so `apply_patch` —
  the one underscored built-in — is never mis-gated as an MCP call.
- Pi: **Pi core has no MCP.** The third-party `pi-mcp-adapter` package
  supplies it and is the de-facto default for Pi users, in two shapes.
  (1) Default: a single proxy tool literally named `mcp`, carrying its
  target in the `tool` parameter and optionally the server in `server` —
  this is the one branch that reads `tool_input` rather than the tool
  name. Adapter modes that carry no target (`connect` / `describe` /
  `search` / `action`) are still MCP surface and are gated under the bare
  name `mcp`. (2) Opt-in `directTools: true`: one Pi tool per MCP tool,
  named `<server>_<tool>` (`toolPrefix: "server"` / `"short"`) or
  `mcp__<server>_<tool>` (`toolPrefix: "mcp"`), matched against servers
  read from `$PI_CODING_AGENT_DIR/mcp.json` (else `~/.pi/agent/mcp.json`).
  Unlike opencode, an unattributable `<something>_<something>` is **not**
  claimed as anonymous MCP — on Pi that form coexists with arbitrary
  native tools from other extensions, so only the unambiguous `mcp__`
  marker is trusted. `toolPrefix: "none"` emits bare tool names that are
  byte-identical to native calls; those are **not detectable** and Nio
  does not guess — `/nio doctor` says so explicitly.

Allowlist entries match either bare (`HassTurnOn` — any server, plus Hermes's
single-underscore form when listed verbatim) or server-qualified
(`hass__HassTurnOn` — that server only). Blocked lists across namespaces
are additive; permitted lists are independent per namespace, with the
platform list acting as fallback when `permitted_tools.mcp` is absent.
Matching is case-insensitive throughout.

The `mcp` list also covers **indirect shell invocations** that target an
MCP server without going through the platform's MCP tool surface
(mcporter, raw HTTP clients, language-runtime one-liners, stdio pipes,
package runners, …). Phase 0 unwraps the shell command, runs a battery
of detectors against every fragment, maps each hit back to a registered
MCP server (auto-discovered or declared in `mcp_servers`), and re-applies
the same `permitted_tools.mcp` / `blocked_tools.mcp` lists. The full
capture model — 16 unwrappers + 16 detectors + the MCP server registry —
is documented in
[Phase 0 — Tool Gate · MCP Tool Routing](phases/phase-0-tool-gate.html#mcp-routing).

### Phase 1: Allowlist Gate (<1ms)

Check if the action matches a known-safe pattern.

- 50+ safe command prefixes: `git status`, `ls`, `npm test`, etc.
- Only applied when command has no shell metacharacters (`;`, `|`, `$()`, etc.)
- User can inject additional patterns via `config.yaml` → `guard.allowed_commands`

What happens on match is controlled by `guard.allowlist_mode`:

- **`continue`** (default) — treat the match as a hint only and continue
  running Phase 2–6. This ensures `llm_analyser` / `external_analyser` and
  `action_guard_rules.dangerous_patterns` always get to inspect the command,
  so the local allowlist can't silently bypass them. For common read-only
  commands (`ls`, `git status`, ...) the extra cost is typically <5 ms
  (Phase 2 only).
- **`exit`** — allow + exit immediately. Fastest path, zero cost for
  allowlisted commands. Use when you trust the static allowlist fully
  and don't run any dynamic/external policy checks. The shell-metacharacter
  safety guard still applies — commands with `;`, `|`, `$()`, etc. are
  never treated as allowlist matches.

### Phase 2: Pattern Analysis (<5ms) → `runtime`

Produces `Finding[]` from action data pattern matching:

- **Bash**: dangerous commands, fork bombs, shell injection, system/network commands, base64 decode
- **Network**: webhook exfil domains, high-risk TLDs, secret leak in body
- **File ops**: path traversal, sensitive path detection (`.env`, `.ssh/`, `.aws/`)

### Phase 3: Static Analysis (<50ms) → `static`

**Only runs for Write/Edit actions** (file content exists to scan).
Runs the scan engine's 15 static rules + base64 decode pass against the file
content being written.

### Phase 4: Behavioural Analysis (<200ms) → `behavioural`

**Only runs for Write/Edit actions** where content is a supported language.
Uses a pluggable `LanguageExtractor` interface to extract sources, sinks, imports,
and functions, then runs language-aware dataflow tracking.

**Supported languages:**

| Language | Extractor | Parser |
|----------|-----------|--------|
| JavaScript/TypeScript | `jsExtractor` | Babel AST (`@babel/parser`) |
| Python | `pyExtractor` | Regex-based |
| Shell (sh/bash/zsh) | `shExtractor` | Regex-based |
| Ruby | `rbExtractor` | Regex-based |
| PHP | `phpExtractor` | Regex-based |
| Go | `goExtractor` | Regex-based |

**Source → Sink patterns per language:**

| Pattern | JS/TS | Python | Shell | Ruby | PHP | Go |
|---------|-------|--------|-------|------|-----|-----|
| Env access | `process.env` | `os.environ` | `$VAR` | `ENV[]` | `$_ENV` | `os.Getenv()` |
| File read | `fs.readFileSync` | `open().read()` | `$(cat)` | `File.read` | `file_get_contents` | `os.ReadFile` |
| Command exec | `exec()` | `subprocess.run` | `eval` | `system()` | `exec()` | `exec.Command` |
| Code eval | `eval()` | `eval/exec` | `eval` | `eval()` | `eval()` | `reflect.Call` |
| Network send | `fetch()` | `requests.post` | `curl -d` | `Net::HTTP.post` | `curl_exec` | `http.Post` |

### Phase 5: LLM Analysis (2–10s, optional) → `llm`

**Gated on `llm.api_key` in config.** Sends action context to Claude for
semantic analysis. For Write/Edit, analyses the file content. For Bash, wraps
the command as a shell script. Reuses the existing `LLMAnalyser` from the scan pipeline.

### Phase 6: External Scoring APIs (optional) → `external`

**Gated on `guard.external_analyser` array in config.** 0..N endpoints; each
runs concurrently with `Promise.allSettled`. nio issues a `GET` against each
configured URL (with any query params the user encodes) and expects a
0–1 score back. Each endpoint contributes to the weighted average via its
own per-endpoint `weight`.

The `ExternalAnalyser` is a standalone module (`src/core/analysers/external/`)
usable by both pipelines:
- `scoreAction()` — guard pipeline (ActionOrchestrator Phase 6)
- `scoreScan()` — scan pipeline (ScanOrchestrator post-phase)

```yaml
guard:
  external_analyser:
    - name: scorer_primary
      endpoint: "https://my-security-api.example.com/scores/agent?agent-name=cc"
      weight: 2.0
      timeout: 3000
      # headers: { X-Tenant-Id: "..." }   # optional custom headers
      auth:                              # optional: bearer | oauth
        type: oauth
        oauth_url:     "https://my-security-api.example.com/oauth"
        client_id:     "..."
        client_secret: "..."
```

OAuth uses `client_credentials` grant against `<oauth_url>/token`; access
tokens cache to `~/.nio/oauth-cache/<host>-<fp>.json` (mode 0600) and are
re-fetched when near expiry. Endpoints sharing the same `(oauth_url,
client_id, client_secret)` share a single token + in-process strategy.

### Score Aggregation

Each phase produces a 0–1 score via `findingsToScore()`:
`score = max(severity_weight / 4 * confidence)` across all findings.

Final score is a weighted average of all phases that ran:

```
final_score = Σ(wi × si) / Σ(wi)
```

**Short-circuit override.** Before the weighted average is taken, the
orchestrator checks each phase's score against the active level's deny
threshold (strict: 0.5, balanced: 0.8, permissive: 0.9). The first phase
whose score crosses that threshold short-circuits the pipeline: that
score becomes the final score, downstream phases are skipped, and the
verdict is `deny`. Phase 6 evaluates this **per endpoint** — any single
`external_analyser` endpoint that crosses the threshold short-circuits,
even if its sibling endpoints would have dragged the weighted average
back into the allow zone. Rationale: a high score from one phase should
not be diluted by quieter siblings — this preserves symmetry with
Phase 2 critical findings, which would have stopped the pipeline before
any later phase could run.

Default weights:

| Phase | Weight | Rationale |
|-------|--------|-----------|
| `runtime` | 1.0 | Pattern matching — fast but coarse |
| `static` | 1.0 | Regex rules on file content |
| `behavioural` | 2.0 | AST/regex dataflow — more reliable |
| `llm` | 1.0 | Semantic analysis — broad but slow |
| `external` | 2.0 | External API — authoritative |

### Protection Level → Decision Mapping

| Mode | allow | confirm | deny |
|------|-------|---------|------|
| **strict** | 0 — 0.5 | _(none)_ | 0.5 — 1.0 |
| **balanced** | 0 — 0.5 | 0.5 — 0.8 | 0.8 — 1.0 |
| **permissive** | 0 — 0.9 | _(none)_ | 0.9 — 1.0 |

- **strict**: binary allow/deny, no user confirmation — anything suspicious is blocked
- **balanced**: three-zone with confirm buffer — the default mode
- **permissive**: binary allow/deny with high tolerance — only blocks near-certain threats

The `guard.confirm_action` config controls what happens when the decision is "confirm":
- `allow` (default) — let the action through, record in audit log
- `deny` — block the action (same as deny)
- `ask` — use platform-native confirm where the host has one; where it
  does not, the fallback is **per-platform** (allow on OpenClaw, deny on
  Hermes — see below), not a single global rule

Which hosts can actually ask:

- **Claude Code** — yes. `guard-hook.ts` calls `outputAsk`, which prints
  `hookSpecificOutput.permissionDecision: 'ask'` with the guard's reason
  as `permissionDecisionReason`; Claude Code turns that into a real host
  permission prompt.
- **Pi** — yes, and it is the only host with a first-class interactive
  channel of its own: the `tool_call` handler opens a real
  `ctx.ui.confirm` dialog with a 60 s timeout, and because Pi's
  `confirm()` returns `false` on timeout an absent human reads as a
  refusal instead of hanging the agent. In print mode (`pi -p`,
  `ctx.hasUI === false`) there is no channel, so it folds back to the
  two-state behaviour without prompting.
- **opencode** — yes, indirectly. It has no dialog a plugin can open, but
  it does have a native permission system: an `ask` verdict is parked by
  `callID` in `tool.execute.before` and re-applied in `permission.ask`,
  forcing a real prompt (or an outright `deny` when
  `guard.confirm_action: deny`) instead of silently trusting opencode's
  own heuristics.
- **Codex** — Codex runs the *same* `guard-hook.ts` as Claude Code
  (`--platform codex` only swaps the adapter), so it emits the identical
  `permissionDecision: 'ask'` payload. Whether the Codex host honours
  that payload is **not established in this repo** — Codex's
  `PermissionRequest` integration is deferred to phase 2 — so treat Codex
  as unverified rather than supported.
- **Hermes** — no. Hermes has no confirmation channel, and `hook-cli.ts`
  **falls back to deny**, not allow: it returns `decision: 'block'` with
  the guard's reason plus a stderr note that
  `guard.confirm_action: 'ask'` is unsupported on Hermes. This is the one
  place where `ask` is strictly more restrictive than `allow`.
- **OpenClaw** — no. `InProcessPluginRuntime` leaves the provisional
  decision unblocked and the binding never calls `resolveConfirm`, so
  `ask` folds to allow.

### When the engine itself throws

If Phases 1–6 throw — a malformed payload, a stack overflow on a
pathologically nested `tool_input`, a bug — the decision is taken from
`envelope.action.type` **alone**, a value the adapter resolved before the
pipeline was entered:

| Action type | Verdict on engine error |
|-------------|-------------------------|
| `read_file` | **allow**, with a diagnostic |
| `exec_command` · `write_file` · `network_request` · `secret_access` · `mcp_tool_call` (and anything a third-party adapter invents) | **deny**, with a diagnostic |

This replaces the earlier blanket fail-open. The asymmetry that motivates
it: the engine is most likely to fail when its input is strangest, and a
strange input is one of the shapes an attack takes — so a crash must not
become a silent allow of a destructive action. Both branches write an
`engine_error` diagnostic and a guard audit row with
`risk_tags: ["ENGINE_ERROR"]` (`risk_level: critical`, score `1.0` on the
deny branch; `low` / `0` on the allow branch), so the failure is visible
rather than only inferable from an unexplained block. The triage
deliberately consults nothing else: no re-run, no rule lookup, no re-parse
of whatever just threw. Source: `ENGINE_ERROR_ALLOWED_ACTIONS` in
[hook-engine.ts](../src/adapters/hook-engine.ts).

---

## Static Scan: Multi-Engine Pipeline

The scanner uses a **two-phase, multi-engine pipeline**:

```
              Phase 1 (parallel)                    Phase 2 (sequential)

           ┌──────────────────────┐
           │   Static Analyser    │
           │  (regex, 15 rules)   │──┐
           └──────────────────────┘  │
                                     ├─ merge ──► ┌──────────────────────┐
           ┌──────────────────────┐  │            │    LLM Analyser      │
           │ Behavioural Analyser  │──┘            │  (Claude semantic)   │
           │ (multi-lang dataflow)│               └──────────┬───────────┘
           └──────────────────────┘                          │
                                                             ▼
                                                 ┌──────────────────────┐
                                                 │   Post-Processing    │
                                                 │  dedup + filter +    │
                                                 │  sort + project      │
                                                 └──────────┬───────────┘
                                                            │
                                                            ▼
                                                      ScanResult
                                                   (+ scan-cache write)
```

### Static Analyser (Phase 1)

Deterministic pattern-based detection using regex rules. Handles all file types.

**Detection passes:**
1. **Pattern matching** — 15 rules across 7 modules against file content
2. **Base64 decoding** — Extract and re-scan encoded payloads
3. **Markdown extraction** — Only scan fenced code blocks in `.md` files

**15 detection rules:** SHELL_EXEC, AUTO_UPDATE, REMOTE_LOADER, READ_ENV_SECRETS,
READ_SSH_KEYS, READ_KEYCHAIN, PRIVATE_KEY_PATTERN, NET_EXFIL_UNRESTRICTED,
WEBHOOK_EXFIL, OBFUSCATION, PROMPT_INJECTION, TROJAN_DISTRIBUTION,
SUSPICIOUS_PASTE_URL, SUSPICIOUS_IP, SOCIAL_ENGINEERING

### Behavioural Analyser (Phase 1)

Multi-language dataflow analysis with pluggable extractors:

```
Source File (.ts/.py/.sh/.rb/.php/.go)
    ↓
LanguageExtractor (dispatch by extension)
    ├── jsExtractor  → Babel AST (@babel/parser)
    ├── pyExtractor  → regex-based
    ├── shExtractor  → regex-based
    ├── rbExtractor  → regex-based
    ├── phpExtractor → regex-based
    └── goExtractor  → regex-based
    ↓
ASTExtraction { imports, functions, sources, sinks, suspiciousStrings }
    ↓
Dataflow Tracker (language-aware assignment extraction)
    ↓
Source → Sink Analysis
    ↓
Cross-file Context Aggregation
    ↓
Finding Generation
```

**Sources** (data origins): env vars, file reads, credential files, user input, network responses
**Sinks** (dangerous destinations): command exec, code eval, network send, file write, process spawn

**Behavioural rules:**

| Rule | Severity | Detection |
|------|----------|-----------|
| `DATAFLOW_EXFIL` | critical | Secret/credential flows to network |
| `DATAFLOW_RCE` | critical | Network response flows to eval/exec |
| `DATAFLOW_CMD_INJECT` | high | User input flows to command execution |
| `DATAFLOW_EVAL` | high | Data flows to eval/Function |
| `CAPABILITY_C2` | high | Skill has both exec + network capabilities |
| `CAPABILITY_EVAL` | high | Skill uses dynamic code evaluation |
| `CROSS_FILE_FLOW` | medium | Data crosses file boundaries |

### LLM Analyser (Phase 2)

Uses Claude for semantic threat analysis, enriched by Phase 1 findings.

- **Injection protection** — Wraps untrusted code in random delimiters
- **Scoped analysis** — Only sends files with Phase 1 findings (token budget)
- **Structured output** — JSON response with threat taxonomy mapping
- **Optional** — Gated on `ANTHROPIC_API_KEY` and `policy.analysers.llm`

### Post-Processing

1. **Deduplication** — Same rule + file + lines within 3 → keep highest severity
2. **Severity filtering** — Drop below `min_severity` from policy
3. **Sorting** — Critical first, then by file + line
4. **Projection** — `Finding[]` → legacy `ScanEvidence[]` + `RiskTag[]`
5. **Cache write** — Optional: persist to scan-cache when `skillId` provided

---

## Key Abstractions

### Finding

Primary output unit — every analyser produces `Finding[]`:

```typescript
interface Finding {
  id: string;                  // deterministic hash
  rule_id: string;             // e.g. "SHELL_EXEC", "DATAFLOW_EXFIL"
  category: ThreatCategory;    // execution | exfiltration | secrets | ...
  severity: Severity;          // info | low | medium | high | critical
  title: string;
  description: string;
  location: { file, line, column?, snippet? };
  remediation?: string;
  analyser: 'static' | 'behavioural' | 'llm';
  confidence: number;          // 0.0–1.0
}
```

### ActionDecision

Output of the dynamic guard pipeline (returned by
`ActionOrchestrator.evaluate()`):

```typescript
interface ActionDecision {
  decision: 'allow' | 'deny' | 'confirm';
  risk_level: RiskLevel;
  findings: Finding[];
  scores: {
    runtime?: number;      // Phase 2 RuntimeAnalyser
    static?: number;       // Phase 3 StaticAnalyser
    behavioural?: number;  // Phase 4 BehaviouralAnalyser
    llm?: number;          // Phase 5 LLMAnalyser
    external?: number;     // Phase 6 ExternalAnalyser
    final?: number;        // weighted aggregate
  };
  phase_stopped: 1 | 2 | 3 | 4 | 5 | 6;
  explanation?: string;
}
```

### LanguageExtractor

Pluggable interface for multi-language behavioural analysis:

```typescript
interface LanguageExtractor {
  readonly language: Language;
  readonly extensions: ReadonlySet<string>;
  extract(source: string, filePath: string): ASTExtraction | null;
}

type Language = 'javascript' | 'python' | 'shell' | 'ruby' | 'php' | 'go';
```

### BaseAnalyser

```typescript
abstract class BaseAnalyser {
  abstract readonly name: 'static' | 'behavioural' | 'llm';
  abstract readonly phase: 1 | 2;
  abstract analyse(ctx: AnalysisContext): Promise<Finding[]>;
  isEnabled(policy: ScanPolicy): boolean;
}
```

### ScanPolicy

Controls scan analysis behaviour. Three presets:

| Preset | Analysers | Min Severity |
|--------|-----------|-------------|
| `strict` | static + behavioural + llm | info |
| `balanced` | static + behavioural | low |
| `permissive` | static only | medium |

### ScanCache

File-backed cache (`~/.nio/scan-cache.json`) with 24h TTL.
Written by `ScanOrchestrator` after scans. Entries track skill ID, risk level,
and finding counts for use as context by the guard pipeline.

### ExternalAnalyser

Standalone HTTP scorer usable by both pipelines:

```typescript
class ExternalAnalyser {
  scoreAction(toolName, toolInput, priorScores, priorFindings): Promise<{score, reason?} | null>;
  scoreScan(skillId, files, priorFindings): Promise<{score, reason?} | null>;
}
```

---

## Collector: Telemetry Pipeline

Captures agent activity as **OpenTelemetry** metrics, traces, and logs. Runs independently from the guard — never influences allow/deny decisions.

For the full per-signal schema (every metric instrument, every span attribute, every audit entry field) see [COLLECTOR-SIGNALS.md](COLLECTOR-SIGNALS.md). The sections below cover architecture, source of truth, and lifecycle.

### Capture gating — off by default

A configured `collector.endpoint` does **not** by itself export anything.
Every session is silent until the user arms it (`/nio monitor on`, or the
focused `/nio-monitor` skill) or the operator sets
`collector.monitor_all_sessions: true`. The verdict is computed against
`${NIO_HOME}/monitored-sessions.json` and is applied **before any OTEL
provider is constructed** — an unmonitored session never stands up an
exporter, so the cost is one small file read per hook event.

All three OTLP signals are behind that gate, including the conversation
content that rides on spans (`nio.chat.reply`,
`gen_ai.tool.call.arguments`) as well as the content log records. Outside
the gate: guard enforcement (Phases 0–6 run regardless), the local
`~/.nio/audit.jsonl`, and the two opt-in outbound guard paths (Phase 5
`guard.llm_analyser`, Phase 6 `guard.external_analyser`), which have their
own switches and ship disabled.

### Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ Claude Code (cross-process; spawn-per-hook)                         │
│                                                                     │
│   collector-hook.ts (async, runs per hook event)                    │
│     └─ dispatchCollectorEvent → traces-collector pure functions     │
│        + state via traces-state-store.json (cross-process bridge)   │
│                                                                     │
│   guard-hook.ts (sync, runs per PreToolUse)                         │
│     ├─ MeterProvider → guard decision + risk score metrics          │
│     ├─ TracerProvider → on deny / confirm-denied, emits a complete  │
│     │  execute_tool span synchronously (PostToolUse never fires)    │
│     └─ pending_guard_attrs in state file → handed off to            │
│        collector-hook PostToolUse so allow spans also carry         │
│        nio.guard.* attrs                                            │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ Hermes (cross-process; spawn-per-shell-hook)                        │
│                                                                     │
│   hook-cli.ts (single binary handling all 7 lifecycle events)       │
│     ├─ HERMES_COLLECTOR_EVENTS map: snake_case → canonical          │
│     │   (post_tool_call→PostToolUse, pre_llm_call→UserPromptSubmit, │
│     │    post_llm_call→Stop, on_session_start→SessionStart, …)      │
│     ├─ pre_tool_call: guard pipeline + collector dispatch combined  │
│     └─ everything else: dispatchCollectorEvent → same code path     │
│        as Claude Code (traces-collector + traces-state-store)       │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ OpenClaw · Pi · opencode (in-process plugins)                       │
│                                                                     │
│   InProcessPluginRuntime  (src/adapters/plugin-runtime.ts)          │
│     ├─ MeterProvider → all metrics (tool use + turn + decision)     │
│     ├─ TracerProvider → all traces via traces-collector pure        │
│     │  functions (same as Claude Code / Hermes), with per-session   │
│     │  Map<sessionId, CollectorState> held in memory.               │
│     │   └─ No state file needed — same process across events        │
│     └─ platform bindings translate host events into its methods:    │
│          openclaw-plugin.ts · pi-plugin.ts · opencode-plugin.ts     │
└─────────────────────────────────────────────────────────────────────┘
```

Every platform feeds the same `traces-collector` pure-function API and the same `writeAuditLog` audit-log writer. Span names and attribute keys are unified; the only difference is the persistence substrate for cross-event state (disk for Claude Code / Codex / Hermes, memory for OpenClaw / Pi / opencode).

### In-process plugin runtime (OpenClaw · Pi · opencode)

Nio has **two** integration models.

- **Subprocess hook model — Claude Code, Codex, Hermes.** The host spawns a fresh `node` process per hook event (`guard-hook.ts` / `collector-hook.ts` / `hook-cli.ts`). Nothing survives between events in memory, so a `PreToolUse` in process A and its matching `PostToolUse` in process B bridge state through the on-disk `traces-state-store.json`. Blocking is done by writing a decision to stdout in the host's hook protocol.
- **In-process plugin model — OpenClaw, Pi, opencode.** Nio is loaded as a JS module inside the agent process and stays resident, so per-session state lives in an in-memory `Map<sessionId, CollectorState>`. Blocking is done by returning or throwing from a hook the host awaits.

The platform-agnostic half of the in-process model lives in one class, [`InProcessPluginRuntime`](../src/adapters/plugin-runtime.ts). It owns:

- config loading and the protection-level / `confirm_action` resolution;
- construction of all three OTEL providers (tracer / meter / logger) from `collector.*`, built lazily on the first event the capture gate answers `true` for, with injectable overrides so tests can drive the traced paths with an in-memory tracer;
- the **capture gate** itself, consulted per event rather than per session so `/nio monitor off` takes effect on the next one, and keyed on the **session's own directory** (`setSessionCwd` / `cwdFor`) rather than `process.cwd()` — one process serves many sessions here, so a process-wide constant cannot decide which of them may claim a pending arm. Only OpenClaw, whose hook context carries no directory at all, opts into a `process.cwd()` answer (`processCwdFallback`);
- per-session `CollectorState` and turn lifecycle (`onSessionStart` / `onUserPrompt` / `onPreTool` / `onPostTool` / `onLlmUsage` / `onAssistantReply` / `onTurnEnd` / `onSessionEnd` / `disposeAllSessions`);
- **conversation accumulation and reconstruction.** Streaming hosts hand over their events (`recordConversationEvent`, capped per session and deduplicated by a caller-supplied key so a snapshot stream costs one slot per logical thing, not one per delivery); Pi hands over a transcript path instead (`setTranscriptPath`). At turn close the runtime picks a `ConversationSource` for its platform and turns the turn's LLM calls into `chat` spans;
- **the content pipeline** — a `ContentSink` handed to `endTurn` so the assistant's reasoning and reply reach the logs signal, plus `tool_input` / `tool_output` records emitted directly at the pre and post sides (the params are only in hand at the pre side, and a denied call has no post side);
- the guard call itself (`evaluateHook`) and the guard-decision → span-attribute translation (`nio.guard.*` + `nio.guard.eval_ms`);
- **orphan-span compensation on the block path** — when the guard denies, the host never fires its post-side event, so the runtime closes the `execute_tool` span itself with ERROR status and the recorded reason. It uses a *safe* close: the decision to block is already final, so a telemetry failure while emitting the span must never cost the caller its deny;
- `resolveConfirm`, for hosts that can actually prompt (Pi), which overwrites the provisional `confirm_allowed` attrs with the real `confirm_allowed` / `confirm_denied` outcome;
- sub-agent task spans (`onSubagentStart` / `onSubagentEnd`) for hosts that have sub-agents;
- the shared `/nio` sub-command router (`dispatchCommand` → `dispatchNioCommand`).

The bindings hold **no telemetry logic of their own** — each is a thin translation from its host's event shapes:

| | OpenClaw | Pi | opencode |
|---|---|---|---|
| Binding | `openclaw-plugin.ts` | `pi-plugin.ts` | `opencode-plugin.ts` |
| Block mechanism | hook return value | `{ block: true, reason }` from `tool_call` | `throw NioBlockedError` from `tool.execute.before` |
| Post-side event | `after_tool_call` | `tool_result` | `tool.execute.after` |
| Turn end | `agent_end` | `agent_end` | `session.idle` |
| `/nio` route | `command-dispatch: tool` → `nio_command` | `pi.registerCommand` (bypasses the LLM) | `commands/nio.md` → `nio_command` tool (goes through the model) |
| Interactive confirm | no | **yes** — `ctx.ui.confirm` | via `permission.ask` re-forcing a prompt |
| Sub-agent spans | yes (`subagent_spawning`) | **no — Pi has no subagent concept** | yes (`session.created` with `parentID`) |
| Session directory | **none** — falls back to `process.cwd()` | `ctx.cwd`, off every event | `input.directory`, one plugin per project |
| Conversation source | `llm_output` event stream | session JSONL replay | `message.updated` / `message.part.updated` snapshots |

Two host quirks are worth calling out because they shape the runtime's contract:

- **opencode skips `tool.execute.after` when the tool itself throws.** The pending span would leak, so the `session.idle` branch doubles as a safety net: `onTurnEnd` force-closes any leftover pending spans before emitting the turn root. Those spans are therefore *reclaimed* rather than closed precisely. `flushSessionTurn` drains the guard attrs parked by `onPreTool` onto them, so they carry the full `nio.guard.*` set, and tags them `nio.span.reclaimed=true` / `nio.span.reclaim_reason=no_post_tool_event` so consumers can filter them out. What remains degraded: the end timestamp is the turn flush rather than the tool's real finish, and there is no `gen_ai.tool.call.result`. The status is deliberately left `UNSET` — at flush time the tool's outcome is unknown, so the span claims neither success nor failure. The audit log and the `guard_decision` metric are emitted pre-side by `onPreTool` and are unaffected. Full caveat in [COLLECTOR-SIGNALS.md](./COLLECTOR-SIGNALS.md#per-platform-signal-coverage).
- **opencode invokes plugin hooks through `Effect.promise(...)`**, which turns any rejection into an Effect *defect* rather than a typed error. Every handler in `opencode-plugin.ts` therefore needs total catch coverage; `NioBlockedError` is the single intentional escape.

Despite its name, [`openclaw-dispatch.ts`](../src/adapters/openclaw-dispatch.ts) is the **shared** implementation of the `/nio` sub-command router and of `/nio doctor` for every in-process platform — the Pi and opencode install probes live there, not in an OpenClaw-only file.

### Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `nio.tool_use.count` | Counter | `gen_ai.tool.name`, `nio.event`, `nio.platform` |
| `nio.turn.count` | Counter | `nio.platform` |
| `nio.decision.count` | Counter | `nio.guard.decision`, `nio.guard.risk_level`, `gen_ai.tool.name`, `nio.platform` |
| `nio.risk.score` | Histogram | `gen_ai.tool.name`, `nio.platform` |

- `decision.count` — recorded by guard-hook (Claude Code) / openclaw-plugin after each `evaluateHook()` call
- `risk.score` — histogram of 0–1 risk scores, enables avg/p50/p99 queries
- `tool_use.count` and `turn.count` — recorded by collector-hook / openclaw-plugin on hook events

### Resource attributes

Every Nio provider (tracer / logger / meter) constructs an OTel `Resource`
with three identity attributes that flow onto **every** span, log
record, and metric data point that provider emits:

| Attribute | Value |
| --- | --- |
| `service.name` | `nio-<platform>` — one independent service per agent runtime: `nio-claude-code`, `nio-codex`, `nio-hermes`, `nio-openclaw`, `nio-pi`, `nio-opencode` |
| `nio.platform` | Raw platform string, same value as the suffix of `service.name` (offered separately so backends that don't expose `service.name` as a queryable attribute still have a filter handle) |
| `gen_ai.agent.name` | Operator-set [`agent_name`](configuration.html#agent_name) from `~/.nio/config.yaml`; **absent on the resource when unconfigured** (turn span carries a platform-default fallback as a span attribute instead) |

Single source of truth: [`buildNioResource(platform, agentName?)`](../src/scripts/lib/traces-collector.ts) — called from each provider factory (`createTracerProvider` / `createLoggerProvider` / `createMeterProvider`) at provider construction. Resource is sent once per OTLP export batch and inherited by every contained span/log/metric.

> **Breaking in v2.4.2** — earlier releases used `service.name="nio"` for all platforms and put `nio.platform` only on individual spans. Existing dashboards filtered on `service.name="nio"` should be re-targeted to `service.name=nio-*` or filter on `nio.platform`.

### Traces

One trace per conversation turn, with child spans per tool call / task. Span
names and attributes follow the OTel [GenAI semantic
conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) where
applicable; Nio-specific extensions use the `nio.*` prefix.

```
Trace: invoke_agent UserPromptSubmit  (root span, UserPromptSubmit → Stop)
  ├─ Span: execute_tool <name>     (PreToolUse → PostToolUse)
  ├─ Span: execute_tool <name>     (PreToolUse → PostToolUse)
  └─ Span: task:execute             (TaskCreated → TaskCompleted)
```

**Turn span (`invoke_agent UserPromptSubmit`) attributes:**

| Attribute | Source |
|-----------|--------|
| `gen_ai.operation.name` | Constant: `invoke_agent` |
| `gen_ai.provider.name` | Constant: `nio` |
| `gen_ai.conversation.id` | Hook stdin `session_id` |
| `gen_ai.agent.name` | User-configured top-level `agent_name` from `~/.nio/config.yaml`; falls back to `nio.platform` when unset. See [Configuration → agent_name](configuration.html#agent_name). |
| `session.id` | Hook stdin `session_id` (mirror of `gen_ai.conversation.id` for OTel base-spec consumers) |
| `gen_ai.usage.input_tokens` | Sum of API call input tokens for this turn |
| `gen_ai.usage.output_tokens` | Sum of API call output tokens for this turn |
| `gen_ai.usage.cache_creation.input_tokens` | Tokens written to prompt cache |
| `gen_ai.usage.cache_read.input_tokens` | Tokens read from prompt cache |
| `nio.turn_number` | Auto-incrementing per session |
| `nio.platform` | `claude-code`, `codex`, `openclaw`, `hermes`, `pi`, or `opencode` |
| `nio.cwd` | Working directory when the turn started |
| `nio.turn.user_prompt` | UserPromptSubmit prompt (redacted) |
| `nio.turn.cache_hit_rate` | `cache_read / (input + cache_creation + cache_read)` |

**Token usage collection** differs by platform:
- **Claude Code**: `Stop` event reads `transcript_path` JSONL, sums `message.usage` from all assistant entries since turn start.
- **Hermes**: same code path as Claude Code — when `post_llm_call`'s payload supplies `transcriptPath`, `endTurn` runs `parseTranscriptUsage` against it; when not, the turn span carries no usage.
- **Codex**: **none today.** `parseTranscriptUsage` is hard-coded to the Claude Code transcript schema — it only counts entries whose `type` is `"assistant"` and reads `message.usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`. Codex's transcript JSONL uses different event types and a different shape (see the note on `CodexAdapter.inferInitiatingSkill`), so even when a transcript path reaches `endTurn` the parser matches nothing and returns null. Codex turn spans therefore carry no `gen_ai.usage.*`; a codex-specific parser is phase-2 work.
- **OpenClaw**: `llm_output` event payload carries `usage` directly; the OpenClaw plugin accumulates it incrementally into `state.turn_attributes` via `accumulateGenAiUsage`. By the time `agent_end` fires `endTurn`, the usage attrs are already on `state.turn_attributes` and get spread onto the turn span.
- **Pi**: `message_end` carries `message.usage` (`input` / `output` / `cacheRead` / `cacheWrite`) once per assistant message; accumulated the same way as OpenClaw.
- **opencode**: `message.updated` carries cumulative `info.tokens`, but it is a **snapshot** republished on every change to the same message rather than a one-shot event. The binding keys the last-seen totals by message id and feeds only the delta into `onLlmUsage`, so a re-publish cannot compound the turn's totals. Messages without an id are skipped rather than risk inflating them.

**Tool span (`execute_tool <name>`) attributes:** `gen_ai.operation.name` (= `execute_tool`), `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.call.arguments` (redacted, ≤2 KB), `gen_ai.tool.call.result` (redacted, ≤2 KB), `nio.tool_summary`, `nio.platform`, `nio.turn_number`, `nio.cwd`, `nio.tool.error` (when set)

**Task span (`task:execute`) attributes:** `nio.task_id`, `nio.task_summary`, `nio.platform`, `nio.session_id`, `nio.turn_number`, `nio.cwd`

### Trace state and span lifecycle

All platforms route trace span construction through the same pure
functions in [src/scripts/lib/traces-collector.ts](../src/scripts/lib/traces-collector.ts)
(`ensureTurn` / `recordPreToolUse` / `recordPostToolUse` /
`recordPreTaskToolUse` / `recordPostTaskToolUse` / `setTurnAttributes` /
`endTurn`). Span names and attribute schema are therefore identical
across platforms; what differs is only **where the per-session
`CollectorState` lives**:

- **Claude Code / Hermes (cross-process)** — each hook fires in a fresh
  Node process. State is bridged via the JSON file managed by
  [traces-state-store.ts](../src/scripts/lib/traces-state-store.ts):
  1. `PreToolUse` → writes `{start_ms, span_id}` for the pending tool
     into `traces-state-store.json`
  2. `PostToolUse` → reads pending entry, calls `recordPostToolUse`
     which emits the span retroactively with the original start time
  3. `Stop` / `SubagentStop` → `endTurn` emits the turn root span
     (whose span ID was pre-derived as `traceId.slice(0, 16)` so child
     spans could parent to it before it existed)
- **OpenClaw / Pi / opencode (in-process)** — state lives in a per-session
  in-memory `Map<sessionId, CollectorState>` owned by
  [InProcessPluginRuntime](../src/adapters/plugin-runtime.ts). No on-disk
  bridging; otherwise identical lifecycle (the same pure-function calls
  are used at the same lifecycle points). Turn roots close at `agent_end`
  (OpenClaw, Pi) or `session.idle` (opencode); opencode additionally
  relies on that flush to reclaim spans for tools that threw and so never
  reached `tool.execute.after`.

State file location (Claude Code / Codex / Hermes only): derived from
`collector.logs.path` (sits in the same directory as `audit.jsonl`);
falls back to `${NIO_HOME ?? ~/.nio}/`.

### Local JSONL backup

The audit log (logs signal) has a local JSONL backup at `collector.logs.path` (default `~/.nio/audit.jsonl`), regardless of whether OTLP export is configured. Every dispatched hook event is written here as one of the `AuditHookEntry` shapes; guard / scan / lifecycle entries land in the same file with their respective `event` discriminator. See [COLLECTOR-SIGNALS.md](COLLECTOR-SIGNALS.md#logs-audit-log) for the full per-`event` field reference.

Metrics and traces have **no** local file — they are OTLP-only. The disk file [`traces-state-store.json`](../src/scripts/lib/traces-state-store.ts) is internal state used to bridge cross-process span lifecycle for Claude Code / Codex / Hermes; not user-facing observability data.

---

## Shared Infrastructure

### Detection Data (`src/core/shared/detection-data.ts`)

Single source of truth for constants used by both scan and guard pipelines:
`WEBHOOK_EXFIL_DOMAINS`, `HIGH_RISK_TLDS`, `SENSITIVE_FILE_PATHS`,
`SECRET_PATTERNS`, `SECRET_PRIORITY`.

### Detection Engine (`src/core/detection-engine.ts`)

Pure functions extracted from StaticAnalyser, reusable by both scan and guard:
`runRules()`, `runBase64Pass()`, `extractAndDecodeBase64()`.

### Scoring (`src/core/scoring.ts`)

Shared scoring infrastructure for both pipelines:
`findingsToScore()`, `aggregateScores()`, `PhaseWeights`, `PhaseScores`.

---

## Project Structure

```
src/
├── core/                              # Analysis engine
│   ├── models.ts                      # Finding, ThreatCategory, Severity
│   ├── scoring.ts                     # Score conversion + weighted aggregation
│   ├── scanner.ts                     # ScanOrchestrator (static scan)
│   ├── scan-cache.ts                  # ScanCache (file-backed)
│   ├── detection-engine.ts            # Shared rule engine (pure functions)
│   ├── analyser-factory.ts            # Create analysers from policy
│   ├── scan-policy.ts                 # Policy presets
│   ├── rule-registry.ts              # Rule catalog
│   ├── deduplicator.ts               # Finding dedup
│   ├── file-classifier.ts            # File categorization
│   ├── shared/
│   │   └── detection-data.ts          # Shared constants
│   └── analysers/
│       ├── base.ts                    # BaseAnalyser abstract class
│       ├── static/index.ts           # StaticAnalyser (regex)
│       ├── behavioural/               # BehaviouralAnalyser (multi-language)
│       │   ├── index.ts              # Orchestration + language dispatch
│       │   ├── types.ts              # LanguageExtractor interface
│       │   ├── ast-parser.ts         # JS/TS: Babel AST extraction
│       │   ├── py-extractor.ts       # Python: regex extraction
│       │   ├── sh-extractor.ts       # Shell: regex extraction
│       │   ├── rb-extractor.ts       # Ruby: regex extraction
│       │   ├── php-extractor.ts      # PHP: regex extraction
│       │   ├── go-extractor.ts       # Go: regex extraction
│       │   ├── dataflow.ts           # Source→sink taint tracking
│       │   └── context.ts            # Cross-file aggregation
│       ├── llm/                       # LLMAnalyser (Claude)
│       │   ├── index.ts
│       │   ├── prompts.ts            # Injection-protected prompts
│       │   └── taxonomy.ts           # Threat category mapping
│       ├── external/                  # ExternalAnalyser (HTTP scorer)
│       │   └── index.ts              # Dual-pipeline: scoreAction + scoreScan
│       ├── allowlist/                 # AllowlistAnalyser — Phase 1: safe command prefixes
│       │   └── index.ts
│       └── runtime/                   # RuntimeAnalyser — Phase 2: dangerous patterns
│           └── index.ts
├── action-orchestrator.ts            # ActionOrchestrator — 6-phase orchestration (guard pipeline)
├── action-decision.ts                # ActionDecision + GuardDecision + ProtectionLevel helpers
├── scanner/                           # SkillScanner public API
│   ├── index.ts                       # Scan entry point
│   ├── file-walker.ts                # Directory traversal
│   └── rules/                        # 15 detection rules
├── adapters/                          # Platform integration
│   ├── hook-engine.ts                # evaluateHook() — guard entry point (Phase 0 + dispatch)
│   ├── claude-code.ts                # Claude Code adapter
│   ├── codex.ts                      # Codex CLI adapter (5/6 events, Bash-only native)
│   ├── openclaw.ts                   # OpenClaw adapter
│   ├── openclaw-plugin.ts            # OpenClaw plugin registration
│   ├── openclaw-dispatch.ts          # SHARED /nio sub-command router + doctor
│   ├── plugin-runtime.ts             # InProcessPluginRuntime (OpenClaw + Pi + opencode)
│   ├── pi.ts                         # Pi adapter
│   ├── pi-plugin.ts                  # Pi extension registration (blocking tool_call, /nio command)
│   ├── opencode.ts                   # opencode adapter
│   ├── opencode-plugin.ts            # opencode plugin factory (NioBlockedError block path)
│   ├── hermes.ts                     # Hermes adapter (shell-hook JSON protocol)
│   ├── self-invocation.ts            # Nio self-call short-circuit detector
│   ├── config-schema.ts              # Zod config schema
│   ├── common.ts                     # Shared utilities
│   └── types.ts                      # HookInput/HookOutput/HookAdapter
├── policy/                            # Default policies
├── types/                             # Type definitions
├── utils/                             # Utility functions
└── scripts/                           # CLI entry points
    ├── guard-hook.ts                  # Claude Code: PreToolUse/PostToolUse hook
    ├── scanner-hook.ts                # Claude Code: SessionStart skill scan
    ├── collector-hook.ts              # Claude Code: telemetry stdin wrapper around lib/collector-core
    ├── hook-cli.ts                    # Hermes: shell-hook dispatcher (guard + collector paths)
    ├── nio-cli.ts                     # Hermes (Python plugin) / shell: /nio slash dispatcher → dispatchNioCommand
    ├── action-cli.ts                  # CLI over ActionOrchestrator.evaluate (Phase 1–6)
    ├── config-cli.ts                  # Protection level CLI
    └── lib/
        ├── collector-core.ts          # Platform-agnostic event dispatcher (used by collector-hook + hook-cli)
        ├── traces-collector.ts        # OTEL traces (turn + tool spans)
        ├── metrics-collector.ts       # OTEL metrics
        ├── logs-collector.ts          # OTEL logs
        └── config-loader.ts           # ~/.nio/config.yaml loader
```

## Configuration

Runtime config: `~/.nio/config.yaml` (or `$NIO_HOME/config.yaml`).
Full template: `plugins/shared/config.default.yaml`.

Key sections:
- `level` — Protection level: `strict` | `balanced` | `permissive`
- `guard` — Dynamic guard settings: scoring endpoint, weights, extra allowlist
- `llm` — LLM analyser: API key, model, token budget
- `collector` — OTLP telemetry: endpoint, protocol, log file
- `rules` — Extra regex patterns injected into scan rules

## Testing

```bash
npm install && npm run build && npm test
```

## Skill Invocation Models

The same `SKILL.md` file behaves very differently depending on the host. Two distinct invocation contracts exist today.

### Umbrella skill + focused skills

nio ships **one umbrella skill** (`nio`, invoked as `/nio <subcommand>`) plus **six focused single-purpose skills** — `nio-scan`, `nio-action`, `nio-report`, `nio-config`, `nio-doctor`, `nio-external-score`. The umbrella is the full reference and routes subcommands; the focused skills each carry a sharp `description` so a plain-language request (e.g. "what's my nio score") routes straight to the right capability instead of matching the broad umbrella and re-routing.

Focused skills exist **only on the LLM-driven hosts — Claude Code, Codex, Pi, and opencode** (where invocation = the model reading `SKILL.md` and running a bundled script). Tool-dispatch (OpenClaw) and shell-hook (Hermes) route the single `nio_command` / `nio-cli.js` surface and have **no per-skill registration**, so they keep the unified `/nio` only. Note that Pi's and opencode's *unified* `/nio` is a real command route (`pi.registerCommand` and `commands/nio.md` → `nio_command` respectively); the focused `nio-*` skills are the separate, passive natural-language surface on those hosts.

Mechanics:
- Sources live under `plugins/shared/skills/<name>/` — the umbrella `nio/` and the focused `nio-*/` side by side; `sync-shared.js` copies the umbrella to all skill plugins and the focused skills to Claude Code, Codex, Pi, and opencode.
- Focused skills are pure LLM-driven: no `command-dispatch` / `command-tool` frontmatter. Script-running ones (`nio-action`, `nio-config`, `nio-doctor`, `nio-external-score`) **sibling-reference** the umbrella's bundled scripts via `../nio/scripts/<cli>.js` rather than duplicating the multi-MB bundle.
- Rule docs are owned by their capability: `SCAN-RULES.md` in `nio-scan/`, `ACTION-POLICIES.md` in `nio-action/`; the umbrella borrows a copy of each (its `SKILL.md` links them).
- `doctor-cli.js` (bundled) lets `/nio-doctor` — and the unified `/nio doctor` — run standalone on Claude Code / Codex.
- Hooks (guard / collector / scanner) are unaffected — they fire on tool events regardless of which skill, if any, was invoked.

### LLM-driven (Claude Code)

Claude Code interprets `/nio` by loading `SKILL.md` into the LLM context and letting the model follow the instructions step-by-step.

```text
/nio config show (Claude Code)
  │
  ├─► Claude Code injects SKILL.md into prompt
  ├─► LLM reasons: "instructions say run node scripts/config-cli.js show"
  ├─► LLM issues Bash tool call
  ├─► Claude Code spawns node subprocess, captures stdout (JSON)
  ├─► LLM reads stdout, composes a human-friendly summary
  └─► streamed assistant reply
```

Typical latency: **2–5 seconds**. Output is **narrated** — the LLM rewrites the script's JSON into prose. Every invocation costs tokens (SKILL.md load + reasoning + summary).

### Tool-dispatch (OpenClaw)

OpenClaw supports a frontmatter contract that bypasses the model entirely:

```yaml
user-invocable: true
command-dispatch: tool
command-tool: nio_command
command-arg-mode: raw
```

When the slash command is registered this way and the plugin provides a matching tool, the gateway routes the raw args directly to that tool's `execute()` handler and relays its output back to the channel verbatim.

```text
/nio config show (OpenClaw)
  │
  ├─► gateway sees command-dispatch: tool
  ├─► gateway calls nio_command.execute({ command: "config show", ... })
  ├─► in-process dispatcher: loadConfig() → JSON.stringify
  └─► gateway sends raw text to channel
```

The tool handler lives at [src/adapters/openclaw-dispatch.ts](../src/adapters/openclaw-dispatch.ts) and is registered from [src/adapters/openclaw-plugin.ts](../src/adapters/openclaw-plugin.ts). It reuses the same APIs as the CLIs (`loadConfig`, `resetConfig`, `ActionOrchestrator.evaluate`, `SkillScanner.quickScan`, audit-log reader) — there is no duplicated business logic.

Typical latency: **~50 ms**. Output is **structured** (raw JSON or markdown tables) — whatever `dispatchNioCommand` returns is what the channel sees. Zero model tokens consumed.

### Comparison

|                  | Claude Code (LLM-driven)                                         | OpenClaw (tool-dispatch)             |
|------------------|------------------------------------------------------------------|--------------------------------------|
| Latency          | 2–5 s                                                            | ~50 ms                               |
| Model tokens     | Every call (SKILL.md + reasoning)                                | 0                                    |
| Output shape     | Narrative summary                                                | Raw JSON / markdown                  |
| Determinism      | Model may hallucinate paths, skip instructions                   | Deterministic; errors are exceptions |
| Flexibility      | Model can combine context, answer follow-ups                     | Fixed subcommand router              |
| Context overflow | Possible on long-running sessions                                | Irrelevant (model not in the loop)   |
| Preflight issues | LLM may emit compound shell commands that host preflights reject | N/A (no shell)                       |

### When each is right

- **Tool-dispatch** for structured, deterministic commands where the user wants the raw truth: `/nio config show`, `/nio scan <path>`, `/nio report`, `/nio action <...>`. These have clean subcommand grammars and known output shapes.
- **LLM-driven** for tasks that require interpretation, clarification, or follow-up: "explain what this webhook-exfil finding means and how to mitigate it". Claude Code's path excels here — the model can combine skill output with broader context.

### Co-existence

Both contracts share **one** `SKILL.md`. The tool-dispatch frontmatter keys (`command-dispatch`, `command-tool`, `command-arg-mode`) are additive: hosts that do not implement them (Claude Code today) simply ignore them and fall back to LLM-driven behaviour. Conversely, a host that does implement them (OpenClaw) will only route to `nio_command` if the plugin actually registers a tool of that name — if not, the dispatch fails open to the LLM-driven fallback.

This means we can ship one skill folder to both hosts with no per-host forking, and opt each host into whichever contract it supports.

### Shell-hook dispatch (Hermes)

Hermes Agent does not install Nio as a skill at all. Starting with upstream [PR #13296](https://github.com/NousResearch/hermes-agent/pull/13296), Hermes exposes a native **shell-hook** facility — users declare shell subprocesses in `~/.hermes/config.yaml` that Hermes spawns on each plugin-hook event. We hook into this for the hot path (guard + observability). The user-facing `/nio` slash command is delivered separately through a small Python plugin (see "`/nio` slash command" below); shell-hooks alone don't expose a slash-registration surface.

Seven lifecycle events map to the **same** `hook-cli.js` command string. The CLI peeks at stdin's `hook_event_name` field and routes internally:

```text
Hermes lifecycle event
  │
  ├─► Hermes reads its config.yaml hooks: block (7 entries, all
  │   pointing at the same plugins/hermes/scripts/hook-cli.js)
  ├─► spawns: node <abs>/hook-cli.js --platform hermes --stdin
  │       stdin = {hook_event_name, tool_name, tool_input,
  │                session_id, cwd, extra}   (snake_case)
  │
  ├─► hook-cli.ts · dispatches on hook_event_name
  │   │
  │   ├── pre_tool_call ─── GUARD path
  │   │     ├─► new HermesAdapter() + parseInput
  │   │     ├─► evaluateHook → Phase 0 → Phase 1-6 → audit write
  │   │     ├─► recordGuardDecision → nio.decision.count metric
  │   │     ├─► dispatchCollectorEvent(PreToolUse)
  │   │     │     saves pending_span + nio.tool_use.count metric
  │   │     ├─► LoggerProvider emits audit entry to /v1/logs
  │   │     ├─► forceFlush all three providers
  │   │     └─► Hermes-shaped stdout
  │   │             deny  → {"decision": "block", "reason": "..."}
  │   │             allow → {}
  │   │             ask   → folded via guard.confirm_action
  │   │
  │   └── everything else ── COLLECTOR path
  │         ├─► HERMES_COLLECTOR_EVENTS[hook_event_name] → canonical
  │         │     post_tool_call   → PostToolUse   (close tool span)
  │         │     pre_llm_call     → UserPromptSubmit
  │         │     post_llm_call    → Stop          (close turn span)
  │         │     on_session_start → SessionStart
  │         │     on_session_end   → SessionEnd
  │         │     subagent_stop    → SubagentStop
  │         ├─► hermesToCollectorInput lifts extra.tool_call_id /
  │         │   user_message / result into the canonical shape
  │         ├─► dispatchCollectorEvent → audit.jsonl (writeAuditLog)
  │         │                          + OTLP export (logs/traces/metrics)
  │         ├─► forceFlush → /v1/metrics, /v1/traces, /v1/logs
  │         └─► stdout: {} (collector never blocks)
  │
  └─► Hermes's _parse_response accepts Claude-Code style
      {decision: "block"} or Hermes-canonical {action: "block"};
      silently permits any other stdout
```

Typical latency: **~100–200 ms** per event (Node cold-start dominated — amortise via Hermes's hook-process warmup when the feature lands). Zero model tokens consumed by the guard path.

**Install surface:** `plugins/hermes/setup.sh` merges 7 lifecycle event entries into `~/.hermes/config.yaml` via `install-hook.py` (PyYAML-aware per-event merge; uses Hermes's own venv Python so PyYAML is always available). `scripts/build.js` produces self-contained `plugins/hermes/scripts/{hook-cli,nio-cli}.js` single-file bundles (bun `splitting: false`) so `nio-hermes-vX.zip` has no dependency on the Claude Code plugin dir.

**Consent:** handled by Hermes. First use prompts interactively, persisted to `~/.hermes/shell-hooks-allowlist.json`. Non-TTY runs (gateway, cron, CI) need `--accept-hooks`, `HERMES_ACCEPT_HOOKS=1`, or `hooks_auto_accept: true`. Script edits are silently trusted; `hermes hooks doctor` flags mtime drift.

**Fail-open contract:** Hermes treats non-zero exit codes and malformed stdout as "no block" per upstream `_parse_response`. `hook-cli` honours this — any internal error (missing config, orchestrator throw, parse failure) exits 1 with empty stdout + a stderr diagnostic. Security property: a broken Nio install never blocks the agent loop.

### `/nio` slash command (Hermes Python plugin)

Shell-hooks cover the guard + observability surface. The user-facing `/nio` slash command (scan / action / config / report / reset) takes a different path: a small Python plugin dropped into `~/.hermes/plugins/nio/` that registers `/nio` as a Hermes command-dispatch handler, mirroring OpenClaw's `command-dispatch: tool` route. No pip install — Hermes auto-discovers any directory under `~/.hermes/plugins/<name>/` (one of four discovery paths in `hermes_cli/plugins.py::discover_and_load`).

The plugin directory layout, post-install:

```text
~/.hermes/plugins/nio/
├── plugin.yaml              # manifest
├── __init__.py              # ~50 LOC — register(ctx).register_command("nio", _handle_slash, ...)
└── scripts/
    ├── nio-cli.js           # bundled slash dispatcher
    └── hook-cli.js          # bundled shell-hook dispatcher (also referenced from config.yaml)
```

When a user types `/nio config show` in Hermes chat / Telegram / Discord:

1. Hermes parses the slash and routes to the registered command handler — no LLM tokens spent on dispatch.
2. The handler `_handle_slash(raw_args)` spawns `node <plugin>/scripts/nio-cli.js <raw_args>`. `raw_args` is passed as a single argv string so quoting survives (e.g. `/nio action exec_command: ls -la`).
3. `nio-cli.ts` joins argv on whitespace and calls `dispatchNioCommand(rawArgs, {orchestrator, scanner})` — the same in-process function OpenClaw's `nio_command` tool calls. Routing is identical to OpenClaw's `/nio`.
4. Result string is written to stdout; the Python handler returns it to Hermes, which routes it back to the user channel.

**Install surface:** `setup.sh` copies `plugin.yaml` + `__init__.py` + the `scripts/` directory into `~/.hermes/plugins/nio/` and appends `"nio"` to `plugins.enabled` in `~/.hermes/config.yaml`. Hermes plugins are opt-in — without that opt-in entry the directory exists but `discover_and_load` skips it. Idempotent on re-run; `--uninstall` clears both.

**Latency:** ~100–200 ms (node cold-start, same order as shell-hooks). Slower than OpenClaw's in-process call (~50 ms) but invisible for user-driven slash commands. Not on the tool-call hot path.

**Why a separate Python plugin instead of folding `/nio` into the shell-hook channel?** Shell-hooks are event-triggered (Hermes spawns a subprocess on `pre_tool_call` etc.); the shell-hook surface has no way to register new slash commands. The slash-command surface needs `register_command` on the in-process plugin context, which is what the Python plugin provides. The two surfaces are orthogonal: shell-hooks for hot-path guard + observability, Python plugin for user-driven slash dispatch.

#### Contract at a glance

|                  | Claude Code (LLM-driven) | Codex (lifecycle hooks) | OpenClaw (tool-dispatch) | Hermes (shell-hook) |
|------------------|--------------------------|--------------------------|---------------------------|----------------------|
| How registered   | LLM reads `SKILL.md`     | `[plugins."nio@nio"]` in `~/.codex/config.toml` + `codex_hooks` feature flag | Plugin tool               | Shell-hooks: YAML in `~/.hermes/config.yaml`. `/nio` slash: Python plugin in `~/.hermes/plugins/nio/`. |
| Invocation mode  | LLM → Bash → subprocess  | Subprocess spawned by Codex on each lifecycle event | In-process method call    | Hot path (guard / collector): subprocess spawned by Hermes. `/nio`: in-process handler → subprocess. |
| Language on path | JS (node subprocess)     | JS (node subprocess)     | JS (in-process)           | JS (node subprocess) |
| Latency          | 2–5 s                    | ~100–200 ms              | ~50 ms                    | ~100–200 ms          |
| Model tokens     | Every call               | 0                        | 0                         | 0                    |
| Can block tools  | Yes (via hook)           | Yes (Phase 0–6, PreToolUse `permissionDecision: deny`) | Yes (Phase 0–6)           | Yes (Phase 0–6)      |
| `/nio` dispatch  | LLM-driven (skill)       | LLM-driven (skill via `$nio` or natural-language match) | Tool-dispatch (`nio_command`) | Python plugin → `nio-cli.js` (bypass LLM) |
| Phase 0 source   | `blocked_tools.claude_code` | `blocked_tools.codex`   | `blocked_tools.openclaw`  | `blocked_tools.hermes` |
| Consent prompt   | N/A (implicit)           | N/A (implicit)           | N/A (implicit)            | First-run interactive, cached |
