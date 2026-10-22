import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export const GUARD_AUDIT_SCHEMA_VERSION = 2;
export const GUARD_GATES = ['tool_gate', 'allowlist', 'runtime', 'static', 'behavioural', 'llm', 'external'] as const;
export const guardGateSchema = z.enum(GUARD_GATES);
const phaseId = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
]);
const text = z.string().min(1);
const score = z.number().finite().min(0).max(1).nullable();
const duration = z.number().finite().nonnegative().nullable();
const error = z.object({ kind: text, message: text }).strict();
const ids = z.array(text);
export const guardExternalResultSchema = z
  .object({
    name: text,
    status: z.enum(['completed', 'failed', 'skipped']),
    reason: text,
    duration_ms: duration,
    score,
    finding_ids: ids,
    error: error.optional(),
  })
  .strict();
export const guardPhaseSchema = z
  .object({
    phase_id: phaseId,
    gate: guardGateSchema,
    status: z.enum(['completed', 'skipped', 'failed']),
    skip_reason: z.enum(['disabled', 'not_applicable', 'terminated_earlier']).optional(),
    reason: text,
    duration_ms: duration,
    score,
    finding_count: z.number().int().nonnegative(),
    finding_ids: ids,
    triggered_block: z.boolean(),
    error: error.optional(),
    external_results: z.array(guardExternalResultSchema).optional(),
  })
  .strict();
export const guardFindingSchema = z
  .object({
    finding_id: text,
    phase_id: phaseId,
    rule_id: text,
    severity: text,
    category: text,
    title: text,
    description: z.string(),
    confidence: z.number().finite().min(0).max(1),
  })
  .strict();
export const guardTerminationSchema = z
  .object({
    kind: z.enum(['completed', 'allowlist_allow', 'unmapped_allow', 'gate_block', 'aggregate_block', 'engine_error']),
    blocked_gate: guardGateSchema.nullable(),
    trigger_finding_ids: ids,
    reason: text,
  })
  .strict();
const legacyFinding = guardFindingSchema.omit({ finding_id: true, phase_id: true, description: true });
const scores = z
  .object({
    runtime: z.number().optional(),
    static: z.number().optional(),
    behavioural: z.number().optional(),
    llm: z.number().optional(),
    external: z.record(z.number()).optional(),
    final: z.number().optional(),
  })
  .strict();
