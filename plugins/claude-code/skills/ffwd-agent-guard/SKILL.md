---
name: ffwd-agent-guard
description: FFWD AgentGuard — AI agent security guard. Use for scanning third-party code, blocking dangerous commands, preventing data leaks, and evaluating action safety.
compatibility: Requires Node.js 18+.
metadata:
  author: core0-io
  version: "2.0"
user-invocable: true
argument-hint: "[scan|action|report|config|reset] [args...]"
---

# FFWD AgentGuard — AI Agent Security Framework

You are a security auditor powered by the FFWD AgentGuard framework. Route the user's request based on the first argument.

## Important: Resolving Script Paths

All commands in this skill reference `scripts/` as a relative path. You **MUST** resolve this to the absolute path of this skill's directory before running any command. To find the skill directory:

1. This SKILL.md file's parent directory **is** the skill directory
2. If this file is at `/path/to/ffwd-agent-guard/SKILL.md`, then scripts are at `/path/to/ffwd-agent-guard/scripts/`
3. Before running any `node scripts/...` command, **always `cd` into the skill directory first**, or use the full absolute path

Example: if this SKILL.md is at `~/.openclaw/skills/ffwd-agent-guard/SKILL.md`, run:
```bash
cd ~/.openclaw/skills/ffwd-agent-guard && node scripts/action-cli.js decide --type exec_command --command "ls"
```

## Command Routing

Parse `$ARGUMENTS` to determine the subcommand:

- **`scan <path>`** — Scan a skill or codebase for security risks
- **`action <description>`** — Evaluate whether a runtime action is safe
- **`report`** — View recent security events from the audit log
- **`config [show|<level>]`** — View or set protection level
- **`reset`** — Reset config to defaults

If no subcommand is given, or the first argument is a path, default to **scan**.

---

# Security Operations

## Subcommand: scan

Scan the target path for security risks using all detection rules.

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
## FFWD AgentGuard Security Scan Report

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

For structured decisions, use AgentGuard's bundled `action-cli.js` (in this skill's `scripts/` directory). It returns JSON.

```
node scripts/action-cli.js decide --type exec_command --command "<cmd>"
```

Parse the JSON output: if `decision` is `deny`, recommend **DENY** with the returned evidence. Combine with policy-based checks (webhook domains, secret scanning, etc.).

### Output Format

```
## FFWD AgentGuard Action Evaluation

**Action**: <action type and description>
**Decision**: ALLOW | DENY | CONFIRM
**Risk Level**: low | medium | high | critical
**Risk Tags**: [TAG1, TAG2, ...]

### Evidence
- <description of each risk factor found>

### Recommendation
<What the user should do and why>
```

---

---

## Subcommand: config

View or update the FFWD AgentGuard configuration.

### Routing

| Input | Action |
|-------|--------|
| `config` or `config show` | Run `node scripts/config-cli.js show` |
| `config <level>` (strict/balanced/permissive) | Read `~/.ffwd-agent-guard/config.json`, update only the `level` field (preserve all other settings), write back, confirm to user |

### Config File

All configuration is stored in `~/.ffwd-agent-guard/config.json` (or `$FFWD_AGENT_GUARD_HOME/config.json`).
A template with all options is available at `config.default.yaml` in the plugin directory.

Full schema:

```json
{
  "level": "balanced",
  "guard": {
    "available_tools": [],
    "blocked_tools": [],
    "guarded_tools": {
      "Bash": "exec_command",
      "Write": "write_file",
      "Edit": "write_file",
      "WebFetch": "network_request",
      "WebSearch": "network_request"
    }
  },
  "collector": {
    "endpoint": "",
    "api_key": "",
    "timeout": 5000,
    "protocol": "http",
    "log": ""
  },
  "audit": {
    "local": true,
    "max_size_mb": 10,
    "otel": true
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `level` | string | `"balanced"` | Protection level: `strict`, `balanced`, or `permissive` |
| `guard.available_tools` | string[] | `[]` | Tool-level allowlist (Phase 0). When non-empty, only listed tools are available |
| `guard.blocked_tools` | string[] | `[]` | Tool-level denylist (Phase 0). Listed tools are unconditionally blocked |
| `guard.guarded_tools` | object | *(see above)* | Tool → action type mapping. Tools listed here enter Phase 1-6 deep analysis |
| `collector.endpoint` | string | `""` | OTLP base URL (appends /v1/traces, /v1/metrics, /v1/logs) |
| `collector.api_key` | string | `""` | Bearer token for collector auth |
| `collector.timeout` | number | `5000` | Collector request timeout in ms |
| `collector.protocol` | string | `"http"` | OTLP transport: `http` (port 4318) or `grpc` (port 4317) |
| `collector.log` | string | `""` | Path to local JSONL metrics log file (supports `~/`) |
| `audit.local` | boolean | `true` | Write audit entries to local JSONL (`~/.ffwd-agent-guard/audit.jsonl`) |
| `audit.max_size_mb` | number | `10` | Rotate local log when exceeded (0 = no rotation) |
| `audit.otel` | boolean | `true` | Export audit logs via OTEL Logs (uses collector endpoint/api_key) |

Set `FFWD_AGENT_GUARD_HOME` environment variable to change the config directory (default: `~/.ffwd-agent-guard`).

### Protection Levels

| Level | Behaviour |
|-------|----------|
| `strict` | Block all risky actions — every dangerous or suspicious command is denied |
| `balanced` | Block dangerous, confirm risky — default level, good for daily use |
| `permissive` | Only block critical threats — for experienced users who want minimal friction |

---

## Subcommand: reset

Reset `~/.ffwd-agent-guard/config.json` to factory defaults (from `config.default.yaml`).

Run:
```bash
node scripts/config-cli.js reset
```

---

# Reporting

## Subcommand: report

Display recent security events from the FFWD AgentGuard audit log.

### Log Location

The audit log is stored at `~/.ffwd-agent-guard/audit.jsonl`. Each line is a JSON object with an `event` discriminator field:

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

1. Read `~/.ffwd-agent-guard/audit.jsonl` using the Read tool
2. Parse each line as JSON
3. Filter by `event` type — show guard entries in the main table, scan entries in a separate section
4. Format as a table showing recent events (last 50 by default)
5. If any events have `initiating_skill`, add a "Skill Activity" section grouping events by skill

### Output Format

```
## FFWD AgentGuard Security Report

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
<Brief analysis of security posture and any patterns of concern>
```

If the log file doesn't exist, inform the user that no security events have been recorded yet, and suggest they enable hooks via `./setup.sh` or by adding the plugin.

