#!/usr/bin/env node
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Nio — Collector Hook (Claude Code stdin wrapper)
 *
 * Reads a Claude Code hook event from stdin and forwards it to the
 * platform-agnostic [collector-core](./lib/collector-core.ts). Claude
 * Code already uses the canonical event names this dispatcher expects
 * (PreToolUse, PostToolUse, Stop, SessionStart, etc.), so no
 * translation is needed here. Hermes goes through the same core via
 * [hook-cli.ts](./hook-cli.ts), which adds a snake_case → canonical
 * translation step.
 *
 * Always exits 0 — telemetry never blocks the agent.
 */

import { loadCollectorConfig } from './lib/config-loader.js';
import { createMeterProvider } from './lib/metrics-collector.js';
import { createTracerProvider } from './lib/traces-collector.js';
import {
  dispatchCollectorEvent,
  type HookStdinPayload,
} from './lib/collector-core.js';

const config = loadCollectorConfig();
if (!config.enabled) {
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

const meterProvider = createMeterProvider(config);
const tracerProvider = createTracerProvider(config);

async function main(): Promise<void> {
  const input = await readStdin();
  if (!input) process.exit(0);

  await dispatchCollectorEvent({
    event: input.hook_event_name ?? '',
    input,
    platform: 'claude-code',
    config,
    meterProvider,
    tracerProvider,
  });

  process.exit(0);
}

main();
