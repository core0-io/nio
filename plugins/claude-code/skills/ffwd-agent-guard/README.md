# FFWD AgentGuard

Security and observability for AI coding agents.

## Features

- **Code Scanning** — 15 static detection rules + 7 behavioural dataflow rules covering shell injection, credential leaks, prompt injection, and more
- **Dynamic Guard** — Real-time 6-phase RuntimeAnalyser pipeline for allow/deny/confirm decisions on every tool call
- **OTEL Collector** — OpenTelemetry traces and metrics for agent activity monitoring
- **Audit Logging** — Full security event trail with reporting

## Usage

```
/ffwd-agent-guard scan <path>          — Scan code for security risks
/ffwd-agent-guard action <description> — Evaluate runtime action safety
/ffwd-agent-guard report               — View security event audit log
/ffwd-agent-guard config <level>       — Set protection level (strict/balanced/permissive)
```

## Requirements

- Node.js 18+

## Author

Maintained by [core0-io](https://github.com/core0-io).
