# Architecture

## Overview

AgentGuard is a two-pipeline security framework for AI agents:

1. **Static Scan** — On-demand multi-engine code analysis (Static + Behavioural + LLM)
2. **Dynamic Guard** — Real-time hook protection via 6-phase RuntimeAnalyser pipeline

```
┌─────────────────────────────────────────────────────────┐
│ Static Scan (on-demand, triggered by user)              │
│   /ffwd-agent-guard scan <path>                         │
│   → ScanOrchestrator → Static + Behavioural + LLM       │
│   → Finding[] → ScanResult                              │
│   → writes scan-cache for dynamic guard to read         │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ Dynamic Guard (real-time, every PreToolUse hook)        │
│   guard-hook → evaluateHook() → RuntimeAnalyser         │
│   → 6-phase pipeline → allow / deny / confirm           │
└─────────────────────────────────────────────────────────┘
```

---

## Dynamic Guard: Phase 0–6 Pipeline

Every `PreToolUse` hook event flows through the guard pipeline.
Phase 0 is a tool-level gate (in `engine.ts`). Phases 1–6 run in the
RuntimeAnalyser, each producing a 0–1 score that can short-circuit
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
│ Phase 0: Tool Gate (<1ms)  [engine.ts, before envelope building]    │
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
│              Build ActionEnvelope → proceed to Phase 1              │
└────────────────────┬────────────────────────────────────────────────┘
                     │ passed gate
                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Phase 1: Allowlist Gate (<1ms)                                      │
│                                                                     │
│   action ──► match safe prefix? ──YES──► ALLOW (exit)              │
│                    │ NO                                              │
│                    ▼                                                 │
│              has shell metachar? ──YES──► skip allowlist, continue  │
│                    │ NO                                              │
│                    ▼                                                 │
│              match extra_allowlist? ──YES──► ALLOW (exit)           │
└────────────────────┬────────────────────────────────────────────────┘
                     │ not matched
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
│   file content ──► 16 regex rules ──► base64 decode pass           │
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

Runs in `engine.ts` before envelope building. Three checks in order:

1. **blocked_tools** — if tool is listed → DENY
2. **available_tools** — if list is non-empty and tool is not listed → DENY
3. **guarded_tools** — if tool is not mapped → ALLOW (skip Phase 1–6)

`available_tools` and `blocked_tools` are keyed by platform (`claude_code`,
`openclaw`, …) with one reserved cross-platform key `mcp`. Incoming MCP tool
names are parsed into `{server, local}` — OpenClaw uses `<server>__<tool>`,
Claude Code uses `mcp__<server>__<tool>` — and matched against the `mcp` list
in either bare (`HassTurnOn` — any server) or server-qualified
(`hass__HassTurnOn` — that server only) form. Blocked lists across namespaces
are additive; available lists are independent per namespace, with the
platform list acting as fallback when `available_tools.mcp` is absent.
Matching is case-insensitive throughout.

### Phase 1: Allowlist Gate (<1ms)

Check if the action matches a known-safe pattern. If yes, **allow** and stop.

- 200+ safe command prefixes: `git status`, `ls`, `npm test`, etc.
- Only applied when command has no shell metacharacters (`;`, `|`, `$()`, etc.)
- User can inject additional patterns via `config.yaml` → `guard.extra_allowlist`

### Phase 2: Pattern Analysis (<5ms) → `runtime`

Produces `Finding[]` from action data pattern matching:

- **Bash**: dangerous commands, fork bombs, shell injection, system/network commands, base64 decode
- **Network**: webhook exfil domains, high-risk TLDs, secret leak in body
- **File ops**: path traversal, sensitive path detection (`.env`, `.ssh/`, `.aws/`)

### Phase 3: Static Analysis (<50ms) → `static`

**Only runs for Write/Edit actions** (file content exists to scan).
Runs the scan engine's 16 static rules + base64 decode pass against the file
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
semantic analysis. For Write/Edit, analyzes the file content. For Bash, wraps
the command as a shell script. Reuses the existing `LLMAnalyser` from the scan pipeline.

### Phase 6: External Scoring API (optional) → `external`

