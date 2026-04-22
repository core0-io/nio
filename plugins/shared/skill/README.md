# Nio

Execution assurance and observability for autonomous AI agents.

## Features

- **Code Scanning** — 15 static detection rules + 7 behavioural dataflow rules covering shell injection, credential leaks, prompt injection, and more
- **Dynamic Guard** — Real-time Phase 0–6 pipeline for allow/deny/confirm decisions on every tool call before it executes
- **OTEL Collector** — OpenTelemetry traces and metrics for full agent activity observability
- **Audit Logging** — Complete agent execution event trail with reporting

## Usage

```
/nio scan <path>          — Scan code for execution risks
/nio action <description> — Evaluate runtime action safety
/nio report               — View agent execution audit log
/nio config <level>       — Set protection level (strict/balanced/permissive)
```

## Requirements

- Node.js 18+

## Author

Maintained by [core0-io](https://github.com/core0-io).
