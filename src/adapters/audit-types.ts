// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Audit log types — shared schema for guard, scan, lifecycle, and hook events.
 *
 * All audit entries are discriminated by the `event` field:
 *   - "guard"        — dynamic guard evaluation (Phase 0–6)
 *   - "session_scan" — on-demand or session-start skill scan
 *   - "lifecycle"    — subagent/agent lifecycle events
 *   - hook events    — collector hook records (PreToolUse, PostToolUse,
 *                      TaskCreated, TaskCompleted, Stop, SubagentStop, etc.)
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

export type AuditPhaseMap = Partial<{
  tool_gate:   AuditPhaseDetail;
  allowlist:   AuditPhaseDetail;
  runtime:     AuditPhaseDetail;
  static:      AuditPhaseDetail;
  behavioural: AuditPhaseDetail;
  llm:         AuditPhaseDetail;
  /** Phase 6: one detail per external-analyser endpoint, keyed by name. */
  external:    Record<string, AuditPhaseDetail>;
}>;

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
  scores: {
    runtime?: number;
    static?: number;
    behavioural?: number;
    llm?: number;
    /** Phase 6: per-endpoint scores keyed by external-analyser name. */
    external?: Record<string, number>;
    final?: number;
  };
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
  lifecycle_type:
    | 'subagent_spawning'
    | 'subagent_ended'
    | 'agent_end'
    | 'session_start'
    | 'session_end';
  details?: Record<string, unknown>;
}

// ── Diagnostic entry ────────────────────────────────────────────────────

/**
 * Structured failure record covering config-validation errors and runtime
 * failures (OAuth, LLM, ExternalAnalyser HTTP, Collector OTLP, scanner IO).
 * Replaces the legacy single-purpose AuditConfigErrorEntry. Writers must NOT
 * dedupe — repeated identical entries are expected, and readers (/nio report,
 * /nio doctor) aggregate them.
 */
export interface AuditDiagnosticEntry {
  event: 'diagnostic';
  timestamp: string;
  severity: 'error' | 'warning' | 'info';
  source:
    | 'config'             // schema validation / YAML parse
    | 'oauth'              // OAuthAuthStrategy
    | 'llm'                // Phase 5 LLM analyser
    | 'external_analyser'  // Phase 6 ExternalAnalyser HTTP
    | 'collector'          // OTLP export
    | 'scanner'            // file walker / file IO
    | 'hook';              // hook script itself
  /** Free-form sub-classification within source (e.g. 'token_failed'). */
  kind: string;
  message: string;
  /** Dot path into config that's responsible, if applicable. */
  config_path?: string;
  /** Component identifier — endpoint name, analyser name, server name. */
  component?: string;
  /** Stack trace excerpt, HTTP status + response body snippet, etc. */
  detail?: string;
  /** Human-readable suggestion for how to fix. */
  hint?: string;
  /** Optional session_id for grouping in /nio report. */
  session_id?: string;
}

// ── Hook event entry ────────────────────────────────────────────────────

/**
 * Collector hook records — emitted by the platform-agnostic collector core
 * when a hook event arrives (Claude Code, Hermes, OpenClaw). Replaces the
 * legacy free-form records the deleted `writeToLog` used to append to
 * `metrics.jsonl`.
 */
export type HookEventName =
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'TaskCreated'
  | 'TaskCompleted'
  | 'Stop'
  | 'SubagentStop'
  | 'SessionStart'
  | 'SessionEnd';

export interface AuditHookEntry {
  event: HookEventName;
  timestamp: string;
  platform: string;
  session_id?: string;
  cwd?: string | null;
  transcript_path?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_summary?: string;
  task_id?: string;
  task_summary?: string;
}

// ── Union ───────────────────────────────────────────────────────────────

export type AuditEntry =
  | AuditGuardEntry
  | AuditScanEntry
  | AuditLifecycleEntry
  | AuditDiagnosticEntry
  | AuditHookEntry;
