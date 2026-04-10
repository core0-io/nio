# Architecture

## Overview

AgentGuard is a two-pipeline security framework for AI agents:

1. **Static Scan** — On-demand multi-engine code analysis (Static + Behavioral + LLM)
2. **Dynamic Guard** — Real-time hook protection via 6-phase RuntimeAnalyzer pipeline

```
┌─────────────────────────────────────────────────────────┐
│ Static Scan (on-demand, triggered by user)              │
│   /ffwd-agent-guard scan <path>                         │
│   → ScanOrchestrator → Static + Behavioral + LLM       │
│   → Finding[] → ScanResult                              │
│   → writes scan-cache for dynamic guard to read         │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ Dynamic Guard (real-time, every PreToolUse hook)        │
│   guard-hook → evaluateHook() → RuntimeAnalyzer         │
│   → 6-phase pipeline → allow / deny / confirm           │
└─────────────────────────────────────────────────────────┘
```

## Dynamic Guard: 6-Phase Pipeline

Every `PreToolUse` hook event flows through the RuntimeAnalyzer's 6-phase
pipeline. Each phase produces a 0–1 score and can short-circuit if the score
exceeds the deny threshold for the active protection level.

```
hook event → Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6 → decision
             allow?     score a   score b   score c   score d   score e
             (exit)     critical? critical? critical? critical? aggregate
                        (exit)    (exit)    (exit)    (exit)    → decision
```

### Which phases run per action type

| Phase | Bash | Write/Edit | WebFetch |
|-------|------|------------|----------|
| 1 Allowlist | ✅ | ✅ | ✅ |
| 2 RuntimeAnalyzer | ✅ | ✅ | ✅ |
| 3 StaticAnalyzer | ❌ skip | ✅ file content | ❌ skip |
| 4 BehavioralAnalyzer | ❌ skip | ✅ .ts/.js only | ❌ skip |
| 5 LLM (optional) | ✅ | ✅ | ✅ |
| 6 External API (optional) | ✅ | ✅ | ✅ |

### Phase 1: Allowlist Gate (<1ms)

Check if the action matches a known-safe pattern. If yes → **allow**, stop.

- 200+ safe command prefixes: `git status`, `ls`, `npm test`, etc.
- Only applied when command has no shell metacharacters (`;`, `|`, `$()`, etc.)
- User can inject additional patterns via `config.yaml` → `guard.extra_allowlist`

### Phase 2: Pattern Analysis (<5ms) → score `a`

Produces `Finding[]` from action data pattern matching:

- **Bash**: dangerous commands, fork bombs, shell injection, system/network commands, base64 decode
- **Network**: webhook exfil domains, high-risk TLDs, secret leak in body
- **File ops**: path traversal, sensitive path detection (`.env`, `.ssh/`, `.aws/`)

### Phase 3: Static Analysis (<50ms) → score `b`

**Only runs for Write/Edit actions** (file content exists to scan).
Runs the scan engine's 16 static rules + base64 decode pass against the file
content being written.

### Phase 4: Behavioral Analysis (<200ms) → score `c`

**Only runs for Write/Edit actions** where content is JS/TS (parseable AST).
Runs dataflow analysis: source→sink tracking, dangerous capability combinations.

### Phase 5: LLM Analysis (2–10s, optional) → score `d`

**Gated on `llm.api_key` in config.** Sends action context to Claude for
semantic analysis. For Write/Edit, analyzes the file content. For Bash, wraps
the command as a shell script. Reuses the existing `LLMAnalyzer` from the scan pipeline.

### Phase 6: External Scoring API (optional) → score `e`

**Gated on `guard.scoring_endpoint` in config.** Sends action context + prior
scores/findings to a user-configured HTTP endpoint. Returns a 0–1 score.

```yaml
guard:
  scoring_endpoint: "https://my-security-api.example.com/score"
  scoring_api_key: ""
  scoring_timeout: 3000
```

### Score Aggregation

Each phase produces a 0–1 score via `findingsToScore()`:
`score = max(severity_weight / 4 × confidence)` across all findings.

Final score is a weighted average of all phases that ran:

```
final_score = Σ(wi × si) / Σ(wi)
```

Default weights:

| Phase | Weight | Rationale |
|-------|--------|-----------|
| Runtime (a) | 1.0 | Pattern matching — fast but coarse |
| Static (b) | 1.0 | Regex rules on file content |
| Behavioral (c) | 2.0 | AST dataflow — more reliable |
| LLM (d) | 1.0 | Semantic analysis — broad but slow |
| External (e) | 2.0 | External API — authoritative |

