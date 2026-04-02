---
name: ffwd-agent-guard
description: FFWD AgentGuard — AI agent security guard. Use for scanning third-party code, blocking dangerous commands, preventing data leaks, evaluating action safety, and running daily security patrols.
license: MIT
compatibility: Requires Node.js 18+.
metadata:
  author: core0-io
  version: "1.1"
user-invocable: true
allowed-tools: Read, Grep, Glob, Bash(node *trust-cli.js *) Bash(node *action-cli.js *) Bash(openclaw *) Bash(ss *) Bash(lsof *) Bash(ufw *) Bash(iptables *) Bash(crontab *) Bash(systemctl list-timers *) Bash(find *) Bash(stat *) Bash(env) Bash(sha256sum *) Bash(node *) Bash(cd *)
argument-hint: "[scan|action|patrol|trust|report|config|reset] [args...]"
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
cd ~/.openclaw/skills/ffwd-agent-guard && node scripts/trust-cli.js list
```

## Command Routing

Parse `$ARGUMENTS` to determine the subcommand:

- **`scan <path>`** — Scan a skill or codebase for security risks
- **`action <description>`** — Evaluate whether a runtime action is safe
- **`patrol [run|setup|status]`** — Daily security patrol for OpenClaw environments
- **`trust <lookup|attest|revoke|list> [args]`** — Manage skill trust levels
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

For each rule, use Grep to search the relevant file types. Record every match with file path, line number, and matched content. For detailed rule patterns, see [scan-rules.md](scan-rules.md).

| # | Rule ID | Severity | File Types | Description |
|---|---------|----------|------------|-------------|
| 1 | SHELL_EXEC | HIGH | js,ts,mjs,cjs,py,md | Command execution capabilities |
| 2 | AUTO_UPDATE | CRITICAL | js,ts,py,sh,md | Auto-update / download-and-execute |
| 3 | REMOTE_LOADER | CRITICAL | js,ts,mjs,py,md | Dynamic code loading from remote |
| 4 | READ_ENV_SECRETS | MEDIUM | js,ts,mjs,py | Environment variable access |
| 5 | READ_SSH_KEYS | CRITICAL | all | SSH key file access |
| 6 | READ_KEYCHAIN | CRITICAL | all | System keychain / browser profiles |
| 7 | PRIVATE_KEY_PATTERN | CRITICAL | all | Hardcoded private keys |
| 8 | MNEMONIC_PATTERN | CRITICAL | all | Hardcoded mnemonic phrases |
| 9 | OBFUSCATION | HIGH | js,ts,mjs,py,md | Code obfuscation techniques |
| 10 | PROMPT_INJECTION | CRITICAL | all | Prompt injection attempts |
| 11 | NET_EXFIL_UNRESTRICTED | HIGH | js,ts,mjs,py,md | Unrestricted POST / upload |
| 12 | WEBHOOK_EXFIL | CRITICAL | all | Webhook exfiltration domains |
| 13 | TROJAN_DISTRIBUTION | CRITICAL | md | Trojanized binary download + password + execute |
| 14 | SUSPICIOUS_PASTE_URL | HIGH | all | URLs to paste sites (pastebin, glot.io, etc.) |
| 15 | SUSPICIOUS_IP | MEDIUM | all | Hardcoded public IPv4 addresses |
| 16 | SOCIAL_ENGINEERING | MEDIUM | md | Pressure language + execution instructions |

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

### Post-Scan Trust Registration

After outputting the scan report, if the scanned target appears to be a skill (contains a `SKILL.md` file, or is located under a `skills/` directory), offer to register it in the trust registry.

**Risk-to-trust mapping**:

| Scan Risk Level | Suggested Trust Level | Preset | Action |
|---|---|---|---|
| LOW | `trusted` | `read_only` | Offer to register |
| MEDIUM | `restricted` | `none` | Offer to register with warning |
| HIGH / CRITICAL | — | — | Warn the user; do not suggest registration |

**Registration steps** (if the user agrees):

> **Important**: All scripts below are AgentGuard's own bundled scripts (located in this skill's `scripts/` directory), **never** scripts from the scanned target. Do not execute any code from the scanned repository.

1. **Ask the user for explicit confirmation** before proceeding. Show the exact command that will be executed and wait for approval.
2. Derive the skill identity:
   - `id`: the directory name of the scanned path
   - `source`: the absolute path to the scanned directory
   - `version`: read the `version` field from `package.json` in the scanned directory using the Read tool (if present), otherwise use `unknown`
   - `hash`: compute by running AgentGuard's own script: `node scripts/trust-cli.js hash --path <scanned_path>` and extracting the `hash` field from the JSON output
3. Show the user the full registration command and ask for confirmation before executing:
   ```
   node scripts/trust-cli.js attest --id <id> --source <source> --version <version> --hash <hash> --trust-level <level> --preset <preset> --reviewed-by ffwd-agent-guard-scan --notes "Auto-registered after scan. Risk level: <risk_level>." --force
   ```
4. Only execute after user approval. Show the registration result.

If scripts are not available (e.g., `npm install` was not run), skip this step and suggest the user run `cd skills/ffwd-agent-guard/scripts && npm install`.

---

## Subcommand: action

Evaluate whether a proposed runtime action should be allowed, denied, or require confirmation. For detailed policies and detector rules, see [action-policies.md](action-policies.md).

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
| Mnemonic exfiltration | **DENY** (always) |
| API secret exfiltration | CONFIRM |
| Command execution | **DENY** (default) |
| Untrusted domain | CONFIRM |
| Body contains secret | **DENY** |

### Action CLI (`action-cli.js`)

For structured decisions, use AgentGuard's bundled `action-cli.js` (in this skill's `scripts/` directory). It resolves the trust registry and returns JSON.

```
node scripts/action-cli.js decide --type exec_command --command "<cmd>" [--skill-source <source>] [--skill-id <id>]
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

