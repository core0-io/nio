import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import { homedir } from 'node:os';
import type { HookInput } from './types.js';
import type { RiskLevel } from '../types/scanner.js';
import { riskLevelToNumericScore } from '../types/scanner.js';
import { validateConfig } from './config-schema.js';
import type { AgentGuardConfig, CollectorConfig, CollectorLogsConfig, ResolvedMetricsConfig } from './config-schema.js';
export type { AgentGuardConfig, CollectorConfig, CollectorLogsConfig, ResolvedMetricsConfig } from './config-schema.js';
import { SENSITIVE_FILE_PATHS } from '../core/shared/detection-data.js';
import type { AuditEntry, AuditGuardEntry, AuditFindingSummary } from './audit-types.js';
export type { AuditEntry, AuditGuardEntry, AuditScanEntry, AuditLifecycleEntry, AuditFindingSummary, AuditPhaseDetail, AuditPhaseMap } from './audit-types.js';
import type { RuntimeDecision } from '../core/analysers/runtime/index.js';
import type { Finding } from '../core/models.js';
import type { LoggerProvider } from '@opentelemetry/sdk-logs';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const FFWD_AGENT_GUARD_DIR = process.env.FFWD_AGENT_GUARD_HOME || join(homedir(), '.ffwd-agent-guard');
const CONFIG_YAML_PATH = join(FFWD_AGENT_GUARD_DIR, 'config.yaml');
const CONFIG_JSON_PATH = join(FFWD_AGENT_GUARD_DIR, 'config.json'); // legacy
const AUDIT_PATH = join(FFWD_AGENT_GUARD_DIR, 'audit.jsonl');

function ensureDir(): void {
  if (!existsSync(FFWD_AGENT_GUARD_DIR)) {
    mkdirSync(FFWD_AGENT_GUARD_DIR, { recursive: true });
  }
}

// Inline built-in defaults. Does NOT read any file, so the plugin can be
// safely bundled and loaded from any cwd.
const CONFIG_DEFAULTS: AgentGuardConfig = validateConfig({ guard: { level: 'balanced' } }, 'inline-defaults');

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

export function resetConfig(): AgentGuardConfig {
  ensureDir();
  writeFileSync(CONFIG_YAML_PATH, yamlDump(CONFIG_DEFAULTS));
  return { ...CONFIG_DEFAULTS };
}

export function loadConfig(): AgentGuardConfig {
  // Prefer user config.yaml at ~/.ffwd-agent-guard/config.yaml
  if (existsSync(CONFIG_YAML_PATH)) {
    try {
      const raw = yamlLoad(readFileSync(CONFIG_YAML_PATH, 'utf-8'));
      const validated = validateConfig(raw, CONFIG_YAML_PATH);
      return { ...CONFIG_DEFAULTS, ...validated };
    } catch {
      return { ...CONFIG_DEFAULTS };
    }
  }

  // Legacy fallback: ~/.ffwd-agent-guard/config.json
  if (existsSync(CONFIG_JSON_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(CONFIG_JSON_PATH, 'utf-8'));
      const validated = validateConfig(raw, CONFIG_JSON_PATH);
      return { ...CONFIG_DEFAULTS, ...validated };
    } catch {
      return { ...CONFIG_DEFAULTS };
    }
  }

  // No user config — use inline defaults, try to persist a starter file
  try {
    ensureDir();
    writeFileSync(CONFIG_YAML_PATH, yamlDump(CONFIG_DEFAULTS));
  } catch {
    // Best-effort: filesystem may be read-only
  }
  return { ...CONFIG_DEFAULTS };
}

export function loadMetricsConfig(): ResolvedMetricsConfig {
  const config = loadConfig();
  const c = config.collector ?? {};

  const endpoint = c.endpoint ?? '';
  const api_key = c.api_key ?? '';
  const timeout = c.timeout || 5000;
  const protocol = c.protocol ?? 'http';
  let log = c.metrics?.log ?? '';

  if (log.startsWith('~/')) {
    log = join(homedir(), log.slice(2));
  }

  return { endpoint, api_key, timeout, log, protocol, enabled: !!(endpoint || log) };
}

