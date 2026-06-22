#!/usr/bin/env node
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Nio — Collector Hook (Claude Code + Codex CLI)
 *
 * Reads a hook event from stdin and forwards it to the platform-agnostic
 * [collector-core](./lib/collector-core.ts). Both Claude Code and Codex
 * CLI use the canonical PascalCase event names this dispatcher expects
 * (PreToolUse, PostToolUse, Stop, SessionStart, …) so no translation is
 * needed here. Hermes goes through the same core via
 * [hook-cli.ts](./hook-cli.ts), which adds a snake_case → canonical
 * translation step.
 *
 * Platform tag is selected via `--platform <name>` (default: claude-code).
 * Always exits 0 — telemetry never blocks the agent.
 */

import { loadCollectorConfig, loadLogsConfig, loadAgentName } from './lib/config-loader.js';
import { createMeterProvider } from './lib/metrics-collector.js';
import { createTracerProvider } from './lib/traces-collector.js';
import { createLoggerProvider } from './lib/logs-collector.js';
import { reportFlushFailure } from './lib/exporter-diagnostics.js';
import {
  dispatchCollectorEvent,
  type HookStdinPayload,
} from './lib/collector-core.js';

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}
const PLATFORM = getArg('platform') ?? 'claude-code';
const AGENT_NAME = loadAgentName();   // empty string when unset/empty

const config = loadCollectorConfig();
const logsConfig = loadLogsConfig();
// Audit dispatch is kept on even when OTLP export is disabled so the
// local audit.jsonl still gets hook-event entries. Only short-circuit
// when both endpoint and local logging are off.
if (!config.enabled && logsConfig.local === false) {
  process.exit(0);
}

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

const resourceAgentName = AGENT_NAME.length > 0 ? AGENT_NAME : undefined;
const meterProvider = createMeterProvider(config, PLATFORM, resourceAgentName);
const tracerProvider = createTracerProvider(config, PLATFORM, resourceAgentName);
const loggerProvider = (config.enabled && logsConfig.enabled !== false)
  ? createLoggerProvider(config, PLATFORM, resourceAgentName)
  : null;

async function main(): Promise<void> {
  const input = await readStdin();
  if (!input) process.exit(0);

  await dispatchCollectorEvent({
    event: input.hook_event_name ?? '',
    input,
    platform: PLATFORM,
    agentName: AGENT_NAME,
    config,
    meterProvider,
    tracerProvider,
    loggerProvider,
    logsConfig,
  });

  // Force network exporters to flush before the subprocess exits.
  // Without this, span/log/metric records can sit in batchers and never
  // reach OTLP.
  await Promise.all([
    meterProvider?.forceFlush().catch(e => reportFlushFailure('metrics', config.endpoint, e)),
    tracerProvider?.forceFlush().catch(e => reportFlushFailure('traces', config.endpoint, e)),
    loggerProvider?.forceFlush().catch(e => reportFlushFailure('logs', config.endpoint, e)),
  ]);

  process.exit(0);
}

main();
