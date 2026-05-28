---
"@core0-io/nio": patch
---

**Promote `nio.platform` + `gen_ai.agent.name` to OTel resource attributes.**

Three telemetry-identity attributes were previously per-span (or
per-log) attributes only, making them invisible as top-level
dimensions in most OTLP backends:

```text
Before:
  service.name      = "nio"          (shared across all four platforms)
  nio.platform      = span attribute (each tool span)
  gen_ai.agent.name = on turn span + log records only
```

After this release, all three live on the OTel `Resource` that every
provider (tracer / logger / meter) constructs — so every signal nio
emits (every span, log record, metric data point) carries them
automatically at the resource level. SigNoz and similar backends
surface resource attributes as primary service selectors / filter
columns:

```text
After:
  service.name      = "nio-<platform>"     (nio-hermes / nio-openclaw / nio-claude-code / nio-codex)
  nio.platform      = "<platform>"         (raw value, no parsing)
  gen_ai.agent.name = "<configured value>" (only when user set agent_name)
```

Provider factory signatures all gain `(platform: string, agentName?: string)`:

```ts
createTracerProvider(config, platform, agentName?)
createLoggerProvider(config, platform, agentName?)
createMeterProvider(config, platform, agentName?)
```

A shared `buildNioResource(platform, agentName?)` helper in
`traces-collector.ts` is the single source of truth.

Threaded through every provider call site:
`src/scripts/guard-hook.ts`, `src/scripts/collector-hook.ts`,
`src/scripts/scanner-hook.ts`, `src/scripts/hook-cli.ts`
(runHermesCollector + pre_tool_call branch), `src/adapters/openclaw-plugin.ts`.

`agent_name` is read from config and passed only when configured;
empty/unset means "no `gen_ai.agent.name` on the resource". The
span-level fallback used by `endTurn()` still defaults to platform
for unconfigured users, so the turn-span behaviour is unchanged.

**Breaking change**: `service.name` changes from `"nio"` to
`"nio-<platform>"`. Existing SigNoz / Grafana / Datadog dashboards
filtered on `service.name="nio"` will not match new data — re-target
to `service.name=nio-*` (wildcard) or filter on
`nio.platform` instead. Historical data is unaffected.
