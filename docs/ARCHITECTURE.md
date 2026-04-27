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
│              available_tools non-empty?                              │
│                    │ YES                                             │
│                    ▼                                                 │
│              tool_name in available_tools? ──NO──► DENY (exit)     │
│                    │ YES                                             │
│                    ▼                                                 │
│              tool_name in guarded_tools? ──NO──► ALLOW (exit)      │
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
│   Finding[] → runtime score ──► critical? ──YES──► DENY (exit)     │
└────────────────────┬────────────────────────────────────────────────┘
                     │ not critical
                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Phase 3: Static Analysis (<50ms) → `static` score                   │
│ [Write/Edit only — skip for Bash/WebFetch]                          │
│                                                                     │
│   file content ──► 15 regex rules ──► base64 decode pass           │
│   (SHELL_EXEC, REMOTE_LOADER, OBFUSCATION, WEBHOOK_EXFIL, ...)    │
│                                                                     │
│   Finding[] → static score ──► critical? ──YES──► DENY (exit)      │
└────────────────────┬────────────────────────────────────────────────┘
                     │ not critical
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
│   Finding[] → behavioural score ──► critical? ──YES──► DENY (exit)  │
└────────────────────┬────────────────────────────────────────────────┘
                     │ not critical
                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Phase 5: LLM Analysis (2–10s) → `llm` score                        │
│ [Optional — gated on llm.api_key config]                            │
│                                                                     │
│   action context ──► Claude semantic analysis                       │
│   (Write: file content, Bash: shell script, Network: request JSON) │
│                                                                     │
│   Finding[] → llm score ──► critical? ──YES──► DENY (exit)         │
└────────────────────┬────────────────────────────────────────────────┘
                     │ not critical
                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Phase 6: External Scoring API → `external` score                    │
│ [Optional — gated on guard.scoring_endpoint config]                 │
│                                                                     │
│   POST { tool_name, tool_input, prior_scores, prior_findings }     │
│   → external HTTP endpoint                                          │
│   ← { score: 0.0–1.0, reason?: string }                            │
│                                                                     │
│   external score ──► critical? ──YES──► DENY (exit)                │
└────────────────────┬────────────────────────────────────────────────┘
                     │ not critical
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

| Phase | Bash | Write/Edit | WebFetch | Read/Grep/Glob/etc. |
|-------|------|------------|----------|---------------------|
| 0 Tool Gate | yes | yes | yes | yes |
| 1 Allowlist | yes | yes | yes | skip (no envelope) |
| 2 Pattern Analysis | yes | yes | yes | skip |
| 3 Static Analysis | skip | yes (file content) | skip | skip |
| 4 Behavioural Analysis | skip | yes (.js/.ts/.py/.sh/.rb/.php/.go) | skip | skip |
| 5 LLM (optional) | yes | yes | yes | skip |
| 6 External API (optional) | yes | yes | yes | skip |

Tools not in `guarded_tools` pass Phase 0 but skip Phases 1–6 (auto-allow).

### Phase 0: Tool Gate (<1ms)

Runs in `hook-engine.ts` before envelope building. Three checks in order:

1. **blocked_tools** — if tool is listed → DENY
2. **available_tools** — if list is non-empty and tool is not listed → DENY
3. **guarded_tools** — if tool is not mapped → ALLOW (skip Phase 1–6)

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

`available_tools` and `blocked_tools` are keyed by platform (`claude_code`,
`openclaw`, …) with one reserved cross-platform key `mcp`. Incoming MCP tool
names are parsed into `{server, local}` — OpenClaw uses `<server>__<tool>`,
Claude Code uses `mcp__<server>__<tool>` — and matched against the `mcp` list
in either bare (`HassTurnOn` — any server) or server-qualified
(`hass__HassTurnOn` — that server only) form. Blocked lists across namespaces
are additive; available lists are independent per namespace, with the
platform list acting as fallback when `available_tools.mcp` is absent.
Matching is case-insensitive throughout.

