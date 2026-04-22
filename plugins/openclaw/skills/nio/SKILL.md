---
name: nio
description: Nio — AI agent execution assurance. Use for evaluating action safety before execution, scanning code for execution risks, and reviewing the agent execution audit log.
compatibility: Requires Node.js 18+.
metadata:
  author: core0-io
  version: "2.0"
user-invocable: true
command-dispatch: tool
command-tool: nio_command
command-arg-mode: raw
argument-hint: "[scan|action|report|config|reset] [args...]"
---

# Nio — AI Agent Execution Assurance Framework

You are an execution assurance evaluator powered by the Nio framework. Route the user's request based on the first argument.

## Important: Resolving Script Paths

All commands in this skill reference `scripts/` as a relative path. You **MUST** resolve this to the absolute path of this skill's directory before running any command, and invoke the script with a **single** `node` command — no shell chaining.

1. This SKILL.md file's parent directory **is** the skill directory. Do **not** guess a hard-coded location (`~/.openclaw/skills/nio`, `~/.claude/...` etc. are not reliable) — derive the absolute path from where you actually loaded this file.
2. If this file is at `/path/to/nio/SKILL.md`, scripts are at `/path/to/nio/scripts/`.
3. Whenever the instructions below say `node scripts/X`, invoke `node <absolute-skill-dir>/scripts/X` instead — with the real absolute path substituted.
4. **Do not** prepend `cd <dir> && ...`, and do not use `;`, `&&`, `|`, `||`, `$(...)`, or backtick subshells in the command. Some hosts (OpenClaw and others) preflight-reject compound interpreter invocations. The command you issue must be the single form `node <absolute-path>.js [args...]`.

