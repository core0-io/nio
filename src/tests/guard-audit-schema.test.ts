import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { default as addFormats } from 'ajv-formats';
import * as audit from '../schemas/index.js';
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { emitAuditLog } from '../scripts/lib/logs-collector.js';

const gates = ['tool_gate', 'allowlist', 'runtime', 'static', 'behavioural', 'llm', 'external'];
function record(): any {
  return {
    event: 'guard',
    schema_version: 2,
    evaluation_id: '550e8400-e29b-41d4-a716-446655440000',
    timestamp: '2026-10-22T00:00:00.000Z',
    duration_ms: 4,
    platform: 'codex',
    service_name: 'nio',
    agent_name: 'codex',
    tool_name: 'shell',
    tool_input_summary: 'summary',
    decision: 'allow',
    risk_score: 0.1,
    risk_level: 'low',
    risk_tags: [],
    phases: gates.map((gate, phase_id) => ({
      phase_id,
      gate,
      status: 'completed',
      reason: 'Executed',
      duration_ms: 0,
      score: 0,
      finding_count: 0,
      finding_ids: [],
      triggered_block: false,
    })),
    termination: { kind: 'completed', blocked_gate: null, trigger_finding_ids: [], reason: 'Allowed' },
    findings: [],
    explanation: 'Allowed',
  };
}

describe('canonical Guard audit v2', () => {
  it('accepts complete evaluations without session or trace identity', () => {
    assert.deepEqual(audit.guardAuditSchema.parse(record()), record());
  });
  const invalid: [string, (r: any) => void][] = [
    ['version', (r) => (r.schema_version = 1)],
    ['event', (r) => (r.event = 'content')],
    ['decision', (r) => (r.decision = 'ask')],
    ['UUID', (r) => (r.evaluation_id = 'invalid')],
    ['negative duration', (r) => (r.duration_ms = -1)],
    ['invalid score', (r) => (r.risk_score = 2)],
    ['missing risk', (r) => delete r.risk_score],
    ['missing phase', (r) => r.phases.pop()],
    ['duplicate phase', (r) => (r.phases[1] = r.phases[0])],
    ['wrong gate', (r) => (r.phases[0].gate = 'llm')],
    ['skipped reason', (r) => (r.phases[0].status = 'skipped')],
    ['skipped timing', (r) => Object.assign(r.phases[0], { status: 'skipped', skip_reason: 'disabled' })],
    [
      'error detail',
      (r) => Object.assign(r, { decision: 'error', termination: { ...r.termination, kind: 'engine_error' } }),
    ],
    ['deny termination', (r) => (r.decision = 'deny')],
    ['dangling reference', (r) => (r.phases[0].finding_ids = ['missing'])],
    ['finding count', (r) => (r.phases[0].finding_count = 1)],
    ['trigger without block', (r) => (r.phases[0].triggered_block = true)],
    ['failed phase detail', (r) => (r.phases[0].status = 'failed')],
    ['duplicate finding', (r) => (r.findings = [finding(), finding()])],
    [
      'wrong finding owner',
      (r) => {
        r.findings = [finding()];
        r.phases[1].finding_ids = ['f1'];
        r.phases[1].finding_count = 1;
      },
    ],
    ['dangling trigger', (r) => (r.termination.trigger_finding_ids = ['missing'])],
  ];
  for (const [name, mutate] of invalid)
    it(`rejects ${name}`, () => {
      const r = record();
      mutate(r);
      assert.equal(audit.guardAuditSchema.safeParse(r).success, false);
    });
  it('preserves findings and identifies only the actual blocking gate', () => {
    const r = record();
    r.decision = 'deny';
    r.findings = [finding()];
    Object.assign(r.phases[0], { triggered_block: true, finding_count: 1, finding_ids: ['f1'] });
    for (const p of r.phases.slice(1))
      Object.assign(p, { status: 'skipped', skip_reason: 'terminated_earlier', duration_ms: null, score: null });
    r.termination = {
      kind: 'gate_block',
      blocked_gate: 'tool_gate',
      trigger_finding_ids: ['f1'],
      reason: 'Permission denied',
    };
    assert.equal(audit.guardAuditSchema.safeParse(r).success, true);
  });
  it('constructs fresh stable evaluation identities without supplying a default decision', () => {
    const first = audit.createGuardEvaluation();
    const second = audit.createGuardEvaluation();
    assert.notEqual(first.evaluation_id, second.evaluation_id);
    assert.match(first.timestamp, /^\d{4}-/);
    assert.throws(() => audit.buildGuardAuditV2({ ...record(), decision: undefined }));
    assert.deepEqual(audit.buildGuardAuditV2(record()), record());
  });
  it('publishes a matching receiver schema that validates the serialized OTLP body', async () => {
    const artifact = JSON.parse(readFileSync('schemas/guard-audit.v2.schema.json', 'utf8'));
    assert.deepEqual(artifact, audit.guardAuditJsonSchema());
    const ajv = new Ajv({ strict: false });
    (addFormats as any)(ajv);
    const validate = ajv.compile(artifact);
    const exporter = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor(exporter)] });
    try {
      emitAuditLog(provider, audit.buildGuardAuditV2(record()));
      await provider.forceFlush();
      const body = JSON.parse(String(exporter.getFinishedLogRecords()[0].body));
      assert.deepEqual(body, record());
      assert.equal(validate(body), true);
    } finally {
      await provider.shutdown();
    }
    const invalid = record();
    invalid.decision = 'ask';
    assert.equal(validate(invalid), false);
    invalid.decision = 'allow';
    invalid.phases.pop();
    assert.equal(validate(invalid), false);
  });
});
function finding() {
  return {
    finding_id: 'f1',
    phase_id: 0,
    rule_id: 'permission',
    severity: 'high',
    category: 'permission',
    title: 'Denied',
    description: 'Tool denied',
    confidence: 1,
  };
}

