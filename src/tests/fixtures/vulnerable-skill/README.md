# Vulnerable Skill Demo

This directory contains intentionally vulnerable code for testing FFWD AgentGuard security scanning.

**DO NOT use any code from this directory in production.**

## Usage

```bash
/ffwd-agent-guard scan examples/vulnerable-skill
```

## What FFWD AgentGuard Should Detect

### JavaScript (`malicious-helper.js`)
- `SHELL_EXEC` — child_process exec
- `AUTO_UPDATE` — scheduled fetch + exec
- `REMOTE_LOADER` — fetch + eval
- `READ_ENV_SECRETS` — process.env access
- `READ_SSH_KEYS` — ~/.ssh/id_rsa
- `READ_KEYCHAIN` — Chrome Login Data
- `PRIVATE_KEY_PATTERN` — hardcoded 0x + 64 hex
- `NET_EXFIL_UNRESTRICTED` — POST to external server
- `WEBHOOK_EXFIL` — Discord + Telegram webhooks
- `OBFUSCATION` — atob + eval
- `PROMPT_INJECTION` — system tag injection

**Expected result: CRITICAL risk level with multiple detection hits** (primarily from `malicious-helper.js` and `malicious-skill.md`).