Example (the path below is a placeholder — substitute the real location of this SKILL.md's directory):

```bash
node /absolute/path/to/skill/scripts/action-cli.js decide --type exec_command --command "ls"
```

## Command Routing

Parse `$ARGUMENTS` to determine the subcommand:

- **`scan <path>`** — Scan a skill or codebase for execution risks
- **`action <description>`** — Evaluate whether a runtime action is safe to execute
- **`report`** — View recent agent execution events from the audit log
- **`config [show|<level>]`** — View or set protection level
- **`reset`** — Reset config to defaults

If no subcommand is given, or the first argument is a path, default to **scan**.

---

# Execution Assurance Operations

## Subcommand: scan

Scan the target path for execution risks using all detection rules.

### File Discovery

Use Glob to find all scannable files at the given path. Include: `*.js`, `*.ts`, `*.jsx`, `*.tsx`, `*.mjs`, `*.cjs`, `*.py`, `*.json`, `*.yaml`, `*.yml`, `*.toml`, `*.sol`, `*.sh`, `*.bash`, `*.md`

**Markdown scanning**: For `.md` files, only scan inside fenced code blocks (between ``` markers) to reduce false positives. Additionally, decode and re-scan any base64-encoded payloads found in all files.

Skip directories: `node_modules`, `dist`, `build`, `.git`, `coverage`, `__pycache__`, `.venv`, `venv`
Skip files: `*.min.js`, `*.min.css`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`

### Detection Rules

For each rule, use Grep to search the relevant file types. Record every match with file path, line number, and matched content. For detailed rule patterns, see [SCAN-RULES.md](SCAN-RULES.md).

| # | Rule ID | Severity | File Types | Description |
|---|---------|----------|------------|-------------|
| 1 | SHELL_EXEC | HIGH | js,ts,mjs,cjs,py,md | Command execution capabilities |
| 2 | AUTO_UPDATE | CRITICAL | js,ts,py,sh,md | Auto-update / download-and-execute |
| 3 | REMOTE_LOADER | CRITICAL | js,ts,mjs,py,md | Dynamic code loading from remote |
| 4 | READ_ENV_SECRETS | MEDIUM | js,ts,mjs,py | Environment variable access |
| 5 | READ_SSH_KEYS | CRITICAL | all | SSH key file access |
| 6 | READ_KEYCHAIN | CRITICAL | all | System keychain / browser profiles |
| 7 | PRIVATE_KEY_PATTERN | CRITICAL | all | Hardcoded private keys |
| 8 | OBFUSCATION | HIGH | js,ts,mjs,py,md | Code obfuscation techniques |
| 9 | PROMPT_INJECTION | CRITICAL | all | Prompt injection attempts |
| 10 | NET_EXFIL_UNRESTRICTED | HIGH | js,ts,mjs,py,md | Unrestricted POST / upload |
| 11 | WEBHOOK_EXFIL | CRITICAL | all | Webhook exfiltration domains |
| 12 | TROJAN_DISTRIBUTION | CRITICAL | md | Trojanized binary download + password + execute |
| 13 | SUSPICIOUS_PASTE_URL | HIGH | all | URLs to paste sites (pastebin, glot.io, etc.) |
| 14 | SUSPICIOUS_IP | MEDIUM | all | Hardcoded public IPv4 addresses |
| 15 | SOCIAL_ENGINEERING | MEDIUM | md | Pressure language + execution instructions |

### Risk Level Calculation

- Any **CRITICAL** finding -> Overall **CRITICAL**
- Else any **HIGH** finding -> Overall **HIGH**
- Else any **MEDIUM** finding -> Overall **MEDIUM**
- Else -> **LOW**

### Output Format

```
## Nio Execution Risk Scan Report

**Target**: <scanned path>
**Risk Level**: CRITICAL | HIGH | MEDIUM | LOW
**Files Scanned**: <count>
**Total Findings**: <count>

### Findings

| # | Risk Tag | Severity | File:Line | Evidence |
|---|----------|----------|-----------|----------|
| 1 | TAG_NAME | critical | path/file.ts:42 | `matched content` |

### Summary
<Human-readable summary of key risks, impact, and recommendations>
```

---

## Subcommand: action

Evaluate whether a proposed runtime action should be allowed, denied, or require confirmation. For detailed policies and detector rules, see [ACTION-POLICIES.md](ACTION-POLICIES.md).

### Supported Action Types

- `network_request` — HTTP/HTTPS requests
- `exec_command` — Shell command execution
- `read_file` / `write_file` — File system operations
- `secret_access` — Environment variable access

### Decision Framework

Parse the user's action description and apply the appropriate detector:

**Network Requests**: Check domain against webhook list and high-risk TLDs, check body for secrets
**Command Execution**: Check against dangerous/sensitive/system/network command lists, detect shell injection
**Secret Access**: Classify secret type and apply priority-based risk levels

### Default Policies

| Scenario | Decision |
|----------|----------|
| Private key exfiltration | **DENY** (always) |
| API secret exfiltration | CONFIRM |
| Command execution | **DENY** (default) |
| Untrusted domain | CONFIRM |
| Body contains secret | **DENY** |

### Action CLI (`action-cli.js`)

For structured decisions, use Nio's bundled `action-cli.js` (in this skill's `scripts/` directory). It returns JSON.

```
node scripts/action-cli.js decide --type exec_command --command "<cmd>"
```

Parse the JSON output: if `decision` is `deny`, recommend **DENY** with the returned evidence. Combine with policy-based checks (webhook domains, secret scanning, etc.).

### Output Format

```
## Nio Action Evaluation

**Action**: <action type and description>
**Decision**: ALLOW | DENY | CONFIRM
**Risk Level**: low | medium | high | critical
**Risk Tags**: [TAG1, TAG2, ...]

### Evidence
- <description of each risk factor found>

### Recommendation
<What should happen and why — allow the action to proceed, block it, or escalate for human confirmation>
```

---

---

## Subcommand: config

View or update the Nio configuration.

### Routing

| Input | Action |
|-------|--------|
| `config` or `config show` | Run `node scripts/config-cli.js show` |
| `config <level>` (strict/balanced/permissive) | Read `~/.nio/config.yaml`, update only the `guard.level` field (preserve all other settings), write back, confirm to user |

### Config File

All configuration is stored in `~/.nio/config.yaml` (or `$NIO_HOME/config.yaml`).
A template with all options is available at `config.default.yaml` in the plugin directory.

Two top-level sections: `guard` (evaluation settings) and `collector` (telemetry settings).

```json
{
  "guard": {
    "protection_level": "balanced",
    "confirm_action": "allow",
    "file_scan_rules": {},
    "action_guard_rules": {},
    "llm_analyser": { "enabled": false, "api_key": "" },
    "external_analyser": { "enabled": false, "endpoint": "" },
    "allowed_commands": [],
    "available_tools": {},
    "blocked_tools": {},
    "guarded_tools": {
      "claude_code": { "Bash": "exec_command", "Write": "write_file", "Edit": "write_file", "WebFetch": "network_request", "WebSearch": "network_request" },
      "openclaw": { "exec": "exec_command", "write": "write_file", "web_fetch": "network_request", "browser": "network_request" }
    },
    "scoring_weights": {}
  },
  "collector": {
    "endpoint": "",
    "api_key": "",
    "timeout": 5000,
    "protocol": "http",
    "metrics": { "enabled": true, "local": true, "log": "", "max_size_mb": 100 },
    "traces": { "enabled": true },
    "logs": { "enabled": true, "local": true, "path": "", "max_size_mb": 100 }
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `guard.protection_level` | string | `"balanced"` | Protection level: `strict`, `balanced`, or `permissive` |
| `guard.confirm_action` | string | `"allow"` | Confirm fallback: `allow` (let through + audit log), `deny` (block), or `ask` (platform confirm if available, else allow) |
| `guard.file_scan_rules` | object | `{}` | Extra scan patterns (Phase 3 + scan command) |
| `guard.action_guard_rules` | object | `{}` | Extra guard patterns (Phase 2 runtime analysis) |
| `guard.llm_analyser.enabled` | boolean | `true` | Enable/disable Phase 5 LLM analysis |
| `guard.llm_analyser.api_key` | string | `""` | Anthropic API key for Phase 5 LLM analysis |
| `guard.external_analyser.enabled` | boolean | `true` | Enable/disable Phase 6 external scoring |
| `guard.external_analyser.endpoint` | string | `""` | Phase 6 external scoring API URL |
| `guard.allowed_commands` | string[] | `[]` | Command prefixes that bypass the guard pipeline |
| `guard.available_tools` | object | `{}` | Phase 0 allowlist. Keys are platform names (`claude_code`, `openclaw`, ...) or the reserved `mcp` key — a cross-platform list applied to MCP tools. MCP entries accept either a bare local name (`HassTurnOn`) or server-qualified form (`hass__HassTurnOn`); matching is case-insensitive. |
| `guard.blocked_tools` | object | `{}` | Phase 0 denylist. Same structure as `available_tools`; the `mcp` key covers MCP tools on every platform in one place. |
| `guard.guarded_tools` | object | *(see above)* | Per-platform tool → action type mapping |
| `collector.endpoint` | string | `""` | OTLP base URL (appends /v1/traces, /v1/metrics, /v1/logs) |
| `collector.api_key` | string | `""` | Bearer token for collector auth |
| `collector.protocol` | string | `"http"` | OTLP transport: `http` (port 4318) or `grpc` (port 4317) |
| `collector.metrics.enabled` | boolean | `true` | Enable OTEL metrics export |
| `collector.metrics.local` | boolean | `true` | Write metrics to local JSONL |
| `collector.traces.enabled` | boolean | `true` | Enable OTEL traces export |
| `collector.logs.enabled` | boolean | `true` | Enable OTEL audit log export |
| `collector.logs.local` | boolean | `true` | Write audit logs to local JSONL |
| `collector.logs.max_size_mb` | number | `100` | Rotate local audit log when exceeded |

Set `NIO_HOME` environment variable to change the config directory (default: `~/.nio`).

### Protection Levels

| Level | Behaviour |
|-------|----------|
| `strict` | Block all risky actions — every dangerous or suspicious command is denied |
| `balanced` | Block dangerous, confirm risky — default level, good for daily use |
| `permissive` | Only block critical threats — for experienced users who want minimal friction |

---

## Subcommand: reset

Reset `~/.nio/config.yaml` to factory defaults (from `config.default.yaml`).

Run:
```bash
node scripts/config-cli.js reset
```

---

# Reporting

## Subcommand: report

Display recent agent execution events from the Nio audit log.

**This subcommand uses the Read tool only — there is no script to run.** Do not attempt to invoke `node scripts/report.js`, `report-cli.js`, `reporter.js`, or any other script for this subcommand. None exist. The only action is: read `~/.nio/audit.jsonl` with the Read tool, parse each line as JSON, and format the output as shown below.

### Log Location

The audit log is stored at `~/.nio/audit.jsonl`. Each line is a JSON object with an `event` discriminator field:

**Guard entry** (`event: "guard"`) — one per tool call evaluation:

```json
{"event":"guard","timestamp":"...","platform":"claude-code","session_id":"...","tool_name":"Bash","action_type":"exec_command","tool_input_summary":"rm -rf /","decision":"deny","risk_level":"critical","risk_score":0.95,"risk_tags":["DANGEROUS_COMMAND"],"phase_stopped":2,"scores":{"runtime":0.95,"final":0.95},"phases":{"runtime":{"score":0.95,"finding_count":1,"duration_ms":2}},"top_findings":[{"rule_id":"DANGEROUS_COMMAND","severity":"critical","category":"execution","title":"Destructive command","confidence":1.0}],"explanation":"...","initiating_skill":"some-skill","event_type":"pre"}
```

**Scan entry** (`event: "session_scan"`) — from session-start skill scanning:

```json
{"event":"session_scan","timestamp":"...","platform":"claude-code","skill_name":"some-skill","risk_level":"high","risk_tags":["SHELL_EXEC"],"finding_count":3}
```

**Lifecycle entry** (`event: "lifecycle"`) — subagent/agent lifecycle (OpenClaw only):

```json
{"event":"lifecycle","timestamp":"...","platform":"openclaw","session_id":"...","lifecycle_type":"subagent_spawning"}
```

Old-format lines (without `event` field) are also valid — treat them as guard entries with `event_type: "pre"`.

### How to Display

1. Read `~/.nio/audit.jsonl` using the Read tool
2. Parse each line as JSON
3. Filter by `event` type — show guard entries in the main table, scan entries in a separate section
4. Format as a table showing recent events (last 50 by default)
5. If any events have `initiating_skill`, add a "Skill Activity" section grouping events by skill

### Output Format

```
## Nio Execution Report

**Events**: <total count>
**Blocked**: <deny count>
**Confirmed**: <confirm count>

### Recent Events

| Time | Tool | Type | Decision | Risk | Score | Phase | Top Finding | Skill |
|------|------|------|----------|------|-------|-------|-------------|-------|
| 14:30 | Bash | exec | DENY | critical | 0.95 | 2 | DANGEROUS_COMMAND | some-skill |
| 14:28 | Write | write | ASK | high | 0.65 | 4 | OBFUSCATION | — |

### Pipeline Stats

If enough events exist, show per-phase statistics:

| Phase | Invocations | Avg Score | Avg Duration |
|-------|-------------|-----------|--------------|
| Runtime (2) | 45 | 0.12 | 2ms |
| Static (3) | 20 | 0.08 | 18ms |
| Behavioural (4) | 12 | 0.15 | 85ms |

### Skill Activity

If any events were triggered by skills, group them here:

| Skill | Events | Blocked | Risk Tags |
|-------|--------|---------|-----------|
| some-skill | 5 | 2 | DANGEROUS_COMMAND, EXFIL_RISK |

### Summary
<Brief analysis of agent execution behaviour and any patterns of concern>
```

If the log file doesn't exist, inform the user that no execution events have been recorded yet, and suggest they enable hooks via `./setup.sh` or by adding the plugin.