**Gated on `guard.scoring_endpoint` in config.** Sends action context + prior
scores/findings to a user-configured HTTP endpoint. Returns a 0–1 score.

The `ExternalAnalyser` is a standalone module (`src/core/analysers/external/`)
usable by both pipelines:
- `scoreAction()` — guard pipeline (RuntimeAnalyser Phase 6)
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
           │  (regex, 16 rules)   │──┐
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
1. **Pattern matching** — 16 rules across 7 modules against file content
2. **Base64 decoding** — Extract and re-scan encoded payloads
3. **Markdown extraction** — Only scan fenced code blocks in `.md` files

**16 detection rules:** SHELL_EXEC, AUTO_UPDATE, REMOTE_LOADER, READ_ENV_SECRETS,
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

### RuntimeDecision

Output of the dynamic guard pipeline:

```typescript
interface RuntimeDecision {
  decision: 'allow' | 'deny' | 'confirm';
  risk_level: RiskLevel;
  findings: Finding[];
  scores: {
    runtime?: number;
    static?: number;
    behavioural?: number;
    llm?: number;
    external?: number;
    final?: number;
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
  abstract analyze(ctx: AnalysisContext): Promise<Finding[]>;
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

File-backed cache (`~/.ffwd-agent-guard/scan-cache.json`) with 24h TTL.
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
| `agentguard.tool_use.count` | Counter | `tool_name`, `event`, `platform` |
| `agentguard.turn.count` | Counter | `platform` |
| `agentguard.decision.count` | Counter | `decision`, `risk_level`, `tool_name`, `platform` |
| `agentguard.risk.score` | Histogram | `tool_name`, `platform` |

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
| `agentguard.session_id` | Hook stdin `session_id` |
| `agentguard.turn_number` | Auto-incrementing per session |
| `agentguard.platform` | `claude-code` or `openclaw` |
| `agentguard.turn.user_prompt` | UserPromptSubmit prompt (redacted) |
| `agentguard.turn.input_tokens` | Sum of API call input tokens for this turn |
| `agentguard.turn.output_tokens` | Sum of API call output tokens for this turn |
| `agentguard.turn.cache_creation_input_tokens` | Tokens written to prompt cache |
| `agentguard.turn.cache_read_input_tokens` | Tokens read from prompt cache |
| `agentguard.turn.cache_hit_rate` | `cache_read / (input + cache_creation + cache_read)` |

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

State file location: derived from `collector.log` config path or `~/.ffwd-agent-guard/`.

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
│       └── runtime/                   # RuntimeAnalyser (guard pipeline)
│           ├── index.ts              # 6-phase orchestration
│           ├── allowlist.ts          # Phase 1: safe command prefixes
│           ├── denylist.ts           # Phase 2: dangerous patterns
│           └── decision.ts           # Score → decision (per protection level)
├── scanner/                           # SkillScanner public API
│   ├── index.ts                       # Scan entry point
│   ├── file-walker.ts                # Directory traversal
│   └── rules/                        # 16 detection rules
├── adapters/                          # Platform integration
│   ├── engine.ts                     # evaluateHook() — guard entry point
│   ├── claude-code.ts                # Claude Code adapter
│   ├── openclaw.ts                   # OpenClaw adapter
│   ├── openclaw-plugin.ts            # OpenClaw plugin registration
│   ├── config-schema.ts              # Zod config schema
│   ├── common.ts                     # Shared utilities
│   └── types.ts                      # HookInput/HookOutput/HookAdapter
├── policy/                            # Default policies
├── types/                             # Type definitions
├── utils/                             # Utility functions
└── scripts/                           # CLI entry points
    ├── guard-hook.ts                  # PreToolUse/PostToolUse hook
    ├── scanner-hook.ts                # SessionStart: scan installed skills
    ├── action-cli.ts                  # CLI for RuntimeAnalyser
    ├── config-cli.ts                  # Protection level CLI
    └── collector-hook.ts              # Telemetry collector hook
```

## Configuration

Runtime config: `~/.ffwd-agent-guard/config.yaml` (or `$FFWD_AGENT_GUARD_HOME/config.yaml`).
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