The `mcp` list also covers **mcporter-style shell invocations**: when the
tool is a shell executor (`Bash` / `exec`), the gate scans the command
string for `mcporter <server>.<tool>` (with or without the `call` verb,
`npx` / `bunx` prefixes, flags, `--`, or function-call syntax like
`'server.tool(args)'`) and matches the extracted target against the same
`mcp` lists. A denied shell hit shows up in the audit log as
`Tool "server__tool" is blocked (blocked_tools; invoked via mcporter)`.

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

### Phase 6: External Scoring API (optional) → `external`

**Gated on `guard.scoring_endpoint` in config.** Sends action context + prior
scores/findings to a user-configured HTTP endpoint. Returns a 0–1 score.

The `ExternalAnalyser` is a standalone module (`src/core/analysers/external/`)
usable by both pipelines:
- `scoreAction()` — guard pipeline (ActionOrchestrator Phase 6)
- `scoreScan()` — scan pipeline (ScanOrchestrator post-phase)

```yaml
guard:
  scoring_endpoint: "https://my-security-api.example.com/score"
  scoring_api_key: ""
  scoring_timeout: 3000
```

### Score Aggregation

Each phase produces a 0–1 score via `findingsToScore()`:
`score = max(severity_weight / 4 * confidence)` across all findings.

Final score is a weighted average of all phases that ran:

```
final_score = Σ(wi × si) / Σ(wi)
```

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
- `ask` — use platform-native confirm if available (Claude Code), else fall back to allow (OpenClaw)

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

Captures agent activity as **OpenTelemetry** metrics and traces. Runs independently from the guard — never influences allow/deny decisions.

### Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ Claude Code (cross-process)                                         │
│                                                                     │
│   collector-hook.ts (async, runs per hook event)                    │
│     ├─ MeterProvider  → OTLP metrics export                        │
│     └─ TracerProvider → OTLP traces export                         │
│         └─ State file (collector-state.json) for cross-process      │
│            span correlation (PreToolUse ↔ PostToolUse)              │
│                                                                     │
│   guard-hook.ts (sync, runs per PreToolUse)                         │
│     └─ MeterProvider  → guard decision + risk score metrics         │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│ OpenClaw (in-process)                                               │
│                                                                     │
│   openclaw-plugin.ts                                                │
│     ├─ MeterProvider  → all metrics (tool use + turn + decision)    │
│     └─ TracerProvider → all traces (in-memory span tracking)        │
│         └─ No state file needed — same process across events        │
└─────────────────────────────────────────────────────────────────────┘
```

### Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `nio.tool_use.count` | Counter | `tool_name`, `event`, `platform` |
| `nio.turn.count` | Counter | `platform` |
| `nio.decision.count` | Counter | `decision`, `risk_level`, `tool_name`, `platform` |
| `nio.risk.score` | Histogram | `tool_name`, `platform` |

- `decision.count` — recorded by guard-hook (Claude Code) / openclaw-plugin after each `evaluateHook()` call
- `risk.score` — histogram of 0–1 risk scores, enables avg/p50/p99 queries
- `tool_use.count` and `turn.count` — recorded by collector-hook / openclaw-plugin on hook events

### Traces

One trace per conversation turn, with child spans per tool call / task:

```
Trace: turn:<N>  (root span, UserPromptSubmit → Stop)
  ├─ Span: tool:<name>     (PreToolUse → PostToolUse)
  ├─ Span: tool:<name>     (PreToolUse → PostToolUse)
  └─ Span: task:execute    (TaskCreated → TaskCompleted)