### Protection Level → Decision Mapping

| Mode | allow | confirm | deny |
|------|-------|---------|------|
| **strict** | 0 — 0.5 | _(none)_ | 0.5 — 1.0 |
| **balanced** | 0 — 0.5 | 0.5 — 0.8 | 0.8 — 1.0 |
| **permissive** | 0 — 0.9 | _(none)_ | 0.9 — 1.0 |

- **strict**: binary allow/deny, no user confirmation — anything suspicious is blocked
- **balanced**: three-zone with confirm buffer — the default mode
- **permissive**: binary allow/deny with high tolerance — only blocks near-certain threats

## Static Scan: Multi-Engine Pipeline

The scanner uses a **two-phase, multi-engine pipeline**:

```
              Phase 1 (parallel)                    Phase 2 (sequential)

           ┌──────────────────────┐
           │   Static Analyzer    │
           │  (regex, 16 rules)   │──┐
           └──────────────────────┘  │
                                     ├─ merge ──► ┌──────────────────────┐
           ┌──────────────────────┐  │            │    LLM Analyzer      │
           │ Behavioral Analyzer  │──┘            │  (Claude semantic)   │
           │  (AST + dataflow)    │               └──────────┬───────────┘
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

### Static Analyzer (Phase 1)

Deterministic pattern-based detection using regex rules. Handles all file types.

**Detection passes:**
1. **Pattern matching** — 16 rules across 7 modules against file content
2. **Base64 decoding** — Extract and re-scan encoded payloads
3. **Markdown extraction** — Only scan fenced code blocks in `.md` files

**16 detection rules:** SHELL_EXEC, AUTO_UPDATE, REMOTE_LOADER, READ_ENV_SECRETS,
READ_SSH_KEYS, READ_KEYCHAIN, PRIVATE_KEY_PATTERN, NET_EXFIL_UNRESTRICTED,
WEBHOOK_EXFIL, OBFUSCATION, PROMPT_INJECTION, TROJAN_DISTRIBUTION,
SUSPICIOUS_PASTE_URL, SUSPICIOUS_IP, SOCIAL_ENGINEERING

### Behavioral Analyzer (Phase 1)

AST-based analysis for TypeScript/JavaScript using `@babel/parser`:

```
TypeScript/JavaScript Source
    ↓
AST Parser (@babel/parser)
    ↓
Function Extraction + Security Indicators
    ↓
Forward Dataflow Tracker
    ↓
Source → Sink Analysis
    ↓
Cross-file Context Aggregation
    ↓
Finding Generation
```

**Sources** (data origins): `process.env`, `fs.readFileSync`, credential files
**Sinks** (dangerous destinations): `exec`, `eval`, `fetch`, `spawn`, `writeFile`

**Behavioral rules:**
| Rule | Severity | Detection |
|------|----------|-----------|
| `DATAFLOW_EXFIL` | critical | Secret/credential flows to network |
| `DATAFLOW_RCE` | critical | Network response flows to eval/exec |
| `DATAFLOW_CMD_INJECT` | high | User input flows to command execution |
| `DATAFLOW_EVAL` | high | Data flows to eval/Function |
| `CAPABILITY_C2` | high | Skill has both exec + network capabilities |
| `CAPABILITY_EVAL` | high | Skill uses dynamic code evaluation |
| `CROSS_FILE_FLOW` | medium | Data crosses file boundaries |

### LLM Analyzer (Phase 2)

Uses Claude for semantic threat analysis, enriched by Phase 1 findings.

- **Injection protection** — Wraps untrusted code in random delimiters
- **Scoped analysis** — Only sends files with Phase 1 findings (token budget)
- **Structured output** — JSON response with threat taxonomy mapping
- **Optional** — Gated on `ANTHROPIC_API_KEY` and `policy.analyzers.llm`

### Post-Processing

1. **Deduplication** — Same rule + file + lines within 3 → keep highest severity
2. **Severity filtering** — Drop below `min_severity` from policy
3. **Sorting** — Critical first, then by file + line
4. **Projection** — `Finding[]` → legacy `ScanEvidence[]` + `RiskTag[]`
5. **Cache write** — Optional: persist to scan-cache when `skillId` provided

## Key Abstractions

### Finding

Primary output unit — every analyzer produces `Finding[]`:

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
  analyzer: 'static' | 'behavioral' | 'llm';
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
  scores: { a?: number; b?: number; c?: number; d?: number; e?: number; final?: number };
  phase_stopped: 1 | 2 | 3 | 4 | 5 | 6;
  explanation?: string;
}
```