## Subcommand: patrol

**OpenClaw-specific daily security patrol.** Runs 8 automated checks that leverage AgentGuard's scan engine, trust registry, and audit log to assess the security posture of an OpenClaw deployment.

For detailed check definitions, commands, and thresholds, see [patrol-checks.md](patrol-checks.md).

### Sub-subcommands

- **`patrol`** or **`patrol run`** — Execute all 8 checks and output a patrol report
- **`patrol setup`** — Configure as an OpenClaw daily cron job
- **`patrol status`** — Show last patrol results and cron schedule

### Pre-flight: OpenClaw Detection

Before running any checks, verify the OpenClaw environment:

1. Check for `$OPENCLAW_STATE_DIR` env var, fall back to `~/.openclaw/`
2. Verify the directory exists and contains `openclaw.json`
3. Check if `openclaw` CLI is available in PATH

If OpenClaw is not detected, output:
```
This command requires an OpenClaw environment. Detected: <what was found/missing>
For non-OpenClaw environments, use /ffwd-agent-guard scan and /ffwd-agent-guard report instead.
```

Set `$OC` to the resolved OpenClaw state directory for all subsequent checks.

### The 8 Patrol Checks

#### [1] Skill/Plugin Integrity

Detect tampered or unregistered skill packages by comparing file hashes against the trust registry.

**Steps**:
1. Discover skill directories under `$OC/skills/` (look for dirs containing `SKILL.md`)
2. For each skill, compute hash: `node scripts/trust-cli.js hash --path <skill_dir>`
3. Look up the attested hash: `node scripts/trust-cli.js lookup --source <skill_dir>`
4. If hash differs from attested → **INTEGRITY_DRIFT** (HIGH)
5. If skill has no trust record → **UNREGISTERED_SKILL** (MEDIUM)
6. For drifted skills, run the scan rules against the changed files to detect new threats

#### [2] Secrets Exposure

Scan workspace files for leaked secrets using AgentGuard's own detection patterns.

**Steps**:
1. Use Grep to scan `$OC/workspace/` (especially `memory/` and `logs/`) with patterns from:
   - scan-rules.md Rule 7 (PRIVATE_KEY_PATTERN): `0x[a-fA-F0-9]{64}` in quotes
   - scan-rules.md Rule 8 (MNEMONIC_PATTERN): BIP-39 word sequences, `seed_phrase`, `mnemonic`
   - scan-rules.md Rule 5 (READ_SSH_KEYS): SSH key file references in workspace
   - action-policies.md secret patterns: AWS keys (`AKIA...`), GitHub tokens (`gh[pousr]_...`), DB connection strings
2. Scan any `.env*` files under `$OC/` for plaintext credentials
3. Check `~/.ssh/` and `~/.gnupg/` directory permissions (should be 700)

#### [3] Network Exposure

Detect dangerous port exposure and firewall misconfigurations.

