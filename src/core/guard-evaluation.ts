// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { GUARD_GATES, createGuardEvaluation, type GuardAuditEntry, type GuardPhase, type GuardFinding, type GuardTermination } from '../schemas/index.js';
import type { Finding } from './models.js';

export function guardError(error: unknown): NonNullable<GuardAuditEntry['error']> {
  return error instanceof Error
    ? { kind: error.name || 'Error', message: error.message || String(error) }
    : { kind: 'Error', message: String(error) };
}

export class GuardEvaluation {
  readonly identity = createGuardEvaluation();
  readonly started = performance.now();
  readonly phases: GuardPhase[] = GUARD_GATES.map((gate, phase_id) => ({
    phase_id: phase_id as GuardPhase['phase_id'], gate, status: 'skipped',
    skip_reason: 'not_applicable', reason: 'No applicable input', duration_ms: null,
    score: null, finding_count: 0, finding_ids: [], triggered_block: false,
  }));
  readonly findings: GuardFinding[] = [];
  termination: GuardTermination = { kind: 'completed', blocked_gate: null, trigger_finding_ids: [], reason: 'Guard evaluation completed' };
  private active?: { id: GuardPhase['phase_id']; started: number };

  start(id: GuardPhase['phase_id']): void {
    this.active = { id, started: performance.now() };
  }

  isActive(id: GuardPhase['phase_id']): boolean {
    return this.active?.id === id;
  }

  complete(id: GuardPhase['phase_id'], score: number | null, findings: Finding[] = [], reason = 'Analysis completed'): void {
    const phase = this.phases[id];
    const duration = this.active?.id === id ? performance.now() - this.active.started : 0;
    const structured = findings.map((finding, index) => ({
      finding_id: `${id}:${this.findings.length + index}:${finding.id}`,
      phase_id: id, rule_id: finding.rule_id, severity: finding.severity,
      category: finding.category, title: finding.title, description: finding.description,
      confidence: finding.confidence,
    }));
    this.findings.push(...structured);
    Object.assign(phase, { status: 'completed', duration_ms: duration, score, reason,
      finding_count: structured.length, finding_ids: structured.map(f => f.finding_id) });
    delete phase.skip_reason;
    this.active = undefined;
  }

  skip(id: GuardPhase['phase_id'], reason: NonNullable<GuardPhase['skip_reason']>, detail: string): void {
    Object.assign(this.phases[id], { skip_reason: reason, reason: detail });
    if (this.active?.id === id) this.active = undefined;
  }

  fail(id: GuardPhase['phase_id'], error: NonNullable<GuardAuditEntry['error']>): void {
    const wasActive = this.isActive(id);
    this.complete(id, null, [], error.message);
    Object.assign(this.phases[id], { status: 'failed', error });
    if (!wasActive) this.phases[id].duration_ms = null;
  }

  terminate(kind: GuardTermination['kind'], reason: string, id?: GuardPhase['phase_id']): void {
    const blocked = kind === 'gate_block' && id !== undefined;
    this.termination = { kind, reason, blocked_gate: blocked ? GUARD_GATES[id] : null, trigger_finding_ids: [] };
    if (blocked) this.phases[id].triggered_block = true;
    if (id !== undefined) {
      for (const phase of this.phases.slice(id + 1))
        this.skip(phase.phase_id, kind === 'unmapped_allow' ? 'not_applicable' : 'terminated_earlier', reason);
    }
  }

  engineError(error: unknown): void {
    if (this.termination.kind === 'engine_error') return;
    const detail = guardError(error);
    const id = this.active?.id;
    if (id !== undefined) this.fail(id, detail);
    const lastExecuted = [...this.phases].reverse().find(phase => phase.status !== 'skipped')?.phase_id;
    this.terminate('engine_error', detail.message, id ?? lastExecuted ?? 0);
  }

  snapshot(): Pick<GuardAuditEntry, 'phases' | 'findings' | 'termination'> {
    return { phases: this.phases, findings: this.findings, termination: this.termination };
  }
}
