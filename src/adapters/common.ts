// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, statSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import { homedir } from 'node:os';
import { guardAuditSchema, type GuardAuditEntry } from '../schemas/index.js';
import { GuardEvaluation } from '../core/guard-evaluation.js';
import type { HookInput } from './types.js';
import { validateConfig } from './config-schema.js';
import type { NioConfig, CollectorConfig, CollectorLogsConfig, ResolvedMetricsConfig } from './config-schema.js';
export type { NioConfig, CollectorConfig, CollectorLogsConfig, ResolvedMetricsConfig } from './config-schema.js';
import { matchesSensitiveFilePath } from '../core/shared/detection-data.js';
import type { AuditEntry, AuditFindingSummary } from './audit-types.js';
import { reportDiagnostic } from './diagnostics.js';
export type { AuditEntry, AuditGuardEntry, AuditScanEntry, AuditLifecycleEntry, AuditDiagnosticEntry, AuditFindingSummary, AuditPhaseDetail, AuditPhaseMap, AuditHookEntry, HookEventName } from './audit-types.js';
export { reportDiagnostic, DiagnosticCollector, type Diagnostic } from './diagnostics.js';
import type { ActionDecision } from '../core/action-orchestrator.js';
import type { Finding } from '../core/models.js';
import { emitAuditLog } from '../scripts/lib/logs-collector.js';
import type { LoggerProvider } from '@opentelemetry/sdk-logs';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// Resolved lazily so tests can set NIO_HOME after this module is imported.
function nioDir(): string { return process.env.NIO_HOME || join(homedir(), '.nio'); }
function configYamlPath(): string { return join(nioDir(), 'config.yaml'); }
function defaultAuditPath(): string { return join(nioDir(), 'audit.jsonl'); }

function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

/**
 * Resolve the audit JSONL path. Honors `collector.logs.path` (with `~/`
 * expansion); falls back to `${NIO_HOME ?? ~/.nio}/audit.jsonl` when no
 * config is provided.
 */
export function resolveAuditPath(logsConfig?: CollectorLogsConfig): string {
  const raw = logsConfig?.path;
  return raw ? expandHome(raw) : defaultAuditPath();
}

function ensureDir(dir: string = nioDir()): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// Inline built-in defaults. Does NOT read any file, so the plugin can be
// safely bundled and loaded from any cwd.
const CONFIG_DEFAULTS: NioConfig = validateConfig({ guard: { level: 'balanced' } }, 'inline-defaults');

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

export function resetConfig(): NioConfig {
  ensureDir();
  writeFileSync(configYamlPath(), yamlDump(CONFIG_DEFAULTS));
  return { ...CONFIG_DEFAULTS };
}

function reportConfigError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);

  // Classify YAML parse errors vs Zod schema errors. validateConfig throws
  // `Invalid config (<source>):\n<issues>`; YAML parse errors come straight
  // from js-yaml with a different prefix.
  const kind = /^Invalid config/.test(message) ? 'schema_invalid' : 'yaml_parse_failed';

  reportDiagnostic({
    severity: 'error',
    source: 'config',
    kind,
    message: `Failed to load ${configYamlPath()}, falling back to defaults`,
    detail: message,
    config_path: configYamlPath(),
    hint: 'See plugins/shared/config.default.yaml for the expected shape, or run /nio doctor.',
  });
}