**Steps**:
1. List listening ports: `ss -tlnp` or `lsof -i -P -n | grep LISTEN`
2. Flag high-risk services on 0.0.0.0: Redis(6379), Docker API(2375), MySQL(3306), PostgreSQL(5432), MongoDB(27017)
3. Check firewall status: `ufw status` or `iptables -L INPUT -n`
4. Check outbound connections (`ss -tnp state established`) and cross-reference against action-policies.md webhook/exfil domain list and high-risk TLDs

#### [4] Cron & Scheduled Tasks

Audit all cron jobs for download-and-execute patterns.

**Steps**:
1. List OpenClaw cron jobs: `openclaw cron list`
2. List system crontab: `crontab -l` and contents of `/etc/cron.d/`
3. List systemd timers: `systemctl list-timers --all`
4. Scan all cron command bodies using scan-rules.md Rule 2 (AUTO_UPDATE) patterns: `curl|bash`, `wget|sh`, `eval "$(curl`, `base64 -d | bash`
5. Flag unknown cron jobs that touch `$OC/` directories

#### [5] File System Changes (24h)

Detect suspicious file modifications in the last 24 hours.

**Steps**:
1. Find recently modified files: `find $OC/ ~/.ssh/ ~/.gnupg/ /etc/cron.d/ -type f -mtime -1`
2. For modified files with scannable extensions (.js/.ts/.py/.sh/.md/.json), run the full scan rule set
3. Check permissions on critical files:
   - `$OC/openclaw.json` → should be 600
   - `$OC/devices/paired.json` → should be 600
   - `~/.ssh/authorized_keys` → should be 600
4. Detect new executable files in workspace: `find $OC/workspace/ -type f -perm +111 -mtime -1`

#### [6] Audit Log Analysis (24h)

Analyze AgentGuard's audit trail for attack patterns.

**Steps**:
1. Read `~/.ffwd-agent-guard/audit.jsonl`, filter to last 24h by timestamp
2. Compute statistics: total events, deny/confirm/allow counts, group denials by `risk_tags` and `initiating_skill`
3. Flag patterns:
   - Same skill denied 3+ times → potential attack (HIGH)
   - Any event with `risk_level: critical` → (CRITICAL)
   - `WEBHOOK_EXFIL` or `NET_EXFIL_UNRESTRICTED` tags → (HIGH)
   - `PROMPT_INJECTION` tag → (CRITICAL)
4. For skills with high deny rates still not revoked: recommend `/ffwd-agent-guard trust revoke`

#### [7] Environment & Configuration

Verify security configuration is production-appropriate.

**Steps**:
1. List environment variables matching sensitive names (values masked): `API_KEY`, `SECRET`, `PASSWORD`, `TOKEN`, `PRIVATE`, `CREDENTIAL`
2. Read `~/.ffwd-agent-guard/config.json` — flag `permissive` protection level in production
3. If `$OC/.config-baseline.sha256` exists, verify: `sha256sum -c $OC/.config-baseline.sha256`

#### [8] Trust Registry Health

Check for expired, stale, or over-privileged trust records.

**Steps**:
1. List all records: `node scripts/trust-cli.js list`
2. Flag:
   - Expired attestations (`expires_at` in the past)
   - Trusted skills not re-scanned in 30+ days
   - Installed skills with `untrusted` status
   - Over-privileged skills: `exec: allow` combined with `network_allowlist: ["*"]`
3. Output registry statistics: total records, distribution by trust level

### Patrol Report Format

```
## FFWD AgentGuard Patrol Report

**Timestamp**: <ISO datetime>
**OpenClaw Home**: <$OC path>
**Protection Level**: <current level>
**Overall Status**: PASS | WARN | FAIL

### Check Results

| # | Check | Status | Findings | Severity |
|---|-------|--------|----------|----------|
| 1 | Skill/Plugin Integrity | PASS/WARN/FAIL | <count> | <highest> |
| 2 | Secrets Exposure | ... | ... | ... |
| 3 | Network Exposure | ... | ... | ... |
| 4 | Cron & Scheduled Tasks | ... | ... | ... |
| 5 | File System Changes | ... | ... | ... |
| 6 | Audit Log Analysis | ... | ... | ... |
| 7 | Environment & Config | ... | ... | ... |
| 8 | Trust Registry Health | ... | ... | ... |

### Findings Detail
(only checks with findings are shown)

#### [N] Check Name
- <finding with file path, evidence, and severity>

### Recommendations
1. [SEVERITY] <actionable recommendation>

### Next Patrol
<Cron schedule if configured, or suggest: /ffwd-agent-guard patrol setup>
```

