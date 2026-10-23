// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { GUARD_GATES, type GuardAuditEntry } from '../../schemas/index.js';

export function guardAuditFixture(): GuardAuditEntry {
  return {
    event: 'guard', evaluation_id: '550e8400-e29b-41d4-a716-446655440000',
    timestamp: '2026-10-22T00:00:00.000Z', duration_ms: 4,
    platform: 'claude-code', service_name: 'nio-claude-code', agent_name: 'claude-code',
    tool_name: 'Bash', tool_input_summary: 'ls /tmp', decision: 'allow',
    risk_score: 0, risk_level: 'low', risk_tags: [],
    phases: GUARD_GATES.map((gate, phase_id) => ({
      phase_id: phase_id as GuardAuditEntry['phases'][number]['phase_id'], gate,
      status: 'completed', reason: 'Executed', duration_ms: 0, score: 0,
      finding_count: 0, finding_ids: [], triggered_block: false,
    })),
    termination: { kind: 'completed', blocked_gate: null, trigger_finding_ids: [], reason: 'Allowed' },
    findings: [], explanation: 'Allowed',
    max_finding_severity: 'low', phase_stopped: null, scores: {}, top_findings: [],
  };
}
