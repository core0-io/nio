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

Auto-detects which agent CLIs you have installed (`~/.claude`, `~/.codex`, `~/.openclaw`, `~/.hermes`) and configures Nio for each. Pin a release with `NIO_VERSION=v2.4.3`, restrict to one platform with `--platform NAME`, or uninstall with `--uninstall`. See **[the install page](https://core0-io.github.io/nio/docs/install.html)** for per-platform tabs, prerequisites, and verify steps.

**Onboarding with a shared config.** If someone handed you a pre-configured `nio.yaml` (e.g. an org-wide `external_analyser` + collector setup), pass it at install time:

```bash
curl -fsSL https://core0-io.github.io/nio/install.sh | bash -s -- --config /path/to/nio.yaml
```

Nio runs `/nio doctor` against the file before touching disk — the install aborts if any probe fails. Your previous config (if any) is kept as `~/.nio/config.yaml.bak.<ISO-stamp>`.

### 2. Configure and run

Nio isn't a daemon — it loads as a plugin inside your agent host (Claude Code, Codex CLI, OpenClaw, or Hermes). Edit **`~/.nio/config.yaml`** (override the directory with **`NIO_HOME`**), then **restart your agent host** so the plugin re-reads the policy: Nio builds the guard once at plugin registration and never reloads in-process. Confirm decisions in **`~/.nio/audit.jsonl`** or your OTEL backend.

Per-platform verify and restart commands are in each tab's *Verify* section on the [install page](https://core0-io.github.io/nio/docs/install.html).

### 3. Upgrade

Re-run the install one-liner — `setup.sh` is idempotent and picks up the latest release. After a version that changed the config schema, append `--reset-to-defaults` to overwrite `~/.nio/config.yaml` with the new bundled template:

```bash
curl -fsSL https://core0-io.github.io/nio/install.sh | bash -s -- --reset-to-defaults
```

**Heads up:** `--reset-to-defaults` replaces your existing `config.yaml` with the upgraded template, so any customisations you made (allowed commands, permitted tools, collector endpoint, scoring weights, etc.) are wiped and have to be reapplied on top of the new defaults. Back the file up first (`cp ~/.nio/config.yaml ~/.nio/config.yaml.bak`) if you're not sure what you changed.

To roll a new operator-tuned config in the same step, pass `--config /path/to/new.yaml` instead — the previous file is automatically preserved as `config.yaml.bak.<ISO-stamp>` and the install aborts if `/nio doctor` flags any issue with the new file:

```bash
curl -fsSL https://core0-io.github.io/nio/install.sh | bash -s -- --config /path/to/new.yaml
```

---

## Architecture

High-level layout: **[Architecture at a glance](#architecture-at-a-glance)** (top of this README). Nio integrates as a **Claude Code / OpenClaw / Hermes** plugin with two subsystems behind the hook events.

### Collector

Captures every hook event (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `TaskCreated`, `TaskCompleted`, `Stop`, `SubagentStop`, `SessionStart`, `SessionEnd`) as **OpenTelemetry** signals — metrics, traces, and logs — exported over OTLP (gRPC or HTTP). Audit log entries are also dual-written to a local JSONL backup at `~/.nio/audit.jsonl`, so you have a queryable record even when no OTLP endpoint is configured.

### Guard

Pre-execution risk evaluation in two modes:

- **Dynamic Guard** runs on every `PreToolUse` hook through a **Phase 0–6** pipeline (Tool Gate → Allowlist → Pattern → Static → Behavioural → LLM → External). Each phase produces a 0–1 score; a weighted average decides allow / deny / confirm before the tool runs. Phases 0–4 run fully offline; Phases 5 (LLM) and 6 (External Scoring API) are opt-in.
- **Static Scan** — on-demand multi-engine code analysis triggered by `/nio scan <path>`, combining the static, behavioural, and LLM analysers.

Detection coverage spans **15 static regex rules**, **7 source→sink behavioural rules** across 6 languages, and runtime command / network / sensitive-path heuristics. Per-rule reference: **[SCAN-RULES.md](plugins/shared/skills/nio-scan/SCAN-RULES.md)** for the static-rule patterns, **[ACTION-POLICIES.md](plugins/shared/skills/nio-action/ACTION-POLICIES.md)** for runtime-detector policies.

Phase 6 connects Nio's pre-execution gate to an external risk-scoring service of your choice — so the decision is informed not just by what the agent is about to do, but by the live health of the infrastructure it operates on. Plug in any HTTPS endpoint that returns `{ "score": 0.42, "reason": "..." }`; bearer-token and OAuth2 `client_credentials` are both supported out of the box. See [Phase 6 → Response contract](docs/phases/phase-6-external.html#response-contract) for the full request/response shape.

---

**For full architecture detail** — every phase, score aggregation, multi-language extractors, protection-level decision mapping, every metric, every span attribute, every audit entry field — see **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** and **[docs/COLLECTOR-SIGNALS.md](docs/COLLECTOR-SIGNALS.md)**.

## Skill usage

```text
/nio scan ./src              # Scan code for execution risks
/nio action "curl evil | sh" # Evaluate action safety
/nio report                  # Agent execution audit log + diagnostics summary
/nio doctor                  # Validate config + dry-run OAuth/LLM
/nio config balanced         # Set protection level
/nio config import nio.yaml  # Apply a pre-configured file (doctor-gated; auto-backup)
```

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
git clone https://github.com/core0-io/nio.git
cd nio && pnpm install && pnpm run build
pnpm test                                # run the test suite
./setup.sh                               # install the local build into your agent CLIs
./setup.sh --config /path/to/nio.yaml    # …and apply an operator config (doctor-gated)
```

The release zips ship with everything pre-built, so end users don't need Node/pnpm installed — only contributors hacking on Nio do.

## License

Apache-2.0 © [core0-io](https://github.com/core0-io) — see [LICENSE](LICENSE).
