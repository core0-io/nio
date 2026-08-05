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
import { createFlushBudget } from './lib/flush-budget.js';
import { isSessionMonitored } from './lib/monitor-check.js';
import { dumpPayload } from './lib/payload-dump.js';
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

async function main(): Promise<void> {
  const input = await readStdin();
  if (!input) process.exit(0);

  // Debug-only sampling switch — see lib/payload-dump.ts module doc for
  // why this is deliberately NOT behind the monitor gate below.
  dumpPayload(PLATFORM, input.hook_event_name ?? 'unknown', input);

  // Gate before creating any provider — an unmonitored session must not
  // even initialise the OTLP exporters. The local audit log is written
  // regardless (see dispatchCollectorEvent), which is why we still call
  // dispatch with null providers instead of returning early.
  const monitored = isSessionMonitored(
    input.session_id ?? 'unknown',
    input.cwd ?? null,
    logsConfig,
  );

  const resourceAgentName = AGENT_NAME.length > 0 ? AGENT_NAME : undefined;
  const meterProvider = monitored
    ? createMeterProvider(config, PLATFORM, resourceAgentName)
    : null;
  const tracerProvider = monitored
    ? createTracerProvider(config, PLATFORM, resourceAgentName)
    : null;
  const loggerProvider = (monitored && config.enabled && logsConfig.enabled !== false)
    ? createLoggerProvider(config, PLATFORM, resourceAgentName)
    : null;

  // One shared deadline for every OTLP-touching await below — the
  // dispatch itself included, NOT just the closing Promise.all. Nearly
  // every dispatch branch ends in a library helper that carries its own
  // `provider.forceFlush()` (`recordToolUse`, `recordPostToolUse`,
  // `endTurn`, `emitSessionSpan`, `recoverDeferredTree`), so against an
  // endpoint that drops packets the hang happens INSIDE dispatch and the
  // closing flush is never reached. Measured unbounded against
  // 192.0.2.1:4318 on a PostToolUse event: still alive when killed at
  // 95s. See lib/flush-budget.ts.
  //
  // A dispatch abandoned at the deadline leaves whatever it had already
  // written to `traces-state-store.json` intact — every branch saves
  // state before its metric flush, and the two that flush first
  // (`endTurn`, `emitSessionSpan`) simply leave the turn open, which the
  // next event's orphaned-tree recovery is already built to pick up.
  const withFlushBudget = createFlushBudget(config.timeout);

  await withFlushBudget(
    dispatchCollectorEvent({
      event: input.hook_event_name ?? '',
      input,
      platform: PLATFORM,
      agentName: AGENT_NAME,
      config,
      meterProvider,
      tracerProvider,
      loggerProvider,
      logsConfig,
    }),
    undefined,
  );

  // Force network exporters to flush before the subprocess exits.
  // Without this, span/log/metric records can sit in batchers and never
  // reach OTLP.
  await withFlushBudget(
    Promise.all([
      meterProvider?.forceFlush().catch(e => reportFlushFailure('metrics', config.endpoint, e)),
      tracerProvider?.forceFlush().catch(e => reportFlushFailure('traces', config.endpoint, e)),
      loggerProvider?.forceFlush().catch(e => reportFlushFailure('logs', config.endpoint, e)),
    ]).then(() => undefined),
    undefined,
  );

  process.exit(0);
}

main();
