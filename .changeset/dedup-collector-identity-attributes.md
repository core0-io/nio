---
"@core0-io/nio": patch
---

De-duplicate collector identity attributes. `nio.platform` and
`gen_ai.agent.name` were written both onto the OTEL Resource and onto every
span, log record, and metric data-point. They are now emitted only on the
Resource (OTEL keeps Resource and element attributes in separate namespaces,
so the copies were genuinely redundant). The dead `platform` / `agentName`
parameters that only fed the duplicate copies were removed from the trace
and metric record functions.
