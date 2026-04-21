// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Audit log types — shared schema for guard, scan, and lifecycle events.
 *
 * All audit entries are discriminated by the `event` field:
 *   - "guard"        — dynamic guard evaluation (Phase 0–6)
 *   - "session_scan" — on-demand or session-start skill scan
 *   - "lifecycle"    — subagent/agent lifecycle events
 *
 * Entries are dual-written: OTEL LogRecord (primary) + local JSONL (backup),
 * both controlled by the `audit` config section.
 */

// ── Finding summary (compact, max 5 per entry) ─────────────────────────

export interface AuditFindingSummary {
  rule_id: string;
  severity: string;
  category: string;
  title: string;
  confidence: number;
}

// ── Per-phase detail ────────────────────────────────────────────────────

export interface AuditPhaseDetail {
  score: number;
  finding_count: number;
  duration_ms: number;
}

export type AuditPhaseMap = Partial<
  Record<'tool_gate' | 'allowlist' | 'runtime' | 'static' | 'behavioural' | 'llm' | 'external', AuditPhaseDetail>
>;

// ── Guard entry ─────────────────────────────────────────────────────────

export interface AuditGuardEntry {
  event: 'guard';
  timestamp: string;
  platform: string;
  session_id?: string;
  cwd?: string;

  tool_name: string;
  action_type?: string;
  tool_input_summary: string;

  decision: string;
  risk_level: string;
  max_finding_severity: string;
  risk_score: number;
  risk_tags: string[];

  phase_stopped: number | null;
  scores: Record<string, number | undefined>;
  phases?: AuditPhaseMap;
  top_findings: AuditFindingSummary[];
  explanation?: string;

  initiating_skill?: string;
  event_type?: 'pre' | 'post';
}

// ── Scan entry ──────────────────────────────────────────────────────────

export interface AuditScanEntry {
  event: 'session_scan';
  timestamp: string;
  platform: string;
  session_id?: string;
  skill_name: string;
  risk_level: string;
  risk_tags: string[];
  finding_count?: number;
}

// ── Lifecycle entry ─────────────────────────────────────────────────────

export interface AuditLifecycleEntry {
  event: 'lifecycle';
  timestamp: string;
  platform: string;
  session_id?: string;
  lifecycle_type: 'subagent_spawning' | 'subagent_ended' | 'agent_end';
  details?: Record<string, unknown>;
}

// ── Config error entry ──────────────────────────────────────────────────

export interface AuditConfigErrorEntry {
  event: 'config_error';
  timestamp: string;
  config_path: string;
  error_message: string;
}

// ── Union ───────────────────────────────────────────────────────────────

export type AuditEntry =
  | AuditGuardEntry
  | AuditScanEntry
  | AuditLifecycleEntry
  | AuditConfigErrorEntry;
