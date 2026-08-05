// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Lightweight config loader for hook scripts.
 *
 * Reads ~/.nio/config.yaml (or $NIO_HOME/config.yaml)
 * without importing the main dist bundle.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { load as yamlLoad } from 'js-yaml';
import { type ContentLimits, DEFAULT_CONTENT_LIMITS } from './content/truncate.js';

export interface CollectorConfig {
  endpoint: string;
  api_key: string;
  headers: Record<string, string>;
  timeout: number;
  protocol: 'http' | 'grpc';
  /** OTLP export readiness — true iff endpoint is set. */
  enabled: boolean;
  /** Honors collector.metrics.enabled (default true). */
  metrics_enabled: boolean;
  /** Honors collector.traces.enabled (default true). */
  traces_enabled: boolean;
  /** Honors collector.logs.enabled (default true). Mirrors loadLogsConfig.enabled. */
  logs_enabled: boolean;
}

export interface LogsConfig {
  enabled: boolean;
  local: boolean;
  path: string;
  max_size_mb: number;
}

async function reportConfigError(_configDir: string, configPath: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  // YAML parse errors hit this path (full schema validation happens via the
  // separate validateConfig pipeline in src/adapters/common.ts).
  const { reportDiagnostic } = await import('../../adapters/diagnostics.js');
  reportDiagnostic({
    severity: 'error',
    source: 'config',
    kind: 'yaml_parse_failed',
    message: `Failed to load ${configPath}, falling back to defaults`,
    detail: message,
    config_path: configPath,
    hint: 'Check YAML syntax (indentation / unbalanced quotes). Run /nio doctor for details.',
  });
}

function nioDir(): string {
  // `||` not `??`: an empty NIO_HOME means "unset", matching
  // adapters/common.ts. With `??` an empty string would resolve the
  // config to `/config.yaml`, and the two modules would disagree about
  // the same environment variable.
  return process.env['NIO_HOME'] || join(homedir(), '.nio');
}

// Cache keyed by resolved config path. A hook process reads config 4+
// times (collector / logs / agent name / monitor gate); OpenClaw's
// long-lived daemon does so twice per tool call. Keying by path rather
// than caching globally keeps tests that switch NIO_HOME honest.
//
// The cache lives for the process lifetime. Per-event platforms (Claude
// Code, Codex, Hermes) spawn a fresh process per hook, so this is
// invisible to them. OpenClaw's daemon is long-lived, so editing
// config.yaml there requires a daemon restart to take effect — but that
// already matches how the OpenClaw provider reads config once at
// registration, so this doesn't introduce a new inconsistency.
const rawConfigCache = new Map<string, Record<string, unknown>>();

function readRawConfig(): Record<string, unknown> {
  const configDir = nioDir();
  const configPath = join(configDir, 'config.yaml');

  const cached = rawConfigCache.get(configPath);
  if (cached) return cached;

  if (!existsSync(configPath)) {
    rawConfigCache.set(configPath, {});
    return {};
  }

  try {
    const parsed = (yamlLoad(readFileSync(configPath, 'utf-8')) ?? {}) as Record<string, unknown>;
    rawConfigCache.set(configPath, parsed);
    return parsed;
  } catch (err) {
    reportConfigError(configDir, configPath, err);
    rawConfigCache.set(configPath, {});
    return {};
  }
}

