# FFWD AgentGuard Security Policy

Unified security policy reference for all platforms (Claude Code, OpenClaw, and future integrations).

---

## 1. Overview

### Design Principles

1. **Defense in Depth**: Multiple layers of protection (static scan, runtime evaluation, trust registry)
2. **Fail-Secure**: Unknown or ambiguous actions default to denial/confirmation
3. **Least Privilege**: Skills receive minimal capabilities by default
4. **User Sovereignty**: Users always retain final approval authority

### Three-Module Architecture

| Module | Purpose | When Invoked |
|--------|---------|--------------|
| **Static Scanner** | Detect malicious patterns in code/prompts | Before execution (`/ffwd-agent-guard scan`) |
| **Action Evaluator** | Runtime policy decisions on agent actions | On tool calls (hooks) |
| **Trust Registry** | Skill identity and capability attestation | Skill invocation & lookup |

---

## 2. Protection Levels

Configure via `/ffwd-agent-guard config <level>`:

| Level | Description | DENY Behavior | CONFIRM Behavior |
|-------|-------------|---------------|------------------|
| **strict** | Maximum security. All risk operations blocked. | Block | Block (treated as deny) |
| **balanced** (default) | Critical threats blocked, high-risk prompts user. | Block | Prompt user |
| **permissive** | Only critical threats blocked, others prompt. | Block if critical; else prompt | Prompt if high/critical |

### Decision Matrix

| Risk Level | strict | balanced | permissive |
|------------|--------|----------|------------|
| critical + DENY | Block | Block | Block |
| critical + CONFIRM | Block | Prompt | Prompt |
| high + DENY | Block | Block | Prompt |
| high + CONFIRM | Block | Prompt | Prompt |
| medium + DENY | Block | Block | Prompt |
| medium + CONFIRM | Block | Prompt | Allow |
| low | Allow | Allow | Allow |

---

## 3. Decision Framework

### Decision Types

| Decision | Meaning | Typical Outcome |
|----------|---------|-----------------|
| **ALLOW** | Safe to proceed | Action executes |
| **DENY** | Must not proceed | Action blocked (error to agent) |
| **CONFIRM** | Requires user approval | Prompt user for confirmation |

### Risk Levels

| Level | Priority Range | Description |
|-------|----------------|-------------|
| **critical** | 90-100 | Immediate block — private keys, destructive commands |
| **high** | 70-89 | Strong risk — API secrets, untrusted network exfil |
| **medium** | 50-69 | Moderate risk — system commands, network activity |
| **low** | 0-49 | Minimal risk — safe/read-only operations |

---

## 4. Runtime Action Rules (ActionScanner)

### 4.1 Command Execution (`exec_command`)

#### Safe Commands (Always ALLOW)

Commands matching the safe list are allowed without restriction, **unless** they contain shell metacharacters or access sensitive paths.

| Category | Commands |
|----------|----------|
| **Read-only** | `ls`, `echo`, `pwd`, `whoami`, `date`, `hostname`, `uname`, `tree`, `du`, `df`, `sort`, `uniq`, `diff`, `cd` |
| **File inspection** | `cat`, `head`, `tail`, `wc`, `grep`, `find`, `which`, `type` |
| **File operations** | `mkdir`, `cp`, `mv`, `touch` |
| **Git** | `git status`, `git log`, `git diff`, `git branch`, `git show`, `git remote`, `git clone`, `git checkout`, `git pull`, `git fetch`, `git merge`, `git add`, `git commit`, `git push` |
| **Package managers** | `npm install`, `npm run`, `npm test`, `npm ci`, `npm start`, `npx`, `yarn`, `pnpm`, `pip install`, `pip3 install` |
| **Version checks** | `node -v`, `npm -v`, `python --version`, `tsc --version`, `go version`, `rustc --version`, `java -version` |
| **Build & run** | `tsc`, `go build`, `go run`, `cargo build`, `cargo run`, `cargo test`, `make` |