it('rejects early allow records whose later gates ran', () => {
  for (const kind of ['unmapped_allow', 'allowlist_allow']) {
    const r = record();
    r.termination.kind = kind;
    assert.equal(audit.guardAuditSchema.safeParse(r).success, false);
  }
});
it('retains unavailable risk as null for engine errors', () => {
  const r = record();
  r.decision = 'error';
  r.risk_score = null;
  r.risk_level = null;
  r.termination.kind = 'engine_error';
  r.error = { kind: 'engine', message: 'Failed' };
  assert.equal(audit.guardAuditSchema.safeParse(r).success, true);
});
it('rejects premature terminated_earlier phases without early termination', () => {
  const r = record();
  Object.assign(r.phases[6], { status: 'skipped', skip_reason: 'terminated_earlier', duration_ms: null, score: null });
  assert.equal(audit.guardAuditSchema.safeParse(r).success, false);
});

it('rejects an external phase marked successful when every active endpoint failed', () => {
  const r = record();
  r.phases[6].external_results = [
    {
      name: 'analyser',
      status: 'failed',
      reason: 'Unavailable',
      duration_ms: 1,
      score: null,
      finding_ids: [],
      error: { kind: 'network', message: 'Unavailable' },
    },
  ];
  assert.equal(audit.guardAuditSchema.safeParse(r).success, false);
});
it('preserves external partial success without losing failed endpoint details', () => {
  const r = record();
  r.phases[6].external_results = [
    { name: 'one', status: 'completed', reason: 'Executed', duration_ms: 1, score: 0.1, finding_ids: [] },
    {
      name: 'two',
      status: 'failed',
      reason: 'Unavailable',
      duration_ms: 2,
      score: null,
      finding_ids: [],
      error: { kind: 'network', message: 'Unavailable' },
    },
  ];
  assert.deepEqual(audit.guardAuditSchema.parse(r).phases[6].external_results, r.phases[6].external_results);
});

function terminatedSkip(r: any, index: number) {
  Object.assign(r.phases[index], {
    status: 'skipped',
    skip_reason: 'terminated_earlier',
    duration_ms: null,
    score: null,
  });
}
it('rejects termination skips before the actual blocking gate', () => {
  const r = record();
  r.decision = 'deny';
  r.termination = { kind: 'gate_block', blocked_gate: 'runtime', trigger_finding_ids: [], reason: 'Threshold' };
  r.phases[2].triggered_block = true;
  terminatedSkip(r, 0);
  for (let i = 3; i < 7; i++) terminatedSkip(r, i);
  assert.equal(audit.guardAuditSchema.safeParse(r).success, false);
});
it('rejects termination skips before allowlist early allow', () => {
  const r = record();
  r.termination.kind = 'allowlist_allow';
  terminatedSkip(r, 0);
  for (let i = 2; i < 7; i++) terminatedSkip(r, i);
  assert.equal(audit.guardAuditSchema.safeParse(r).success, false);
});
it('rejects resumed execution after a termination skip in engine errors', () => {
  const r = record();
  r.decision = 'error';
  r.termination.kind = 'engine_error';
  r.error = { kind: 'engine', message: 'Failed' };
  terminatedSkip(r, 3);
  assert.equal(audit.guardAuditSchema.safeParse(r).success, false);
});
it('preserves analyzer failures that continue to later gates', () => {
  const r = record();
  Object.assign(r.phases[3], { status: 'failed', score: null, error: { kind: 'analyzer', message: 'Unavailable' } });
  assert.equal(audit.guardAuditSchema.safeParse(r).success, true);
});
it('accepts engine failure followed by a termination suffix', () => {
  const r = record();
  r.decision = 'error';
  r.termination.kind = 'engine_error';
  r.error = { kind: 'engine', message: 'Failed' };
  Object.assign(r.phases[3], { status: 'failed', score: null, error: r.error });
  for (let i = 4; i < 7; i++) terminatedSkip(r, i);
  assert.equal(audit.guardAuditSchema.safeParse(r).success, true);
});
