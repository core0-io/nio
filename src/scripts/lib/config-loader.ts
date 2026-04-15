export {};

/**
 * Lightweight config loader for hook scripts.
 *
 * Reads ~/.ffwd-agent-guard/config.json (or $FFWD_AGENT_GUARD_HOME/config.json)
 * directly without importing the main dist bundle or any heavy dependencies.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface CollectorConfig {
  endpoint: string;
  api_key: string;
  timeout: number;
  log: string;
  protocol: 'http' | 'grpc';
  enabled: boolean;
}

export interface LogsConfig {
  enabled: boolean;
  local: boolean;
  path: string;
  max_size_mb: number;
}

function readRawConfig(): Record<string, unknown> {
  const configDir = process.env['FFWD_AGENT_GUARD_HOME']
    ?? join(homedir(), '.ffwd-agent-guard');
  const configPath = join(configDir, 'config.json');

  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function expandHome(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

export function loadCollectorConfig(): CollectorConfig {
  const raw = readRawConfig();

  // New format: collector at top level
  let c = (raw['collector'] ?? {}) as Record<string, unknown>;

  // Metrics log: new path (collector.metrics.log) or legacy (collector.log)
  const metrics = (c['metrics'] ?? {}) as Record<string, unknown>;
  let log = (metrics['log'] as string) ?? (c['log'] as string) ?? '';
  if (log) log = expandHome(log);

  const endpoint = (c['endpoint'] as string) ?? '';
  const enabled = endpoint !== '' || log !== '';

  return {
    endpoint,
    api_key: (c['api_key'] as string) ?? '',
    timeout: (c['timeout'] as number) || 5000,
    log,
    protocol: (c['protocol'] as 'http' | 'grpc') ?? 'http',
    enabled,
  };
}

export function loadLogsConfig(): LogsConfig {
  const raw = readRawConfig();

  const collector = (raw['collector'] ?? {}) as Record<string, unknown>;
  let logs = (collector['logs'] ?? {}) as Record<string, unknown>;

  // Backward compat: top-level `audit` section
  if (raw['audit'] && typeof raw['audit'] === 'object' && Object.keys(logs).length === 0) {
    const audit = raw['audit'] as Record<string, unknown>;
    logs = {
      enabled: audit['otel'],
      local: audit['local'],
      max_size_mb: audit['max_size_mb'],
    };
  }

  return {
    enabled: (logs['enabled'] as boolean) ?? true,
    local: (logs['local'] as boolean) ?? true,
    path: expandHome((logs['path'] as string) ?? '~/.ffwd-agent-guard/audit.jsonl'),
    max_size_mb: (logs['max_size_mb'] as number) ?? 100,
  };
}
