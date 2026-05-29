---
"@core0-io/nio": patch
---

**`/nio doctor` no longer probes the OTLP collector endpoint.**

The HEAD probe sent no headers and no `api_key`, so collector endpoints
gated by routing headers (e.g. `x-event-pipeline-id`) or bearer auth
returned 401 / 403 — a reachability failure that wasn't actually
unreachability. Operators commonly saw a misleading `✗ http://… HTTP 403`
row in `/nio doctor` output while the runtime exporter was working fine.

Collector config correctness is still covered by the `### Configuration`
section's Zod schema validation. Delivery failures continue to surface
at runtime as the `collector / otlp_export_failed` diagnostic, which
`/nio report` aggregates and `/nio doctor` previews in its hint chain.

Removes `dryRunCollector()` from `src/adapters/openclaw-dispatch.ts`
and the `### Collector` section from `runDoctor()`. The `config import`
doctor-gate no longer rejects an unreachable `collector.endpoint`.