export const guardAuditSchema = z
  .object({
    event: z.literal('guard'),
    schema_version: z.literal(GUARD_AUDIT_SCHEMA_VERSION),
    evaluation_id: z.string().uuid(),
    timestamp: z.string().datetime({ offset: true }),
    duration_ms: z.number().finite().nonnegative(),
    platform: text,
    service_name: text,
    agent_name: text,
    session_id: z.string().optional(),
    tool_name: text,
    action_type: z.string().optional(),
    tool_input_summary: z.string(),
    decision: z.enum(['allow', 'deny', 'confirm', 'error']),
    risk_score: score,
    risk_level: text.nullable(),
    risk_tags: z.array(z.string()),
    phases: z.array(guardPhaseSchema).length(7),
    termination: guardTerminationSchema,
    findings: z.array(guardFindingSchema),
    explanation: text,
    error: error.optional(),
    cwd: z.string().optional(),
    max_finding_severity: z.string().optional(),
    phase_stopped: phaseId.nullable().optional(),
    scores: scores.optional(),
    top_findings: z.array(legacyFinding).optional(),
    initiating_skill: z.string().optional(),
    event_type: z.enum(['pre', 'post']).optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    const findings = new Map(entry.findings.map((f) => [f.finding_id, f]));
    if (findings.size !== entry.findings.length) issue(['findings'], 'Finding IDs must be unique');
    const reference = (values: string[], path: (string | number)[], owner?: number) => {
      if (new Set(values).size !== values.length) issue(path, 'Finding references must be unique');
      for (const id of values) {
        const finding = findings.get(id);
        if (!finding || (owner !== undefined && finding.phase_id !== owner))
          issue(path, 'Invalid finding reference or phase ownership');
      }
    };
    entry.phases.forEach((phase, index) => {
      const path = ['phases', index];
      if (phase.phase_id !== index || phase.gate !== GUARD_GATES[index])
        issue(path, 'Phases must follow canonical gate order');
      if (phase.status === 'skipped') {
        if (!phase.skip_reason || phase.duration_ms !== null || phase.score !== null)
          issue(path, 'Skipped phases require a reason and null timing/score');
        if (phase.finding_count || phase.triggered_block)
          issue(path, 'Skipped phases cannot produce findings or block');
      } else if (phase.skip_reason) issue(path, 'Only skipped phases have skip_reason');
      if ((phase.status === 'failed') !== !!phase.error) issue(path, 'Failed phases require error details exclusively');
      if (phase.status === 'failed' && phase.score !== null) issue(path, 'Failed phases cannot have a valid score');
      if (phase.finding_count !== phase.finding_ids.length) issue(path, 'Finding count must match references');
      reference(phase.finding_ids, [...path, 'finding_ids'], phase.phase_id);
      if (phase.external_results && phase.gate !== 'external')
        issue(path, 'External results belong to the external gate');
      const activeExternal = phase.external_results?.filter((result) => result.status !== 'skipped') ?? [];
      const allExternalFailed =
        activeExternal.length > 0 && activeExternal.every((result) => result.status === 'failed');
      const hasExternalSuccess = activeExternal.some((result) => result.status === 'completed');
      if (allExternalFailed && phase.status !== 'failed') issue(path, 'All active external calls failed');
      if (hasExternalSuccess && phase.status !== 'completed')
        issue(path, 'Partial external success completes the phase');
      for (const result of phase.external_results ?? []) {
        reference(result.finding_ids, [...path, 'external_results'], phase.phase_id);
        if ((result.status === 'failed') !== !!result.error)
          issue(path, 'Failed external calls require error details exclusively');
        if (result.status !== 'completed' && result.score !== null)
          issue(path, 'Unsuccessful external calls have no score');
        if (result.status === 'skipped' && result.duration_ms !== null)
          issue(path, 'Skipped external calls have no timing');
      }
    });
    for (const finding of entry.findings) {
      if (!entry.phases[finding.phase_id]?.finding_ids.includes(finding.finding_id))
        issue(['findings'], 'Each finding must be referenced by its phase');
    }
    const termination = entry.termination;
    const isGateBlock = termination.kind === 'gate_block';
    const isError = termination.kind === 'engine_error';
    const isDeny = isGateBlock || termination.kind === 'aggregate_block';
    if ((entry.decision === 'deny') !== isDeny) issue(['decision'], 'Deny requires gate_block or aggregate_block');
    if ((entry.decision === 'error') !== isError || isError !== !!entry.error)
      issue(['error'], 'Engine errors require error decision and details exclusively');
    if (entry.decision === 'confirm' && termination.kind !== 'completed')
      issue(['termination'], 'Confirmation must complete normally');
    if (['allowlist_allow', 'unmapped_allow'].includes(termination.kind) && entry.decision !== 'allow')
      issue(['decision'], 'Early allow requires allow decision');
    if (isGateBlock !== (termination.blocked_gate !== null))
      issue(['termination', 'blocked_gate'], 'Only gate_block identifies a blocking gate');
    const blocking = entry.phases.filter((p) => p.triggered_block);
    if (
      isGateBlock
        ? blocking.length !== 1 || blocking[0].gate !== termination.blocked_gate || blocking[0].status !== 'completed'
        : blocking.length !== 0
    )
      issue(['phases'], 'Only the blocking gate may trigger a block');
    reference(termination.trigger_finding_ids, ['termination', 'trigger_finding_ids']);
    if (!isDeny && termination.trigger_finding_ids.length) issue(['termination'], 'Only deny has triggering findings');
    const earlyAllowIndex =
      termination.kind === 'unmapped_allow' ? 0 : termination.kind === 'allowlist_allow' ? 1 : null;
    if (earlyAllowIndex !== null) {
      if (entry.phases[earlyAllowIndex]?.status !== 'completed')
        issue(['phases'], 'Early allow requires its gate to complete');
      const reason = termination.kind === 'unmapped_allow' ? 'not_applicable' : 'terminated_earlier';
      for (const phase of entry.phases.slice(earlyAllowIndex + 1)) {
        if (phase.status !== 'skipped' || phase.skip_reason !== reason)
          issue(['phases'], 'Later gates must be skipped after early allow');
      }
    }
    const permitsEarlyTermination = isGateBlock || isError || termination.kind === 'allowlist_allow';
    if (!permitsEarlyTermination && entry.phases.some((p) => p.skip_reason === 'terminated_earlier'))
      issue(['phases'], 'No earlier termination occurred');
    const firstTerminationSkip = entry.phases.findIndex((phase) => phase.skip_reason === 'terminated_earlier');
    if (firstTerminationSkip >= 0) {
      const knownTerminationIndex =
        isGateBlock && termination.blocked_gate !== null
          ? GUARD_GATES.indexOf(termination.blocked_gate)
          : termination.kind === 'allowlist_allow'
            ? 1
            : null;
      if (knownTerminationIndex !== null && firstTerminationSkip <= knownTerminationIndex)
        issue(['phases'], 'Termination skips must follow the terminating gate');
      for (const phase of entry.phases.slice(firstTerminationSkip))
        if (phase.status !== 'skipped' || phase.skip_reason !== 'terminated_earlier')
          issue(['phases'], 'Execution cannot resume after termination skips');
    }
    if (isGateBlock && termination.blocked_gate !== null) {
      const index = GUARD_GATES.indexOf(termination.blocked_gate);
      for (const id of termination.trigger_finding_ids)
        if (findings.get(id)?.phase_id !== index)
          issue(['termination'], 'Trigger findings must belong to blocking gate');
      for (const phase of entry.phases.slice(index + 1))
        if (phase.status !== 'skipped' || phase.skip_reason !== 'terminated_earlier')
          issue(['phases'], 'Later gates must be skipped after blocking');
    }
  });

export type GuardGate = z.infer<typeof guardGateSchema>;
export type GuardPhase = z.infer<typeof guardPhaseSchema>;
export type GuardFinding = z.infer<typeof guardFindingSchema>;
export type GuardTermination = z.infer<typeof guardTerminationSchema>;
export type GuardExternalResult = z.infer<typeof guardExternalResultSchema>;
export type GuardAuditEntry = z.infer<typeof guardAuditSchema>;

export function createGuardEvaluation(): Pick<GuardAuditEntry, 'evaluation_id' | 'timestamp'> {
  return { evaluation_id: randomUUID(), timestamp: new Date().toISOString() };
}
export function buildGuardAuditV2(entry: GuardAuditEntry): GuardAuditEntry {
  return guardAuditSchema.parse(entry);
}
export function guardAuditJsonSchema() {
  return zodToJsonSchema(guardAuditSchema, { name: 'GuardAuditV2', target: 'jsonSchema7' });
}
