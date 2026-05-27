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

function readRawConfig(): Record<string, unknown> {
  const configDir = process.env['NIO_HOME']
    ?? join(homedir(), '.nio');
  const configPath = join(configDir, 'config.yaml');

  if (!existsSync(configPath)) return {};

  try {
    return (yamlLoad(readFileSync(configPath, 'utf-8')) ?? {}) as Record<string, unknown>;
  } catch (err) {
    reportConfigError(configDir, configPath, err);
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

  return {
    enabled: (logs['enabled'] as boolean) ?? true,
    local: (logs['local'] as boolean) ?? true,
    path: expandHome((logs['path'] as string) ?? '~/.nio/audit.jsonl'),
    max_size_mb: (logs['max_size_mb'] as number) ?? 100,
  };
}
