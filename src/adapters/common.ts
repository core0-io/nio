// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, statSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { guardAuditSchema, type GuardAuditEntry } from '../schemas/index.js';
import { GuardEvaluation } from '../core/guard-evaluation.js';
import type { HookInput } from './types.js';
import { validateConfig } from './config-schema.js';
import type { NioConfig, CollectorConfig, CollectorLogsConfig, ResolvedMetricsConfig } from './config-schema.js';
export type { NioConfig, CollectorConfig, CollectorLogsConfig, ResolvedMetricsConfig } from './config-schema.js';
import { matchesSensitiveFilePath } from '../core/shared/detection-data.js';
import type { AuditEntry, AuditFindingSummary } from './audit-types.js';
import { reportDiagnostic, setDiagnosticsAuditLimitMb } from './diagnostics.js';
import { rotateIfNeeded } from './audit-rotate.js';
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
// Host-input coercion
// ---------------------------------------------------------------------------

/**
 * Coerce one host-supplied value to a string, for ANY runtime value.
 *
 * ── Why this exists ──────────────────────────────────────────────────
 *
 * Every hook payload Nio sees is either `JSON.parse`d stdin (Claude Code,
 * Codex, Hermes) or a live host object (the in-process runtimes: OpenClaw,
 * Pi, opencode). Neither is schema-checked before it reaches an adapter,
 * so a field the `HookInput` type calls a `string` may at runtime be a
 * number, `null`, an array, a nested object, or anything else JSON can
 * express. An `as string` cast asserts a fact nobody checked; the moment
 * the value reaches `.startsWith` / `.slice` / `.toLowerCase` it throws.
 *
 * On the guard path a throw is not a telemetry defect, it is an
 * ENFORCEMENT defect, by one of two routes. On the fork-per-event hosts
 * (Claude Code, Codex, Hermes) nothing above `evaluateHook` catches, so
 * the process dies carrying the decision and every host reads a dead
 * hook as "took no action" — Claude Code's exit 1 is its NON-blocking
 * error code, and Hermes treats empty stdout as no-action. On the
 * in-process hosts (OpenClaw, Pi, opencode) the binding's own catch turns
 * the same throw into an explicit fail-OPEN. Either way a `deny` degrades
 * to an allowed dangerous action. See
 * `src/tests/guard-decision-survives-malformed-payload.test.ts`.
 *
 * ── Contract ──────────────────────────────────────────────────────────
 *
 * Never throws. Strings pass through byte-identically (including lone
 * surrogates and empty strings, so no caller's `|| fallback` changes
 * meaning); `null`/`undefined` become `''` so they stay falsy exactly as
 * the `as string` casts they replace did; objects and arrays are
 * serialised so their content still reaches the analysers instead of
 * arriving as `[object Object]`; everything else goes through `String()`.
 * A value `JSON.stringify` refuses — a circular live host object, or one
 * with a BigInt inside it — degrades to `''` rather than taking the guard
 * down with it. (A top-level BigInt is not an object and stringifies via
 * `String()`; depth alone never throws, V8's stringify is iterative.)
 */
export function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? '';
    } catch {
      return '';
    }
  }
  // number / boolean / symbol / bigint / function
  try {
    return String(value);
  } catch {
    return '';
  }
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


export interface WriteAuditLogOptions {
  loggerProvider?: LoggerProvider | null;
  logsConfig?: CollectorLogsConfig;
}

type EmitAuditLogFn = (provider: LoggerProvider, entry: AuditEntry) => void;

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
      resolveEmitAuditLog()?.(opts.loggerProvider, entry);
    } catch {
      // Non-critical — OTEL export failure should not block
    }
  }

  // Local JSONL backup
  if (logsConfig?.local !== false) {
    try {
      const auditPath = resolveAuditPath(logsConfig);
      ensureDir(dirname(auditPath));
      // Hand the same ceiling to the diagnostics leg, which appends to
      // this very file and cannot read the config itself. Without this
      // the two writers would rotate the shared file at different sizes
      // and the smaller one would quietly win.
      setDiagnosticsAuditLimitMb(logsConfig?.max_size_mb);
      rotateIfNeeded(auditPath, logsConfig?.max_size_mb);
      appendFileSync(auditPath, JSON.stringify(entry) + '\n');
    } catch {
      // Non-critical
    }
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
  // `asText`, not `JSON.stringify`, because this runs on the Phase 0 deny
  // path (`buildGuardAuditEntry` at hook-engine.ts) OUTSIDE any try/catch:
  // the in-process runtimes hand the adapters live host objects, and
  // `JSON.stringify` throws on a circular one. Losing the audit summary is
  // a data-quality problem; throwing here loses the deny itself.
  return asText(toolInput).slice(0, 200);
}


export { validateGuardAuditEntry, createGuardEvaluation } from '../schemas/index.js';
