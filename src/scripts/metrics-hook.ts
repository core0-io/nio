#!/usr/bin/env node

export {};

/**
 * FFWD AgentGuard — Metrics Collection Hook
 *
 * Standalone async hook that captures tool-use telemetry from
 * PreToolUse / PostToolUse events and exports it as OpenTelemetry
 * spans via OTLP HTTP and/or appends it to a local JSONL log file.
 *
 * Spans from the same session share a deterministic trace ID derived
 * from the session_id, so they appear grouped in any OTEL backend.
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
import { createHash } from 'node:crypto';
import { trace, context, TraceFlags, ROOT_CONTEXT } from '@opentelemetry/api';
import { NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

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
// OTEL trace pipeline
// ---------------------------------------------------------------------------

let otelProvider: NodeTracerProvider | null = null;

function initOtelProvider(): NodeTracerProvider | null {
  if (!ENDPOINT) return null;

  const headers: Record<string, string> = {};
  if (API_KEY) {
    headers['Authorization'] = `Bearer ${API_KEY}`;
  }

  const exporter = new OTLPTraceExporter({
    url: ENDPOINT,
    headers,
    timeoutMillis: TIMEOUT,
  });

  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });

  provider.register();
  return provider;
}

/**
 * Derive a deterministic 16-byte trace ID from session_id so that all
 * spans within the same session are grouped under one trace.
 */
function sessionToTraceId(sessionId: string): string {
  return createHash('md5').update(sessionId).digest('hex');
}

async function sendMetricsViaOtel(payload: MetricPayload): Promise<void> {
  if (!otelProvider) return;

  const tracer = trace.getTracer('agentguard-metrics', '1.0.0');

  let parentCtx = ROOT_CONTEXT;

  if (payload.session_id) {
    const traceId = sessionToTraceId(payload.session_id);
    const spanContext = {
      traceId,
      spanId: traceId.slice(0, 16),
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    };
    parentCtx = trace.setSpanContext(ROOT_CONTEXT, spanContext);
  }

  const span = tracer.startSpan(
    `agentguard.metric.${payload.event || 'unknown'}`,
    {
      attributes: {
        'agentguard.event': payload.event,
        'agentguard.tool_name': payload.tool_name,
        'agentguard.platform': payload.platform,
        'agentguard.tool_summary': payload.tool_summary,
        ...(payload.session_id && { 'agentguard.session_id': payload.session_id }),
        ...(payload.cwd && { 'agentguard.cwd': payload.cwd }),
      },
    },
    parentCtx,
  );

  span.end();

  await otelProvider.forceFlush();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

otelProvider = initOtelProvider();

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
    await sendMetricsViaOtel(payload);
  } catch {
    // Best-effort
  }

  process.exit(0);
}

main();