function expandHome(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

export function collectorRequestHeaders(config: CollectorConfig): Record<string, string> {
  const headers: Record<string, string> = { ...config.headers };
  if (config.api_key) {
    headers['Authorization'] = `Bearer ${config.api_key}`;
  }
  return headers;
}

export function loadCollectorConfig(): CollectorConfig {
  const raw = readRawConfig();

  const c = (raw['collector'] ?? {}) as Record<string, unknown>;
  const endpoint = (c['endpoint'] as string) ?? '';
  const rawHeaders = c['headers'];
  const headers: Record<string, string> = {};

  if (rawHeaders !== undefined) {
    if (rawHeaders === null || typeof rawHeaders !== 'object' || Array.isArray(rawHeaders)) {
      throw new Error('collector.headers is invalid');
    }
    for (const [key, value] of Object.entries(rawHeaders)) {
      headers[key] = String(value);
    }
  }

  const metrics = (c['metrics'] ?? {}) as Record<string, unknown>;
  const traces  = (c['traces']  ?? {}) as Record<string, unknown>;
  const logs    = (c['logs']    ?? {}) as Record<string, unknown>;

  return {
    endpoint,
    api_key: (c['api_key'] as string) ?? '',
    headers,
    timeout: (c['timeout'] as number) || 5000,
    protocol: (c['protocol'] as 'http' | 'grpc') ?? 'http',
    // Reflects only OTLP export readiness. Local audit logging is
    // controlled separately via loadLogsConfig() / logsConfig.local.
    enabled: endpoint !== '',
    metrics_enabled: (metrics['enabled'] as boolean) ?? true,
    traces_enabled:  (traces['enabled']  as boolean) ?? true,
    logs_enabled:    (logs['enabled']    as boolean) ?? true,
  };
}

/**
 * Read the optional top-level `agent_name` field from ~/.nio/config.yaml.
 * Returns empty string when unset / empty / wrong-type so callers can
 * cheaply do `agentName || platform` to fall back. Hook scripts use this
 * lightweight loader to avoid importing the full validateConfig graph.
 */
export function loadAgentName(): string {
  const raw = readRawConfig();
  const value = raw['agent_name'];
  return (typeof value === 'string' && value.length > 0) ? value : '';
}

export function loadLogsConfig(): LogsConfig {
  const raw = readRawConfig();

  const collector = (raw['collector'] ?? {}) as Record<string, unknown>;
  const logs = (collector['logs'] ?? {}) as Record<string, unknown>;
  const rawPath = logs['path'] as string | undefined;

  return {
    enabled: (logs['enabled'] as boolean) ?? true,
    local: (logs['local'] as boolean) ?? true,
    // An explicit collector.logs.path is expanded relative to the real
    // homedir (that's what `~/` means in a value the user typed). The
    // *default* (no config, or no logs.path set) must instead resolve
    // under NIO_HOME so anything derived from it — the audit log itself,
    // plus every store that piggybacks on this path via dirname()
    // (traces-state-store.json, monitored-sessions.json) — stays inside
    // an overridden NIO_HOME during tests instead of silently falling
    // through to the developer's real ~/.nio.
    path: rawPath ? expandHome(rawPath) : join(nioDir(), 'audit.jsonl'),
    max_size_mb: (logs['max_size_mb'] as number) ?? 100,
  };
}

/**
 * Read `collector.monitor_all_sessions`.
 *
 * Defaults to `false` — nio's default posture is silence. Telemetry
 * leaves the machine only for sessions the user explicitly armed via
 * `/nio-monitor`, unless an operator opts the whole install in.
 *
 * Strict boolean check: any non-boolean value (string "yes", number 1)
 * reads as false. A typo in the config must not silently turn on
 * blanket capture.
 */
export function loadMonitorAllSessions(): boolean {
  const raw = readRawConfig();
  const collector = (raw['collector'] ?? {}) as Record<string, unknown>;
  return collector['monitor_all_sessions'] === true;
}

/**
 * Read `collector.content_limits` — per-content-kind byte caps applied by
 * `truncateContent` (content/truncate.ts). Each key falls back to
 * `DEFAULT_CONTENT_LIMITS` independently when unset, non-numeric,
 * negative, or otherwise malformed (a bad YAML value must never throw or
 * silently disable the cap for that kind — it just reverts to default).
 * An explicit `0` is a valid value (the "unlimited" escape hatch) and is
 * honored as-is, not treated as missing.
 */
export function loadContentLimits(): ContentLimits {
  const raw = readRawConfig();
  const collector = (raw['collector'] ?? {}) as Record<string, unknown>;
  const configured = (collector['content_limits'] ?? {}) as Record<string, unknown>;

  const pick = (key: keyof ContentLimits): number => {
    const value = configured[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : DEFAULT_CONTENT_LIMITS[key];
  };

  return {
    thinking: pick('thinking'),
    text: pick('text'),
    user_prompt: pick('user_prompt'),
    tool_input: pick('tool_input'),
    tool_output: pick('tool_output'),
  };
}
