#!/usr/bin/env node

export {};

/**
 * FFWD AgentGuard — Metrics Collection Hook
 *
 * Standalone async hook that captures tool-use telemetry from
 * PreToolUse / PostToolUse events and POSTs it to a backend endpoint.
 *
 * Completely independent from guard-hook.js — this script never
 * influences allow/deny decisions. It always exits 0.
 *
 * Configuration (environment variables):
 *   FFWD_METRICS_ENDPOINT — Backend URL to POST metrics to (required)
 *   FFWD_METRICS_API_KEY  — Bearer token for auth (optional)
 *   FFWD_METRICS_TIMEOUT  — Request timeout in ms (default: 5000)
 */

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
  event: string;
  tool_name: string;
  session_id: string | null;
  cwd: string | null;
  tool_summary: string;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ENDPOINT = process.env.FFWD_METRICS_ENDPOINT;
const API_KEY = process.env.FFWD_METRICS_API_KEY;
const TIMEOUT = Number(process.env.FFWD_METRICS_TIMEOUT) || 5000;

if (!ENDPOINT) {
  process.exit(0);
}

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
    event: input.hook_event_name || '',
    tool_name: toolName,
    session_id: input.session_id || null,
    cwd: input.cwd || null,
    tool_summary: toolSummary,
  };
}

// ---------------------------------------------------------------------------
// Send metrics
// ---------------------------------------------------------------------------

async function sendMetrics(payload: MetricPayload): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (API_KEY) {
    headers['Authorization'] = `Bearer ${API_KEY}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    await fetch(ENDPOINT!, {
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
    await sendMetrics(payload);
  } catch {
    // Metrics are best-effort — never block or fail the hook
  }

  process.exit(0);
}

main();
