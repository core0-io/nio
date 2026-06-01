---
name: nio-scan
description: Nio code/skill execution-risk scanner. Use when the user wants to scan a file, repo, directory, or skill for execution risks — e.g. "scan this code for risks", "is this file/plugin dangerous", "check this repo for malicious code", "run nio scan on <path>". Focused single-purpose skill; for other Nio operations use /nio.
compatibility: Requires Node.js 18+.
metadata:
  author: core0-io
  version: "2.4.4"
user-invocable: true
command-arg-mode: raw
argument-hint: "<path>"
---

# Nio — Execution Risk Scan

Scan the target path for execution risks using all detection rules. This is the focused `scan` capability of the Nio framework.

> **Passive invocation.** If the user points at code/files/a repo/a skill and asks whether it is dangerous, or to scan/check it for execution risks, you MUST run this scan rather than eyeballing it. Do not hand-wave a verdict — apply the rules below. (If the user instead asks for their *external endpoint scores* / "Nio score" with no code target, that is the separate `nio-external-score` skill, not this one.)

## File Discovery

Use Glob to find all scannable files at the given path. Include: `*.js`, `*.ts`, `*.jsx`, `*.tsx`, `*.mjs`, `*.cjs`, `*.py`, `*.json`, `*.yaml`, `*.yml`, `*.toml`, `*.sol`, `*.sh`, `*.bash`, `*.md`

**Markdown scanning**: For `.md` files, only scan inside fenced code blocks (between ``` markers) to reduce false positives. Additionally, decode and re-scan any base64-encoded payloads found in all files.

Skip directories: `node_modules`, `dist`, `build`, `.git`, `coverage`, `__pycache__`, `.venv`, `venv`
Skip files: `*.min.js`, `*.min.css`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`

## Detection Rules

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

## Risk Level Calculation

- Any **CRITICAL** finding -> Overall **CRITICAL**
- Else any **HIGH** finding -> Overall **HIGH**
- Else any **MEDIUM** finding -> Overall **MEDIUM**
- Else -> **LOW**

## Output Format

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
