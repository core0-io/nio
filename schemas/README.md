# Collector schemas

`src/schemas/guard-audit.ts` and `src/schemas/content.ts` are the canonical manually maintained definitions for their respective signals. Types, exports and draft-07 JSON Schema artifacts derive from them. Run `pnpm schema:generate` after changes; `pnpm schema:check` and `pnpm test` detect stale artifacts. Build regenerates both artifacts; published packages include this directory.

## Guard audit

Structured Guard evaluations use `event=guard` and an `evaluation_id`.
The generated receiver artifact is `schemas/guard-audit.schema.json`, named
`GuardAudit`. Content and other audit events retain their own structures.

`createGuardEvaluation()` creates an evaluation UUID and start timestamp once at
entry; retain them for local/remote writes and retries. `validateGuardAuditEntry()` validates
an explicitly supplied final record and returns its parsed copy. It never supplies
a decision, risk score or successful termination. It throws on invalid input;
callers integrating it must report validation diagnostics without changing Guard
execution decisions. The shared writer validates structured Guard evaluations before
exporting or writing them.

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
  Termination skips form a contiguous suffix and cannot precede a known blocking
  or allowlist termination gate. Engine errors may terminate before a gate starts;
  execution cannot resume after their termination skips. Analyzer failures may
  continue to later gates when they do not terminate the evaluation.

The canonical runtime tests exercise these checks separately from artifact tests.
No JSON Schema-only receiver should claim to verify these semantic invariants.

## Valid minimal record

```json
{
  "event": "guard",
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

## Conversation content

`schemas/content.schema.json` describes `ContentRecord`, built by `src/scripts/lib/content/emit.ts` for every host. The string body is redacted then UTF-8 byte bounded; built-in OTLP `traceId` / `spanId` are supplied via the logger's explicit OTel context. Attribute copies `nio.trace_id` / `nio.span_id` must match these fields (runtime Zod validation checks equality; JSON Schema validates structure, not equality).

Required attributes: `nio.content.type` (`user_prompt`, `text`, `thinking`, `tool_input`, `tool_output`), `nio.content.index`, `nio.content.source`, and the copied trace/span IDs. Source-call/source-item IDs, thinking fidelity, tool-call ID, truncation/original bytes and redaction counts are retained when available. This schema is not a Guard record and has no decision/risk fields. See [placement, consent, ordering and host limitations](../docs/COLLECTOR-SIGNALS.md#logs-conversation-content).
