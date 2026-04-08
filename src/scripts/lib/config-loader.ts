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

export function loadCollectorConfig(): CollectorConfig {
  const configDir = process.env['FFWD_AGENT_GUARD_HOME']
    ?? join(homedir(), '.ffwd-agent-guard');
  const configPath = join(configDir, 'config.json');

  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    // No config file — return disabled
    return disabled();
  }

  const c = (raw['collector'] ?? {}) as Record<string, unknown>;

  let log = (c['log'] as string) ?? '';
  if (log.startsWith('~/')) {
    log = join(homedir(), log.slice(2));
  }

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

function disabled(): CollectorConfig {
  return { endpoint: '', api_key: '', timeout: 5000, log: '', protocol: 'http', enabled: false };
}
