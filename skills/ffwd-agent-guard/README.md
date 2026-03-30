# Core0 AgentGuard

AI Agent Security Guard — protect your AI agents from dangerous commands, data leaks, and malicious skills.

## Features

- **Code Scanning** — 16 detection rules covering shell injection, credential leaks, prompt injection, and more
- **Action Evaluation** — Real-time allow/deny/confirm decisions for runtime actions (network, exec, file, secrets)
- **Trust Registry** — Manage skill trust levels with capability-based access control
- **Security Patrol** — Automated daily security checks for OpenClaw environments
- **Agent Health Checkup** — Full security posture assessment with visual HTML report and shareable lobster mascot
- **Audit Logging** — Full security event trail with reporting

## Usage

```
/ffwd-agent-guard scan <path>          — Scan code for security risks
/ffwd-agent-guard action <description> — Evaluate runtime action safety
/ffwd-agent-guard patrol [run|setup|status] — Daily security patrol
/ffwd-agent-guard trust <subcommand>   — Manage skill trust levels
/ffwd-agent-guard report               — View security event audit log
/ffwd-agent-guard config <level>       — Set protection level (strict/balanced/permissive)
/ffwd-agent-guard checkup              — Run agent health checkup with visual HTML report
```

## Agent Health Checkup 🦞

Run a full security health check on your AI agent and get a visual report in the browser:

```
/ffwd-agent-guard checkup
```

Evaluates 5 dimensions:

| Dimension | What's checked |
|-----------|---------------|
| **Skill & Code Safety** | Scan all installed skills with 16 detection rules |
| **Credential & Secrets** | File permissions on `~/.ssh/`, `~/.gnupg/`, leaked keys and API tokens |
| **Network & System** | Dangerous open ports, suspicious cron jobs, sensitive env vars |
| **Runtime Protection** | Security hooks, audit log, whether skills have been scanned |

Scores are combined into a composite 0–100 health score with a tier:

| Score | Tier | Lobster |
|-------|------|---------|
| 90–100 | **S** | 💪 Jacked — 5 random muscular variants |
| 70–89 | **A** | 🛡️ Healthy — 5 random armored variants |
| 50–69 | **B** | ☕ Tired — 5 random sleepy variants |
| 0–49 | **F** | 🚨 Critical — 5 random sick variants |

The report opens automatically in your browser. It includes a shareable image you can post to X, Telegram, or WhatsApp — with tier-specific copy in Chinese and English.

## Requirements

- Node.js 18+

## Author

Maintained by [core0-io](https://github.com/core0-io). Upstream: [GoPlus AgentGuard](https://github.com/GoPlusSecurity/agentguard) · [GoPlus Security](https://gopluslabs.io).
