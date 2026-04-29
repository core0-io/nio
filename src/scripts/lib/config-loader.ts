// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Lightweight config loader for hook scripts.
 *
 * Reads ~/.nio/config.yaml (or $NIO_HOME/config.yaml)
 * without importing the main dist bundle.
 */

import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { load as yamlLoad } from 'js-yaml';

export interface CollectorConfig {
  endpoint: string;
  api_key: string;
  timeout: number;
  protocol: 'http' | 'grpc';
  enabled: boolean;
}

export interface LogsConfig {
  enabled: boolean;
  local: boolean;
  path: string;
  max_size_mb: number;
}

let lastReportedConfigError: string | null = null;

function reportConfigError(configDir: string, configPath: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (lastReportedConfigError === message) return;
  lastReportedConfigError = message;

  console.error(`[Nio] Failed to load ${configPath}, falling back to defaults:`);
  console.error(`  ${message}`);

  try {
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
    const entry = {
      event: 'config_error',
      timestamp: new Date().toISOString(),
      config_path: configPath,
      error_message: message,
    };
    appendFileSync(join(configDir, 'audit.jsonl'), JSON.stringify(entry) + '\n');
  } catch {
    // Best-effort
  }
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

export function loadCollectorConfig(): CollectorConfig {
  const raw = readRawConfig();

  const c = (raw['collector'] ?? {}) as Record<string, unknown>;
  const endpoint = (c['endpoint'] as string) ?? '';

  return {
    endpoint,
    api_key: (c['api_key'] as string) ?? '',
    timeout: (c['timeout'] as number) || 5000,
    protocol: (c['protocol'] as 'http' | 'grpc') ?? 'http',
    // Reflects only OTLP export readiness. Local audit logging is
    // controlled separately via loadLogsConfig() / logsConfig.local.
    enabled: endpoint !== '',
  };
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