export function loadConfig(): NioConfig {
  if (existsSync(configYamlPath())) {
    try {
      const raw = yamlLoad(readFileSync(configYamlPath(), 'utf-8'));
      const validated = validateConfig(raw, configYamlPath());
      return { ...CONFIG_DEFAULTS, ...validated };
    } catch (err) {
      reportConfigError(err);
      return { ...CONFIG_DEFAULTS };
    }
  }

  // No user config — use inline defaults, try to persist a starter file
  try {
    ensureDir();
    writeFileSync(configYamlPath(), yamlDump(CONFIG_DEFAULTS));
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

  return {
    endpoint,
    api_key,
    timeout,
    protocol,
    enabled: endpoint !== '',
    metrics_enabled: c.metrics?.enabled ?? true,
    traces_enabled:  c.traces?.enabled  ?? true,
    logs_enabled:    c.logs?.enabled    ?? true,
  };
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
  return matchesSensitiveFilePath(normalized);
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
 *  - OTEL LogRecord (if logsConfig.enabled !== false and loggerProvider is set)
 *  - Local JSONL (if logsConfig.local !== false), to `logsConfig.path`
 *    or the `${NIO_HOME ?? ~/.nio}/audit.jsonl` default.
 */
export function writeAuditLog(
  entry: AuditEntry,
  opts?: WriteAuditLogOptions,
): void {
  if (entry.event === 'guard') {
    const parsed = guardAuditSchema.safeParse(entry);
    if (!parsed.success) {
      reportDiagnostic({ severity: 'error', source: 'hook', kind: 'guard_audit_invalid', message: parsed.error.message });
      return;
    }
    entry = parsed.data;
  }
  const logsConfig = opts?.logsConfig;

  // OTEL Logs export (fire-and-forget)
  if (logsConfig?.enabled !== false && opts?.loggerProvider) {
    try {
      emitAuditLog(opts.loggerProvider, entry);
    } catch {
      // Non-critical — OTEL export failure should not block
    }
  }

  // Local JSONL backup
  if (logsConfig?.local !== false) {
    try {
      const auditPath = resolveAuditPath(logsConfig);
      ensureDir(dirname(auditPath));
      rotateIfNeeded(auditPath, logsConfig?.max_size_mb);
      appendFileSync(auditPath, JSON.stringify(entry) + '\n');
    } catch {
      // Non-critical
    }
  }
}

function rotateIfNeeded(auditPath: string, maxSizeMb?: number): void {
  const maxBytes = (maxSizeMb && maxSizeMb > 0)
    ? maxSizeMb * 1024 * 1024
    : DEFAULT_MAX_AUDIT_BYTES;
  try {
    const stats = statSync(auditPath);
    if (stats.size >= maxBytes) {
      renameSync(auditPath, auditPath + '.1');
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

function buildGuardCompatibilityFields(
  input: HookInput, rd: ActionDecision | null, initiatingSkill: string | null | undefined,
): Pick<GuardAuditEntry,
  'max_finding_severity' | 'phase_stopped' | 'scores' | 'top_findings' |
  'event_type' | 'initiating_skill' | 'cwd' | 'session_id'
> {
  return {
    max_finding_severity: rd?.max_finding_severity || 'low',
    phase_stopped: rd?.phase_stopped ?? null,
    scores: rd?.scores ? { ...rd.scores } : {},
    top_findings: rd ? compactFindings(rd.findings) : [],
    event_type: input.eventType,
    ...(input.sessionId ? { session_id: input.sessionId } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(initiatingSkill ? { initiating_skill: initiatingSkill } : {}),
  };
}

export function buildEvaluatedGuardAuditEntry(
  input: HookInput, rd: ActionDecision | null, initiatingSkill: string | null | undefined,
  platform: string, audit: GuardEvaluation, actionType?: string, agentName?: string,
  overrides: Partial<GuardAuditEntry> = {},
): GuardAuditEntry {
  const compatibility = buildGuardCompatibilityFields(input, rd, initiatingSkill);
  return {
    ...compatibility, ...audit.identity,
    event: 'guard', platform, tool_name: input.toolName,
    tool_input_summary: summariseToolInput(input),
    risk_tags: rd ? [...new Set(rd.findings.map(f => f.rule_id))] : [],
    ...(actionType ? { action_type: actionType } : {}),
    duration_ms: performance.now() - audit.started,
    service_name: `nio-${platform}`, agent_name: agentName || platform,
    decision: rd?.decision || 'allow', risk_level: rd?.risk_level ?? null,
    risk_score: rd ? rd.scores.final ?? 0 : null,
    phase_stopped: rd?.phase_stopped ?? null,
    explanation: rd?.explanation || audit.termination.reason,
    ...audit.snapshot(), ...overrides,
  };
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


export { validateGuardAuditEntry, createGuardEvaluation } from '../schemas/index.js';