// ---------------------------------------------------------------------------
// Sensitive path detection
// ---------------------------------------------------------------------------

export function isSensitivePath(filePath: string): boolean {
  if (!filePath) return false;
  // Normalize backslashes and expand leading ~ so ~/.ssh matches /.ssh
  let normalized = filePath.replace(/\\/g, '/');
  if (normalized.startsWith('~/')) {
    normalized = '/HOME' + normalized.slice(1);
  }
  return SENSITIVE_FILE_PATHS.some(
    (p) => normalized.includes(`/${p}`) || normalized.endsWith(p)
  );
}

// ---------------------------------------------------------------------------
// Protection level thresholds
// ---------------------------------------------------------------------------

export function shouldDenyAtLevel(
  decision: { decision: string; risk_level?: string },
  config: { level?: string }
): boolean {
  const level = config.level || 'balanced';

  if (level === 'strict') {
    return decision.decision === 'deny' || decision.decision === 'confirm';
  }

  if (level === 'balanced') {
    return decision.decision === 'deny';
  }

  if (level === 'permissive') {
    return decision.decision === 'deny' && decision.risk_level === 'critical';
  }

  return decision.decision === 'deny';
}

export function shouldAskAtLevel(
  decision: { decision: string; risk_level?: string },
  config: { level?: string }
): boolean {
  const level = config.level || 'balanced';

  if (level === 'strict') {
    return false;
  }

  if (level === 'balanced') {
    return decision.decision === 'confirm';
  }

  if (level === 'permissive') {
    return (
      (decision.decision === 'deny' && decision.risk_level !== 'critical') ||
      (decision.decision === 'confirm' &&
        (decision.risk_level === 'high' || decision.risk_level === 'critical'))
    );
  }

  return decision.decision === 'confirm';
}

// ---------------------------------------------------------------------------
// Audit logging
// ---------------------------------------------------------------------------

const DEFAULT_MAX_AUDIT_BYTES = 10 * 1024 * 1024; // 10 MB

export interface WriteAuditLogOptions {
  loggerProvider?: LoggerProvider | null;
  logsConfig?: CollectorLogsConfig;
}

/**
 * Write an audit entry. Dual-write controlled by config:
 *  - OTEL LogRecord (if audit.otel !== false and loggerProvider is set)
 *  - Local JSONL (if audit.local !== false)
 */
export function writeAuditLog(
  entry: AuditEntry,
  opts?: WriteAuditLogOptions,
): void {
  const logsConfig = opts?.logsConfig;

  // OTEL Logs export (fire-and-forget)
  if (logsConfig?.enabled !== false && opts?.loggerProvider) {
    try {
      // Dynamic import avoided — emitAuditLog is called from hook scripts
      // that construct the LoggerProvider themselves.
      const { emitAuditLog } = require('../scripts/lib/logs-collector.js') as {
        emitAuditLog: (p: LoggerProvider, e: AuditEntry) => void;
      };
      emitAuditLog(opts.loggerProvider, entry);
    } catch {
      // Non-critical — OTEL export failure should not block
    }
  }

  // Local JSONL backup
  if (logsConfig?.local !== false) {
    try {
      ensureDir();
      rotateIfNeeded(logsConfig?.max_size_mb);
      appendFileSync(AUDIT_PATH, JSON.stringify(entry) + '\n');
    } catch {
      // Non-critical
    }
  }
}

function rotateIfNeeded(maxSizeMb?: number): void {
  const maxBytes = (maxSizeMb && maxSizeMb > 0)
    ? maxSizeMb * 1024 * 1024
    : DEFAULT_MAX_AUDIT_BYTES;
  try {
    const stats = statSync(AUDIT_PATH);
    if (stats.size >= maxBytes) {
      renameSync(AUDIT_PATH, AUDIT_PATH + '.1');
    }
  } catch {
    // File may not exist yet — that's fine
  }
}

