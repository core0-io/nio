---
"@core0-io/nio": patch
---

**`agent_name` config field — telemetry identity alias.**

Adds an optional top-level `agent_name` field to `~/.nio/config.yaml`. When set, it overrides the platform-derived value on `gen_ai.agent.name` in **traces** and **log records**, and lands as the `agent_name` field in `~/.nio/audit.jsonl`. Use it to split telemetry by deployment / machine / user when multiple installations share a collector backend ("alice-laptop", "ci-runner-3", "prod-scoring-east").

```yaml
# ~/.nio/config.yaml
agent_name: "alice-laptop"
```

After:

```text
trace span attributes:
  nio.platform        = "claude-code"        ← underlying CLI host
  gen_ai.agent.name   = "alice-laptop"       ← operator alias

audit.jsonl line:
  { "event": "guard", "platform": "claude-code", "agent_name": "alice-laptop", ... }
```

When `agent_name` is empty / unset, behaviour is identical to before (`gen_ai.agent.name` falls back to platform; audit entries omit the `agent_name` field). `nio.platform` is never overridden — the two axes are independent so backends can slice on host AND deployment.

**Metrics intentionally not extended.** Adding `gen_ai.agent.name` as a metric label would multiply every (metric × agent) combination into a separate time series and inflate the backend's cardinality budget. Query `nio.platform` for host-level metric slicing.

Plumbing changes:
- `NioConfigSchema`: optional top-level `agent_name: string`.
- `genAiInvokeAgentAttributes(sessionId, agentName, extra?)`: signature renamed (`platform` → `agentName`); function no longer re-aliases platform.
- `endTurn(provider, state, platform, agentName, cwd, transcriptPath?)`: new `agentName` parameter inserted between platform and cwd.
- `dispatchCollectorEvent` options: new optional `agentName: string`.
- `auditEntryAttributes`: emits `gen_ai.agent.name` when entry carries `agent_name`.
- `buildGuardAuditEntry`: new trailing optional `agentName` parameter.
- Audit log entry types (`AuditGuardEntry`, `AuditScanEntry`, `AuditLifecycleEntry`, `AuditHookEntry`): optional `agent_name?: string`.
- Hook entrypoints (`guard-hook`, `collector-hook`, `scanner-hook`) read `agent_name` from config and thread it through; `lib/config-loader.ts` exports a new `loadAgentName()` lightweight helper.

11 new tests in `agent-name.test.ts` cover schema acceptance, the trace attribute helper, log attribute emission (set / empty / absent), and audit entry shape (set / unset / empty). Full suite 1079/1079 green.