**Shell metacharacters that disqualify safe commands**: `;`, `|`, `&`, `` ` ``, `$`, `(`, `)`, `{`, `}`

#### Dangerous Commands (Always DENY — Critical)

| Pattern | Description |
|---------|-------------|
| `rm -rf` / `rm -fr` | Recursive delete |
| `mkfs` | Format filesystem |
| `dd if=` | Raw disk write |
| `:(){:\|:&};:` | Fork bomb (with space variants) |
| `chmod 777` / `chmod -R 777` | World-writable permissions |
| `> /dev/sda` | Disk overwrite |
| `mv /* ` | Move root contents |
| `curl\|sh` / `wget\|bash` | Download and execute |

#### Sensitive Data Access (High Risk — CONFIRM)

| Pattern | Target |
|---------|--------|
| `cat /etc/passwd` | User database |
| `cat /etc/shadow` | Password hashes |
| `cat ~/.ssh` | SSH keys |
| `cat ~/.aws` | AWS credentials |
| `cat ~/.kube` | Kubernetes config |
| `cat ~/.npmrc` | npm auth tokens |
| `cat ~/.netrc` | Network credentials |
| `printenv` / `env` / `set` | All environment variables |

#### System Commands (Medium Risk — Audit)

`sudo`, `su`, `chown`, `chmod`, `chgrp`, `useradd`, `userdel`, `groupadd`, `passwd`, `visudo`, `systemctl`, `service`, `init`, `shutdown`, `reboot`, `halt`

#### Network Commands (Medium Risk — Audit)

`curl`, `wget`, `nc`/`netcat`/`ncat`, `ssh`, `scp`, `rsync`, `ftp`, `sftp`

#### Shell Injection Patterns (Medium Risk)

| Pattern | Description |
|---------|-------------|
| `; command` | Command separator |
| `\| command` | Pipe |
| `` `command` `` | Backtick execution |
| `$(command)` | Command substitution |
| `&& command` | Conditional chain |
| `\|\| command` | Or chain |

---

### 4.2 Network Requests (`network_request`)

#### Webhook / Exfiltration Domains (DENY unless allowlisted)

| Domain | Service |
|--------|---------|
| `discord.com` / `discordapp.com` | Discord webhooks |
| `api.telegram.org` | Telegram bot API |
| `hooks.slack.com` | Slack webhooks |
| `webhook.site` | Webhook testing |
| `requestbin.com` | Request inspection |
| `pipedream.com` | Workflow automation |
| `ngrok.io` / `ngrok-free.app` | Tunneling |
| `beeceptor.com` | API mocking |
| `mockbin.org` | HTTP mocking |

#### High-Risk TLDs (Medium → High with POST/PUT)

`.xyz`, `.top`, `.tk`, `.ml`, `.ga`, `.cf`, `.gq`, `.work`, `.click`, `.link`

#### Request Body Secret Scanning

| Secret Type | Priority | Risk Level | Decision |
|-------------|----------|------------|----------|
| Private Key (`0x` + 64 hex) | 100 | critical | DENY |
| SSH Private Key (`-----BEGIN.*PRIVATE KEY`) | 90 | critical | DENY |
| AWS Secret Key (40-char near AWS context) | 80 | high | CONFIRM |
| AWS Access Key (`AKIA[0-9A-Z]{16}`) | 70 | high | CONFIRM |
| GitHub Token (`gh[pousr]_...`) | 70 | high | CONFIRM |
| Bearer/JWT Token (`ey...`) | 60 | medium | CONFIRM |
| API Secret (generic patterns) | 50 | medium | CONFIRM |
| DB Connection String | 50 | medium | CONFIRM |
| Password in Config | 40 | low | CONFIRM |

#### Network Decision Logic

1. Invalid URL → **DENY** (high)
2. Domain in webhook list & not allowlisted → **DENY** (high)
3. Body contains private key / SSH key → **DENY** (critical)
4. Body contains other secrets → risk based on priority
5. High-risk TLD & not allowlisted → **CONFIRM** (medium)
6. POST/PUT to untrusted domain → escalate medium → high
7. Domain in allowlist → **ALLOW** (low)

---

### 4.3 File Operations (`read_file` / `write_file`)

#### Sensitive Paths (DENY or CONFIRM based on level)

| Path Pattern | Description |
|--------------|-------------|
| `.env`, `.env.local`, `.env.production` | Environment secrets |
| `.ssh/`, `id_rsa`, `id_ed25519` | SSH keys |
| `.aws/credentials`, `.aws/config` | AWS credentials |
| `.npmrc`, `.netrc` | Package/network auth |
| `credentials.json`, `serviceAccountKey.json` | Service accounts |
| `.kube/config` | Kubernetes config |

---

### 4.4 Secret Leak Detection Priority

| Secret Type | Priority | Risk Level |
|-------------|----------|------------|
| `PRIVATE_KEY` | 100 | critical |
| `SSH_KEY` | 90 | critical |
| `AWS_SECRET` | 80 | high |
| `AWS_KEY` | 70 | high |
| `GITHUB_TOKEN` | 70 | high |
| `BEARER_TOKEN` | 60 | medium |
| `API_SECRET` | 50 | medium |
| `DB_CONNECTION` | 50 | medium |
| `PASSWORD_CONFIG` | 40 | low |

---

## 5. Static Scan Rules (15 Rules)

### Critical Severity

| Rule | ID | Target Files |
|------|-----|--------------|
| Auto-Update / Remote Code Execution | `AUTO_UPDATE` | `.js`, `.ts`, `.py`, `.sh`, `.md` |
| Remote Code Loader | `REMOTE_LOADER` | `.js`, `.ts`, `.mjs`, `.py`, `.md` |
| Read SSH Keys | `READ_SSH_KEYS` | All |
| Read Keychain/Browser Credentials | `READ_KEYCHAIN` | All |
| Private Key Pattern | `PRIVATE_KEY_PATTERN` | All |
| Prompt Injection | `PROMPT_INJECTION` | All |
| Webhook Exfiltration URL | `WEBHOOK_EXFIL` | All |
| Trojan Distribution | `TROJAN_DISTRIBUTION` | `.md` |

### High Severity

| Rule | ID | Target Files |
|------|-----|--------------|
| Shell Execution | `SHELL_EXEC` | `.js`, `.ts`, `.mjs`, `.cjs`, `.py`, `.md` |
| Obfuscation | `OBFUSCATION` | `.js`, `.ts`, `.mjs`, `.py`, `.md` |
| Unrestricted Network Exfil | `NET_EXFIL_UNRESTRICTED` | `.js`, `.ts`, `.mjs`, `.py`, `.md` |
| Suspicious Paste URL | `SUSPICIOUS_PASTE_URL` | All |

### Medium Severity

| Rule | ID | Target Files |
|------|-----|--------------|
| Read Environment Secrets | `READ_ENV_SECRETS` | `.js`, `.ts`, `.mjs`, `.py` |
| Suspicious IP Address | `SUSPICIOUS_IP` | All |
| Social Engineering | `SOCIAL_ENGINEERING` | `.md` |

---

## 6. Trust Registry & Capability Model

### Trust Levels

| Level | Priority | Description |
|-------|----------|-------------|
| `untrusted` | 0 | Unknown skill — read-only access only |
| `restricted` | 1 | Limited capabilities — per attestation |
| `trusted` | 2 | Full capabilities within attestation |

### Capability Model Structure

```typescript
interface CapabilityModel {
  network_allowlist: string[];      // Allowed domains (glob patterns)
  filesystem_allowlist: string[];   // Allowed paths (glob patterns)
  exec: 'allow' | 'deny';           // Command execution
  secrets_allowlist: string[];      // Allowed secret patterns
}
```

### Capability Presets

#### `none` — Most Restrictive
```json
{
  "network_allowlist": [],
  "filesystem_allowlist": [],
  "exec": "deny",
  "secrets_allowlist": []
}
```

#### `read_only`
```json
{
  "network_allowlist": [],
  "filesystem_allowlist": ["./**"],
  "exec": "deny",
  "secrets_allowlist": []
}
```

### Capability Enforcement

| Action Type | Capability Check |
|-------------|------------------|
| `exec_command` | `can_exec !== false` |
| `network_request` | `can_network !== false` |
| `write_file` | `can_write !== false` |
| `read_file` | `can_read !== false` |

---

## 7. Platform Integration

### 7.1 Claude Code

**Hook Events**: `PreToolUse`, `PostToolUse`

**Tool Mapping**:

| Claude Code Tool | Action Type |
|------------------|-------------|
| `Bash` | `exec_command` |
| `Write` | `write_file` |
| `Edit` | `write_file` |
| `WebFetch` | `network_request` |
| `WebSearch` | `network_request` |

**Configuration** (`~/.claude/settings.json`):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": { "tool_name": "*" },
        "hooks": ["ffwd-agent-guard-hook"]
      }
    ]
  }
}
```

### 7.2 OpenClaw

**Hook Events**: `before_tool_call`, `after_tool_call`

**Tool Mapping**:

| OpenClaw Tool | Action Type |
|---------------|-------------|
| `exec` / `exec_*` | `exec_command` |
| `write` | `write_file` |
| `read` | `read_file` |
| `web_fetch` | `network_request` |
| `browser` | `network_request` |

**Auto-Scan & Registration**:

When AgentGuard registers as an OpenClaw plugin, it automatically:

1. **Scans all loaded plugins** - Static analysis of each plugin's source code
2. **Determines trust level** - Based on scan results (critical findings → untrusted)
3. **Infers capabilities** - Based on registered tools and scan risk level
4. **Registers to trust registry** - Auto-attests each plugin
5. **Builds tool mapping** - Maps `toolName → pluginId` for initiating skill inference

**Trust Level Assignment**:

| Scan Result | Trust Level | Capabilities |
|-------------|-------------|--------------|
| critical / dangerous patterns | `untrusted` | read-only |
| high risk | `restricted` | limited per scan |
| medium risk | `restricted` | limited per scan |
| low risk | `trusted` | full per tool type |

**Configuration** (Plugin registration):

```typescript
import { registerOpenClawPlugin } from '@core0-io/ffwd-agent-guard';

// Basic registration (auto-scan enabled)
registerOpenClawPlugin(api);

// With options
registerOpenClawPlugin(api, {
  level: 'balanced',        // Protection level
  skipAutoScan: false,      // Set true to disable auto-scanning
});
```

**Exported Utilities**:

```typescript
import {
  getPluginIdFromTool,    // Get plugin ID from tool name
  getPluginScanResult,    // Get cached scan result for plugin
} from '@core0-io/ffwd-agent-guard';
```

---

## 8. Quick Reference Tables

### Always Block (Critical — DENY)

| Category | Rules |
|----------|-------|
| **Destructive commands** | `rm -rf`, `mkfs`, `dd if=`, fork bomb, `chmod 777`, `curl\|bash` |
| **Key exfiltration** | Private keys (0x+64 hex), SSH keys |
| **Webhook exfil** | Discord/Telegram/Slack webhooks (unless allowlisted) |
| **Prompt injection** | `ignore previous instructions`, jailbreak attempts |

### Require Confirmation (High — CONFIRM in balanced)

| Category | Rules |
|----------|-------|
| **Sensitive data access** | `cat /etc/passwd`, `cat ~/.ssh`, `env`, `printenv` |
| **API key leakage** | AWS/GitHub/Bearer tokens in request body |
| **Untrusted domains** | POST/PUT to non-allowlisted domains |
| **Untrusted skills** | Skills not in trust registry |

### Audit but Allow (Medium — ALLOW with logging)

| Category | Rules |
|----------|-------|
| **Install commands** | `npm install`, `pip install`, `git clone` |
| **System commands** | `sudo`, `systemctl`, `chmod` |
| **Network commands** | `curl`, `wget`, `ssh` |
| **Shell metacharacters** | Commands with pipes, semicolons, etc. |

### Safe Pass-through (Low — ALLOW)

| Category | Commands |
|----------|----------|
| **Read-only** | `ls`, `cat`, `grep`, `find`, `pwd`, `whoami` |
| **Git operations** | `git status`, `git log`, `git diff`, `git add`, `git commit`, `git push` |
| **Build commands** | `npm run`, `npm test`, `tsc`, `go build`, `cargo build` |
| **Version checks** | `node -v`, `npm -v`, `python --version` |

---

## 9. Default Policy Summary

```yaml
# Secret Exfiltration
secret_exfil:
  private_key: DENY (always)
  ssh_key: DENY (always)
  api_secret: CONFIRM

# Command Execution
exec_command:
  dangerous: DENY (always)
  safe_list: ALLOW
  default: evaluate by capability

# Network
network:
  webhook_domain: DENY (unless allowlisted)
  body_contains_secret: DENY/CONFIRM by priority
  untrusted_domain: CONFIRM

# File Operations
file:
  sensitive_path_write: DENY/CONFIRM by level
  read: ALLOW (unless sensitive)
```

---

## 10. Changelog

| Date | Version | Changes |
|------|---------|---------|
| 2025-02 | 1.0.0 | Initial unified policy document |

---

*This document consolidates security policies from `skills/ffwd-agent-guard/action-policies.md`, `skills/ffwd-agent-guard/scan-rules.md`, and implementation in `src/action/detectors/`.*
