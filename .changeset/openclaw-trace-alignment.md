---
"@core0-io/nio": patch
---

OpenClaw plugin trace emission now routes through the same
`traces-collector` pure functions used by Claude Code and Hermes. Span
names and attribute keys are unified across all three platforms
(`invoke_agent UserPromptSubmit`, `execute_tool <name>`, `gen_ai.*`
semantic-convention attributes); cross-platform observability dashboards
no longer have to OR-query two parallel schemas.

Internal: OpenClaw holds per-session `CollectorState` in memory (no
on-disk state file — single process); Claude Code and Hermes continue
to bridge state across hook processes via `traces-state-store.json`.