**Overall status**: Any CRITICAL → **FAIL**, any HIGH → **WARN**, else **PASS**

After outputting the report, append a summary entry to `~/.ffwd-agent-guard/audit.jsonl`:
```json
{"timestamp":"...","event":"patrol","overall_status":"PASS|WARN|FAIL","checks":8,"findings":<count>,"critical":<count>,"high":<count>}
```

### patrol setup

Configure the patrol as an OpenClaw daily cron job.

**Steps**:

1. Verify OpenClaw environment (same pre-flight as `patrol run`)
2. Ask the user for:
   - **Timezone** (default: UTC). Examples: `Asia/Shanghai`, `America/New_York`, `Europe/London`
   - **Schedule** (default: `0 3 * * *` — daily at 03:00)
   - **Notification channel** (optional): `telegram`, `discord`, `signal`
   - **Chat ID / webhook** (required if channel is set)
3. Generate the cron registration command:

```bash
openclaw cron add \
  --name "ffwd-agent-guard-patrol" \
  --description "FFWD AgentGuard daily security patrol" \
  --cron "<schedule>" \
  --tz "<timezone>" \
  --session "isolated" \
  --message "/ffwd-agent-guard patrol run" \
  --timeout-seconds 300 \
  --thinking off \
  # Only include these if notification is configured:
  --announce \
  --channel <channel> \
  --to <chat-id>
```

4. **Show the exact command to the user and wait for explicit confirmation** before executing
5. After execution, verify with `openclaw cron list`
6. Output confirmation with the cron schedule

> **Note**: `--timeout-seconds 300` is required because isolated sessions need cold-start time. The default 120s is not enough.

### patrol status

Show the current patrol state.

**Steps**:

1. Read `~/.ffwd-agent-guard/audit.jsonl`, find the most recent `event: "patrol"` entry
2. If found, display: timestamp, overall status, finding counts
3. Run `openclaw cron list` and look for `ffwd-agent-guard-patrol` job
4. If cron is configured, show: schedule, timezone, last run time, next run time
5. If cron is not configured, suggest: `/ffwd-agent-guard patrol setup`

---

# Trust & Configuration

## Subcommand: trust

Manage skill trust levels using the FFWD AgentGuard registry.

### Trust Levels

| Level | Description |
|-------|-------------|
| `untrusted` | Default. Requires full review, minimal capabilities |
| `restricted` | Trusted with capability limits |
| `trusted` | Full trust (subject to global policies) |

### Capability Model

```
network_allowlist: string[]     — Allowed domains (supports *.example.com)
filesystem_allowlist: string[]  — Allowed file paths
exec: 'allow' | 'deny'         — Command execution permission
secrets_allowlist: string[]     — Allowed env var names
```

### Presets

| Preset | Description |
|--------|-------------|
| `none` | All deny, empty allowlists |
| `read_only` | Local filesystem read-only |
| `trading_bot` | Exchange APIs (Binance, Bybit, OKX, Coinbase), config and logs paths |

### Operations

**lookup** — `ffwd-agent-guard trust lookup --source <source> --version <version>`
Query the registry for a skill's trust record.

**attest** — `ffwd-agent-guard trust attest --id <id> --source <source> --version <version> --hash <hash> --trust-level <level> --preset <preset> --reviewed-by <name>`
Create or update a trust record. Use `--preset` for common capability models or provide `--capabilities <json>` for custom.

**revoke** — `ffwd-agent-guard trust revoke --source <source> --reason <reason>`
Revoke trust for a skill. Supports `--source-pattern` for wildcards.

**list** — `ffwd-agent-guard trust list [--trust-level <level>] [--status <status>]`
List all trust records with optional filters.

### Script Execution

If the @core0-io/ffwd-agent-guard package is installed, execute trust operations via FFWD AgentGuard's own bundled script:
```
node scripts/trust-cli.js <subcommand> [args]
```

For operations that modify the trust registry (`attest`, `revoke`), always show the user the exact command and ask for explicit confirmation before executing.

If scripts are not available, help the user inspect `data/registry.json` directly using Read tool.

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
A template with all options is available at `config.default.json` in the repo root.