```

**Turn span attributes:**

| Attribute | Source |
|-----------|--------|
| `nio.session_id` | Hook stdin `session_id` |
| `nio.turn_number` | Auto-incrementing per session |
| `nio.platform` | `claude-code`, `openclaw`, or `hermes` |
| `nio.turn.user_prompt` | UserPromptSubmit prompt (redacted) |
| `nio.turn.input_tokens` | Sum of API call input tokens for this turn |
| `nio.turn.output_tokens` | Sum of API call output tokens for this turn |
| `nio.turn.cache_creation_input_tokens` | Tokens written to prompt cache |
| `nio.turn.cache_read_input_tokens` | Tokens read from prompt cache |
| `nio.turn.cache_hit_rate` | `cache_read / (input + cache_creation + cache_read)` |

**Token usage collection** differs by platform:
- **Claude Code**: `Stop` event reads `transcript_path` JSONL, sums `message.usage` from all assistant entries since turn start
- **OpenClaw**: `llm_output` event passes `usage` directly in event payload, accumulated in-memory across calls

**Tool span attributes:** `tool_name`, `tool_summary`, `tool.input`, `tool.output`, `tool.error`, `tool.call_id`

**Task span attributes:** `task_id`, `task_summary`

### Cross-Process State (Claude Code only)

Claude Code hooks run as separate processes per event. To correlate spans:

1. `PreToolUse` → writes span start time + span ID to `collector-state.json`
2. `PostToolUse` → reads pending span, emits with correct start/end time
3. `Stop` → emits turn root span, clears state

State file location: derived from `collector.log` config path or `~/.nio/`.

### Local JSONL Log

Besides OTEL export, every hook event is appended to a local JSONL file (`collector.log` config):

```jsonl
{"timestamp":"...","platform":"claude-code","event":"PreToolUse","tool_name":"Bash","session_id":"...","tool_summary":"npm test"}
```

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
│   ├── openclaw.ts                   # OpenClaw adapter
│   ├── openclaw-plugin.ts            # OpenClaw plugin registration
│   ├── hermes.ts                     # Hermes adapter (shell-hook JSON protocol)
│   ├── self-invocation.ts            # Nio self-call short-circuit detector
│   ├── config-schema.ts              # Zod config schema
│   ├── common.ts                     # Shared utilities
│   └── types.ts                      # HookInput/HookOutput/HookAdapter
├── policy/                            # Default policies
├── types/                             # Type definitions
├── utils/                             # Utility functions
└── scripts/                           # CLI entry points
    ├── guard-hook.ts                  # PreToolUse/PostToolUse hook
    ├── scanner-hook.ts                # SessionStart: scan installed skills
    ├── action-cli.ts                  # CLI over ActionOrchestrator.evaluate (Phase 1–6)
    ├── hook-cli.ts                    # CLI over evaluateHook (Phase 0–6) — cross-process hook consumers (Hermes)
    ├── config-cli.ts                  # Protection level CLI
    └── collector-hook.ts              # Telemetry collector hook
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

Hermes Agent does not install Nio as a skill at all. Starting with upstream [PR #13296](https://github.com/NousResearch/hermes-agent/pull/13296), Hermes exposes a native **shell-hook** facility — users declare shell subprocesses in `~/.hermes/config.yaml` that Hermes spawns on each plugin-hook event. We hook into this and ship zero Python code.

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
  │         ├─► dispatchCollectorEvent → metrics.jsonl + OTLP export
  │         ├─► forceFlush → /v1/metrics, /v1/traces
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

|                  | Claude Code (LLM-driven) | OpenClaw (tool-dispatch) | Hermes (shell-hook) |
|------------------|--------------------------|---------------------------|----------------------|
| How registered   | LLM reads `SKILL.md`     | Plugin tool               | Shell-hooks: YAML in `~/.hermes/config.yaml`. `/nio` slash: Python plugin in `~/.hermes/plugins/nio/`. |
| Invocation mode  | LLM → Bash → subprocess  | In-process method call    | Hot path (guard / collector): subprocess spawned by Hermes. `/nio`: in-process handler → subprocess. |
| Language on path | JS (node subprocess)     | JS (in-process)           | JS (node subprocess) |
| Latency          | 2–5 s                    | ~50 ms                    | ~100–200 ms          |
| Model tokens     | Every call               | 0                         | 0                    |
| Can block tools  | Yes (via hook)           | Yes (Phase 0–6)           | Yes (Phase 0–6)      |
| `/nio` dispatch  | LLM-driven (skill)       | Tool-dispatch (`nio_command`) | Python plugin → `nio-cli.js` (bypass LLM) |
| Phase 0 source   | `blocked_tools.claude_code` | `blocked_tools.openclaw` | `blocked_tools.hermes` |
| Consent prompt   | N/A (implicit)           | N/A (implicit)            | First-run interactive, cached |
