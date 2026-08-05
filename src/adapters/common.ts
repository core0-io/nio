// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, statSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import type { HookInput } from './types.js';
import type { RiskLevel } from '../types/scanner.js';
import { riskLevelToNumericScore } from '../types/scanner.js';
import { validateConfig } from './config-schema.js';
import type { NioConfig, CollectorConfig, CollectorLogsConfig, ResolvedMetricsConfig } from './config-schema.js';
export type { NioConfig, CollectorConfig, CollectorLogsConfig, ResolvedMetricsConfig } from './config-schema.js';
import { SENSITIVE_FILE_PATHS } from '../core/shared/detection-data.js';
import type { AuditEntry, AuditGuardEntry, AuditFindingSummary } from './audit-types.js';
import { reportDiagnostic } from './diagnostics.js';
export type { AuditEntry, AuditGuardEntry, AuditScanEntry, AuditLifecycleEntry, AuditDiagnosticEntry, AuditFindingSummary, AuditPhaseDetail, AuditPhaseMap, AuditHookEntry, HookEventName } from './audit-types.js';
export { reportDiagnostic, DiagnosticCollector, type Diagnostic } from './diagnostics.js';
import type { ActionDecision } from '../core/action-orchestrator.js';
import type { Finding } from '../core/models.js';
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
  /**
   * (trace, span) to stamp onto the exported LogRecord so the audit
   * entry joins back to the turn it belongs to. Nio never has an active
   * OTEL context (spans are built from ROOT_CONTEXT across process
   * boundaries), so without this the record's built-in trace_id /
   * span_id fields are empty. Omitted → unassociated record, same as
   * before. Never touches the local JSONL leg.
   */
  spanContext?: { traceId: string; spanId: string };
}

type EmitAuditLogFn = (
  p: LoggerProvider,
  e: AuditEntry,
  sc?: { traceId: string; spanId: string },
) => void;

/** Resolved once per process; `null` means "this environment can't reach it". */
let cachedEmitAuditLog: EmitAuditLogFn | null | undefined;

/**
 * Get `emitAuditLog` without importing the logs SDK at module load.
 *
 * A plain static import would pull `@opentelemetry/sdk-logs` — and
 * through it the OTLP exporters and `@grpc/grpc-js` — into every
 * consumer of this module, including the guard path and the scanner,
 * which have no use for it. So it stays lazy. But `writeAuditLog` is
 * synchronous and `import()` is not, which leaves two lookups:
 *
 *  1. `require(...)` — what the bundled hook scripts run. Bun rewrites
 *     the call into a direct reference to the bundled module, so this
 *     is the fast path on every platform's shipped plugin.
 *  2. `createRequire(import.meta.url)` — the unbundled `dist/` ESM
 *     build (npm library export, and the test suite), where bare
 *     `require` is not defined at all. Without this fallback the
 *     ReferenceError lands in the caller's catch and the OTEL leg of
 *     every audit entry silently does nothing — entries reach the local
 *     JSONL and never the collector.
 *
 * Both failing leaves `null` and the caller writes JSONL only, which is
 * the behaviour this function replaced.
 */
function resolveEmitAuditLog(): EmitAuditLogFn | null {
  if (cachedEmitAuditLog !== undefined) return cachedEmitAuditLog;
  cachedEmitAuditLog = null;
  try {
    // The specifier MUST stay a literal here: bun's bundler only rewrites
    // `require('<literal>')` into a reference to the bundled module. Hoist
    // it into a variable and the bundled scripts fall through to the
    // filesystem-relative fallback below, which cannot resolve next to a
    // bundle — i.e. no OTEL audit records on any shipped platform.
    cachedEmitAuditLog = (
      require('../scripts/lib/logs-collector.js') as { emitAuditLog: EmitAuditLogFn }
    ).emitAuditLog;
  } catch {
    try {
      const req = createRequire(import.meta.url);
      cachedEmitAuditLog = (
        req('../scripts/lib/logs-collector.js') as { emitAuditLog: EmitAuditLogFn }
      ).emitAuditLog;
    } catch {
      cachedEmitAuditLog = null;
    }
  }
  return cachedEmitAuditLog;
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
  const logsConfig = opts?.logsConfig;

  // OTEL Logs export (fire-and-forget)
  if (logsConfig?.enabled !== false && opts?.loggerProvider) {
    try {
      resolveEmitAuditLog()?.(opts.loggerProvider, entry, opts.spanContext);
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

export function buildGuardAuditEntry(
  input: HookInput,
  rd: ActionDecision | null,
  initiatingSkill: string | null | undefined,
  platform: string | null | undefined,
  actionType?: string,
  agentName?: string | null | undefined,
): AuditGuardEntry {
  const entry: AuditGuardEntry = {
    event: 'guard',
    timestamp: new Date().toISOString(),
    platform: platform || 'unknown',
    ...(agentName && agentName.length > 0 ? { agent_name: agentName } : {}),
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