Full schema:

```json
{
  "level": "balanced",
  "auto_scan": false,
  "metrics": {
    "endpoint": "",
    "api_key": "",
    "timeout": 5000,
    "log": ""
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `level` | string | `"balanced"` | Protection level: `strict`, `balanced`, or `permissive` |
| `auto_scan` | boolean | `false` | Enable skill scanning on session start |
| `metrics.endpoint` | string | `""` | Backend URL to POST metrics to |
| `metrics.api_key` | string | `""` | Bearer token for metrics auth |
| `metrics.timeout` | number | `5000` | Metrics request timeout in ms |
| `metrics.log` | string | `""` | Path to local JSONL metrics log file (supports `~/`) |

Set `FFWD_AGENT_GUARD_HOME` environment variable to change the config directory (default: `~/.ffwd-agent-guard`).

### Protection Levels

| Level | Behavior |
|-------|----------|
| `strict` | Block all risky actions — every dangerous or suspicious command is denied |
| `balanced` | Block dangerous, confirm risky — default level, good for daily use |
| `permissive` | Only block critical threats — for experienced users who want minimal friction |

---

## Subcommand: reset

Reset `~/.ffwd-agent-guard/config.json` to factory defaults (overwrites with `config.default.json`).

Run:
```bash
node scripts/config-cli.js reset
```

---

# Reporting

## Subcommand: report

Display recent security events from the FFWD AgentGuard audit log.

### Log Location

The audit log is stored at `~/.ffwd-agent-guard/audit.jsonl`. Each line is a JSON object with:

```json
{"timestamp":"...","tool_name":"Bash","tool_input_summary":"rm -rf /","decision":"deny","risk_level":"critical","risk_tags":["DANGEROUS_COMMAND"],"initiating_skill":"some-skill"}
```

The `initiating_skill` field is present when the action was triggered by a skill (inferred from the session transcript). When absent, the action came from the user directly.

### How to Display

1. Read `~/.ffwd-agent-guard/audit.jsonl` using the Read tool
2. Parse each line as JSON
3. Format as a table showing recent events (last 50 by default)
4. If any events have `initiating_skill`, add a "Skill Activity" section grouping events by skill

### Output Format

```
## FFWD AgentGuard Security Report

**Events**: <total count>
**Blocked**: <deny count>
**Confirmed**: <confirm count>

### Recent Events

| Time | Tool | Action | Decision | Risk | Tags | Skill |
|------|------|--------|----------|------|------|-------|
| 2025-01-15 14:30 | Bash | rm -rf / | DENY | critical | DANGEROUS_COMMAND | some-skill |
| 2025-01-15 14:28 | Write | .env | CONFIRM | high | SENSITIVE_PATH | — |

### Skill Activity

If any events were triggered by skills, group them here:

| Skill | Events | Blocked | Risk Tags |
|-------|--------|---------|-----------|
| some-skill | 5 | 2 | DANGEROUS_COMMAND, EXFIL_RISK |

For untrusted skills with blocked actions, suggest: `/ffwd-agent-guard trust attest` to register them or `/ffwd-agent-guard trust revoke` to block them.

### Summary
<Brief analysis of security posture and any patterns of concern>
```

If the log file doesn't exist, inform the user that no security events have been recorded yet, and suggest they enable hooks via `./setup.sh` or by adding the plugin.

---

# Auto-Scan on Session Start (Opt-In)

AgentGuard can optionally scan installed skills at session startup. **This is disabled by default** and must be explicitly enabled:

- **Config file**: Set `"auto_scan": true` in `~/.ffwd-agent-guard/config.json`
- **OpenClaw**: Pass `{ skipAutoScan: false }` when registering the plugin

When enabled, auto-scan operates in **report-only mode**:

1. Discovers skill directories (containing `SKILL.md`) under `~/.claude/skills/` and `~/.openclaw/skills/`
2. Runs `quickScan()` on each skill
3. Reports results to stderr (skill name + risk level + risk tags)

Auto-scan **does NOT**:
- Modify the trust registry (no `forceAttest` calls)
- Write code snippets or evidence details to disk
- Execute any code from the scanned skills

The audit log (`~/.ffwd-agent-guard/audit.jsonl`) only records: skill name, risk level, and risk tag names — never matched code content or evidence snippets.

To register skills after reviewing scan results, use `/ffwd-agent-guard trust attest`.