### BaseAnalyzer

```typescript
abstract class BaseAnalyzer {
  abstract readonly name: 'static' | 'behavioral' | 'llm';
  abstract readonly phase: 1 | 2;
  abstract analyze(ctx: AnalysisContext): Promise<Finding[]>;
  isEnabled(policy: ScanPolicy): boolean;
}
```

### ScanPolicy

Controls scan analysis behavior. Three presets:

| Preset | Analyzers | Min Severity |
|--------|-----------|-------------|
| `strict` | static + behavioral + llm | info |
| `balanced` | static + behavioral | low |
| `permissive` | static only | medium |

### ScanCache

File-backed cache (`~/.ffwd-agent-guard/scan-cache.json`) with 24h TTL.
Written by `ScanOrchestrator` after scans. Entries track skill ID, risk level,
and finding counts for use as trust context by the guard pipeline.

## Shared Infrastructure

### Detection Data (`src/core/shared/detection-data.ts`)

Single source of truth for constants used by both scan and guard pipelines:
`WEBHOOK_EXFIL_DOMAINS`, `HIGH_RISK_TLDS`, `SENSITIVE_FILE_PATHS`,
`SECRET_PATTERNS`, `SECRET_PRIORITY`.

### Detection Engine (`src/core/detection-engine.ts`)

Pure functions extracted from StaticAnalyzer, reusable by both scan and guard:
`runRules()`, `runBase64Pass()`, `extractAndDecodeBase64()`.

## Project Structure

```
src/
├── core/                              # Analysis engine
│   ├── models.ts                      # Finding, ThreatCategory, Severity
│   ├── scanner.ts                     # ScanOrchestrator (static scan)
│   ├── scan-cache.ts                  # ScanCache (file-backed)
│   ├── detection-engine.ts            # Shared rule engine (pure functions)
│   ├── analyzer-factory.ts            # Create analyzers from policy
│   ├── scan-policy.ts                 # Policy presets
│   ├── rule-registry.ts              # Rule catalog
│   ├── deduplicator.ts               # Finding dedup
│   ├── file-classifier.ts            # File categorization
│   ├── shared/
│   │   └── detection-data.ts          # Shared constants
│   └── analyzers/
│       ├── base.ts                    # BaseAnalyzer abstract class
│       ├── static/index.ts           # StaticAnalyzer (regex)
│       ├── behavioral/               # BehavioralAnalyzer (AST)
│       │   ├── index.ts
│       │   ├── ast-parser.ts         # Babel AST extraction
│       │   ├── dataflow.ts           # Source→sink taint tracking
│       │   └── context.ts            # Cross-file aggregation
│       ├── llm/                       # LLMAnalyzer (Claude)
│       │   ├── index.ts
│       │   ├── prompts.ts            # Injection-protected prompts
│       │   └── taxonomy.ts           # Threat category mapping
│       └── runtime/                   # RuntimeAnalyzer (guard pipeline)
│           ├── index.ts              # 6-phase orchestration
│           ├── allowlist.ts          # Phase 1: safe command prefixes
│           ├── denylist.ts           # Phase 2: dangerous patterns
│           ├── scoring.ts            # Score conversion + weighted aggregation
│           ├── decision.ts           # Score → decision (per protection level)
│           └── external-scorer.ts    # Phase 6: HTTP client
├── scanner/                           # SkillScanner public API
│   ├── index.ts                       # Scan entry point
│   ├── file-walker.ts                # Directory traversal
│   └── rules/                        # 16 detection rules
├── registry/                          # Trust management (SkillRegistry)
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
    ├── action-cli.ts                  # CLI for RuntimeAnalyzer
    ├── config-cli.ts                  # Protection level CLI
    └── collector-hook.ts              # Telemetry collector hook
```

## Configuration

Runtime config: `~/.ffwd-agent-guard/config.json` (or `$FFWD_AGENT_GUARD_HOME/config.json`).
Full template: `config.default.yaml`.

Key sections:
- `level` — Protection level: `strict` | `balanced` | `permissive`
- `guard` — Dynamic guard settings: scoring endpoint, weights, extra allowlist
- `llm` — LLM analyzer: API key, model, token budget
- `collector` — OTLP telemetry: endpoint, protocol, log file
- `rules` — Extra regex patterns injected into scan rules

## Testing

```bash
npm install && npm run build && npm test
```
