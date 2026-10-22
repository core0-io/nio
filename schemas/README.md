# Guard audit protocol

`src/schemas/guard-audit.ts` is the only manually maintained structure definition.
Types, public exports and the draft-07 JSON Schema derive from it. Run
`pnpm schema:generate` after changes; `pnpm schema:check` and `pnpm test` detect stale
artifacts. The build regenerates the artifact. Published packages include this directory.

Select this protocol using `event=guard` and `schema_version=2`. Incompatible changes
require a new version and artifact. Additive optional fields require regenerated
artifacts, documentation and tests. Content and other audit events retain their own
protocols. Existing production v1 constructors remain supported during migration;
this foundation does not validate or convert their output into v2.

`createGuardEvaluation()` creates an evaluation UUID and start timestamp once at
entry; retain them for local/remote writes and retries. `buildGuardAuditV2()` validates
an explicitly supplied final record and returns its parsed copy. It never supplies
a decision, risk score or successful termination. It throws on invalid input;
callers integrating it must report validation diagnostics without changing Guard
execution decisions. This task does not install validation in production writers.

Required identity is actual platform, service_name and agent_name. session_id and
trace/span identity are not required. tool_input_summary uses the existing summary
policy; no raw tool inputs or credentials are added. timestamp is evaluation start
and duration_ms is elapsed time. Unknown scores/risks are null, not invented zeroes.
All seven gates appear in order: tool_gate, allowlist, runtime, static, behavioural,
llm, external. A completed gate may block; status alone does not imply allow.
Skipped gates require a skip reason and null duration/score. Failed gates preserve
actual errors and any available duration, with a null score. External results keep
each endpoint outcome, including failures and skipped endpoints.

Findings are untruncated and have unique IDs, their producing phase and actual rule
metadata. Each phase lists its own findings; finding_count equals that list's size.
Only actual triggering findings belong in termination.trigger_finding_ids; threshold
blocks may use an empty list and explain the threshold in reason. gate_block identifies
one actual gate; aggregate_block identifies no gate. confirm uses completed;
engine_error uses decision=error with actual error details. Legacy top_findings,
scores, phase_stopped, max_finding_severity and local context fields remain optional.

## Structural versus semantic validation

The JSON Schema validates field types, enums, bounds, required fields, seven-element
phase length, UUID/date-time formats (when the receiver enables format validation),
and rejects unknown fields. It cannot express Zod's cross-field `superRefine` rules.
Receivers needing full semantic verification must apply the canonical runtime schema
or equivalent semantic checks in addition to the artifact:

- canonical phase ID/gate order, unique findings and references, ownership and counts;
- skip reasons/nulls, failed errors/null scores, external gate ownership;
- decision/termination/error agreement, one actual blocking gate and trigger ownership;
- early-allow and gate-block suffix skips, and no unexplained terminated_earlier status.

The canonical runtime tests exercise these checks separately from artifact tests.
No JSON Schema-only receiver should claim to verify these semantic invariants.

## Valid minimal record

```json
{
  "event": "guard", "schema_version": 2,
  "evaluation_id": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2026-10-22T00:00:00.000Z", "duration_ms": 1,
  "platform": "codex", "service_name": "nio", "agent_name": "codex",
  "tool_name": "unmapped", "tool_input_summary": "summary",
  "decision": "allow", "risk_score": null, "risk_level": null, "risk_tags": [],
  "phases": [
    {"phase_id":0,"gate":"tool_gate","status":"completed","reason":"Unmapped tool","duration_ms":1,"score":null,"finding_count":0,"finding_ids":[],"triggered_block":false},
    {"phase_id":1,"gate":"allowlist","status":"skipped","skip_reason":"not_applicable","reason":"Unmapped tool","duration_ms":null,"score":null,"finding_count":0,"finding_ids":[],"triggered_block":false},
    {"phase_id":2,"gate":"runtime","status":"skipped","skip_reason":"not_applicable","reason":"Unmapped tool","duration_ms":null,"score":null,"finding_count":0,"finding_ids":[],"triggered_block":false},
    {"phase_id":3,"gate":"static","status":"skipped","skip_reason":"not_applicable","reason":"Unmapped tool","duration_ms":null,"score":null,"finding_count":0,"finding_ids":[],"triggered_block":false},
    {"phase_id":4,"gate":"behavioural","status":"skipped","skip_reason":"not_applicable","reason":"Unmapped tool","duration_ms":null,"score":null,"finding_count":0,"finding_ids":[],"triggered_block":false},
    {"phase_id":5,"gate":"llm","status":"skipped","skip_reason":"not_applicable","reason":"Unmapped tool","duration_ms":null,"score":null,"finding_count":0,"finding_ids":[],"triggered_block":false},
    {"phase_id":6,"gate":"external","status":"skipped","skip_reason":"not_applicable","reason":"Unmapped tool","duration_ms":null,"score":null,"finding_count":0,"finding_ids":[],"triggered_block":false}
  ],
  "termination": {"kind":"unmapped_allow","blocked_gate":null,"trigger_finding_ids":[],"reason":"Unmapped tool"},
  "findings": [], "explanation": "Unmapped tool allowed"
}
```