// ---------------------------------------------------------------------------
// Audit entry builders
// ---------------------------------------------------------------------------

export function compactFindings(findings: Finding[], limit = 5): AuditFindingSummary[] {
  return findings.slice(0, limit).map(f => ({
    rule_id: f.rule_id,
    severity: f.severity,
    category: f.category,
    title: f.title,
    confidence: f.confidence,
  }));
}

export function buildGuardAuditEntry(
  input: HookInput,
  rd: RuntimeDecision | null,
  initiatingSkill: string | null | undefined,
  platform: string | null | undefined,
  actionType?: string,
): AuditGuardEntry {
  const entry: AuditGuardEntry = {
    event: 'guard',
    timestamp: new Date().toISOString(),
    platform: platform || 'unknown',
    tool_name: input.toolName,
    tool_input_summary: summariseToolInput(input),
    decision: rd?.decision || 'allow',
    risk_level: rd?.risk_level || 'low',
    max_finding_severity: rd?.max_finding_severity || 'low',
    risk_score: rd?.scores?.final ?? 0,
    risk_tags: rd ? [...new Set(rd.findings.map(f => f.rule_id))] : [],
    phase_stopped: rd?.phase_stopped ?? null,
    scores: rd?.scores ? { ...rd.scores } : {},
    top_findings: rd ? compactFindings(rd.findings) : [],
    event_type: input.eventType,
  };

  if (input.sessionId) entry.session_id = input.sessionId;
  if (input.cwd) entry.cwd = input.cwd;
  if (actionType) entry.action_type = actionType;
  if (rd?.explanation) entry.explanation = rd.explanation;
  if (initiatingSkill) entry.initiating_skill = initiatingSkill;
  if (rd?.phase_timings) {
    entry.phases = rd.phase_timings;
  }

  return entry;
}

// ---------------------------------------------------------------------------
// Legacy writeAuditLog wrapper (for call sites not yet migrated)
// ---------------------------------------------------------------------------

export function writeAuditLogLegacy(
  input: HookInput,
  decision: { decision?: string; risk_level?: string; risk_tags?: string[] } | null,
  initiatingSkill?: string | null,
  platform?: string | null
): void {
  const rl = decision?.risk_level || 'low';
  const entry: AuditGuardEntry = {
    event: 'guard',
    timestamp: new Date().toISOString(),
    platform: platform || 'unknown',
    tool_name: input.toolName,
    tool_input_summary: summariseToolInput(input),
    decision: decision?.decision || 'allow',
    risk_level: rl,
    max_finding_severity: 'low',
    risk_score: riskLevelToNumericScore(rl as RiskLevel),
    risk_tags: decision?.risk_tags || [],
    phase_stopped: null,
    scores: {},
    top_findings: [],
    event_type: input.eventType,
  };
  if (initiatingSkill) entry.initiating_skill = initiatingSkill;
  if (input.sessionId) entry.session_id = input.sessionId;
  if (input.cwd) entry.cwd = input.cwd;

  writeAuditLog(entry);
}

function summariseToolInput(input: HookInput): string {
  const toolInput = input.toolInput;
  if (typeof toolInput === 'object' && toolInput !== null) {
    const cmd = (toolInput as Record<string, unknown>).command;
    if (typeof cmd === 'string') return cmd.slice(0, 200);
    const fp = (toolInput as Record<string, unknown>).file_path ||
               (toolInput as Record<string, unknown>).path;
    if (typeof fp === 'string') return fp;
    const url = (toolInput as Record<string, unknown>).url ||
                (toolInput as Record<string, unknown>).query;
    if (typeof url === 'string') return url;
  }
  return JSON.stringify(toolInput).slice(0, 200);
}

