#!/usr/bin/env node

export {};

/**
 * FFWD AgentGuard — Metrics Collection Hook
 *
 * Standalone async hook that captures tool-use telemetry from
 * PreToolUse / PostToolUse events and POSTs it to a backend endpoint
 * and/or appends it to a local JSONL log file.
 *
 * Completely independent from guard-hook.js — this script never
 * influences allow/deny decisions. It always exits 0.
 *
 * Configuration is read from ~/.ffwd-agent-guard/config.json (metrics section).
 * At least one of metrics.endpoint or metrics.log must be configured,
 * otherwise the script exits immediately.
 */

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HookStdinPayload {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  session_id?: string;
  cwd?: string;
}

interface MetricPayload {
  timestamp: string;
  platform: string;
  event: string;
  tool_name: string;
  session_id: string | null;
  cwd: string | null;
  tool_summary: string;
}

interface ResolvedMetricsConfig {
  endpoint: string;
  api_key: string;
  timeout: number;
  log: string;
  enabled: boolean;
}

interface AgentGuardModule {
  loadMetricsConfig: () => ResolvedMetricsConfig;
}

// ---------------------------------------------------------------------------
// Load config from AgentGuard engine
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const agentguardPath = join(dirname(__filename), '..', '..', '..', 'dist', 'index.js');

const platformIdx = process.argv.indexOf('--platform');
const platform = platformIdx !== -1 && process.argv[platformIdx + 1]
  ? process.argv[platformIdx + 1]
  : 'unknown';

let metricsConfig: ResolvedMetricsConfig;
try {
  const mod = await import(agentguardPath) as AgentGuardModule;
  metricsConfig = mod.loadMetricsConfig();
} catch {
  try {
    const mod = // @ts-expect-error fallback to npm package if relative import fails
      await import('@core0-io/ffwd-agent-guard') as AgentGuardModule;
    metricsConfig = mod.loadMetricsConfig();
  } catch {
    process.exit(0);
  }
}

if (!metricsConfig!.enabled) {
  process.exit(0);
}

const { endpoint: ENDPOINT, api_key: API_KEY, timeout: TIMEOUT, log: LOG_PATH } = metricsConfig!;

// ---------------------------------------------------------------------------
// Read stdin (same protocol as guard-hook.js)
// ---------------------------------------------------------------------------

function readStdin(): Promise<HookStdinPayload | null> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => (data += chunk));
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(data) as HookStdinPayload);
      } catch {
        resolve(null);
      }
    });
    setTimeout(() => resolve(null), 5000);
  });
}

// ---------------------------------------------------------------------------
// Build metric payload
// ---------------------------------------------------------------------------

function buildPayload(input: HookStdinPayload): MetricPayload {
  const toolName = input.tool_name || '';
  const toolInput = input.tool_input || {};

  let toolSummary: string;

  switch (toolName) {
    case 'Bash':
      toolSummary = ((toolInput.command as string) || '').slice(0, 300);
      break;
    case 'Write':
    case 'Edit':
      toolSummary = (toolInput.file_path as string) || (toolInput.path as string) || '';
      break;
    case 'WebFetch':
    case 'WebSearch':
      toolSummary = (toolInput.url as string) || (toolInput.query as string) || '';
      break;
    default:
      toolSummary = JSON.stringify(toolInput).slice(0, 300);
  }

  return {
    timestamp: new Date().toISOString(),
    platform,
    event: input.hook_event_name || '',
    tool_name: toolName,
    session_id: input.session_id || null,
    cwd: input.cwd || null,
    tool_summary: toolSummary,
  };
}

// ---------------------------------------------------------------------------
// Write to local log file
// ---------------------------------------------------------------------------

function writeToLog(payload: MetricPayload): void {
  if (!LOG_PATH) return;
  const dir = dirname(LOG_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  appendFileSync(LOG_PATH, JSON.stringify(payload) + '\n');
}

// ---------------------------------------------------------------------------
// Send metrics to remote endpoint
// ---------------------------------------------------------------------------

async function sendMetrics(payload: MetricPayload): Promise<void> {
  if (!ENDPOINT) return;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (API_KEY) {
    headers['Authorization'] = `Bearer ${API_KEY}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    await fetch(ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const input = await readStdin();
  if (!input) {
    process.exit(0);
  }

  const payload = buildPayload(input);

  try {
    writeToLog(payload);
  } catch {
    // Best-effort
  }

  try {
    await sendMetrics(payload);
  } catch {
    // Best-effort
  }

  process.exit(0);
}

main();
