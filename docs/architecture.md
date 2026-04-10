# Architecture

## Overview

AgentGuard is a three-layered security framework for AI agents:

1. **Skill Scanner** — Multi-engine code analysis (static + behavioral + LLM)
2. **Skill Registry** — Trust level and capability management
3. **Action Scanner** — Runtime action decision engine

## Three-Layer Architecture

```
┌──────────────────────────────────────────────────────┐
│  Layer 1: Auto Guard (hooks — install once, forget)  │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐  │
│  │ PreToolUse   │ │ PostToolUse  │ │ Config       │  │
│  │ Block danger │ │ Audit log    │ │ 3 levels     │  │
│  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘  │
│         └────────┬───────┘               │           │
│                  ▼                       │           │
│        ActionScanner Engine ◄────────────┘           │
└──────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────┐
│  Layer 2: Deep Scan (skill — on demand)              │
│  /ffwd-agent-guard scan   — Multi-engine analysis    │
│  /ffwd-agent-guard action — Runtime action evaluation│
│  /ffwd-agent-guard trust  — Skill trust management   │
│  /ffwd-agent-guard report — Security event log       │
└──────────────────────────────────────────────────────┘
```

## Skill Scanner Architecture

The scanner uses a **two-phase, multi-engine pipeline** inspired by
[Cisco AI Defense skill-scanner](https://github.com/cisco-ai-defense/skill-scanner):

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

## Key Abstractions

### BaseAnalyzer

```typescript
abstract class BaseAnalyzer {
  abstract readonly name: 'static' | 'behavioral' | 'llm';
  abstract readonly phase: 1 | 2;
  abstract analyze(ctx: AnalysisContext): Promise<Finding[]>;
  isEnabled(policy: ScanPolicy): boolean;
}
```

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

### ScanPolicy

Controls analysis behavior. Three presets:

| Preset | Analyzers | Min Severity |
|--------|-----------|-------------|
| `strict` | static + behavioral + llm | info |
| `balanced` | static + behavioral | low |
| `permissive` | static only | medium |

### RuleRegistry

Central catalog of all detection rules with enriched metadata
(title, category, remediation). Wraps 16 built-in regex rules and
supports dynamic registration.

## Project Structure

```
src/
├── core/                              # Analysis engine
│   ├── models.ts                      # Finding, ThreatCategory, Severity
│   ├── scanner.ts                     # ScanOrchestrator
│   ├── analyzer-factory.ts            # Create analyzers from policy
│   ├── scan-policy.ts                 # Policy presets
│   ├── rule-registry.ts              # Rule catalog
│   ├── deduplicator.ts               # Finding dedup
│   ├── file-classifier.ts            # File categorization
│   └── analyzers/
│       ├── base.ts                    # BaseAnalyzer abstract class
│       ├── static/index.ts           # StaticAnalyzer (regex)
│       ├── behavioral/               # BehavioralAnalyzer (AST)
│       │   ├── index.ts
│       │   ├── ast-parser.ts         # Babel AST extraction
│       │   ├── dataflow.ts           # Source→sink taint tracking
│       │   └── context.ts            # Cross-file aggregation
│       └── llm/                       # LLMAnalyzer (Claude)
│           ├── index.ts
│           ├── prompts.ts            # Injection-protected prompts
│           └── taxonomy.ts           # Threat category mapping
├── scanner/                           # Legacy wrapper (delegates to core/)
│   ├── index.ts                       # SkillScanner public API
│   ├── file-walker.ts                # Directory traversal
│   └── rules/                        # 16 detection rules
├── action/                            # Runtime action evaluation
├── registry/                          # Trust management
├── adapters/                          # Platform integration (Claude Code, OpenClaw)
├── policy/                            # Default policies
├── types/                             # Type definitions
├── utils/                             # Utility functions
└── scripts/                           # CLI entry points
```

## Testing

```bash
npm install && npm run build && npm test
```
