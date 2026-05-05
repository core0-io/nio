#!/usr/bin/env node
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Nio PreToolUse / PostToolUse Hook (Claude Code + Codex CLI)
 *
 * Reads hook input from stdin, delegates to evaluateHook(), and outputs
 * allow / deny / ask via the Claude Code protocol (which Codex also
 * accepts — both treat exit 2 as deny + stderr as reason). Selects the
 * platform adapter via `--platform <name>` (default: claude-code).
 *
 * Usage:
 *   node guard-hook.js                      # claude-code (default)
 *   node guard-hook.js --platform codex     # codex CLI
 *
 * PreToolUse exit codes:
 *   0  = allow (or JSON with permissionDecision)
 *   2  = deny  (stderr = reason shown to the agent)
 *
 * PostToolUse: appends audit log entry (async, always exits 0)
 */

import { loadCollectorConfig } from './lib/config-loader.js';
import { createMeterProvider, recordGuardDecision } from './lib/metrics-collector.js';
import { createLoggerProvider } from './lib/logs-collector.js';
import { createNio, ClaudeCodeAdapter, CodexAdapter, evaluateHook, loadConfig } from '../index.js';
import type { HookAdapter } from '../index.js';

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
const PLATFORM_KEY = PLATFORM.replace(/-/g, '_');

// ---------------------------------------------------------------------------
// Read stdin
// ---------------------------------------------------------------------------

function readStdin(): Promise<unknown> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => (data += chunk));
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(null);
      }
    });
    setTimeout(() => resolve(null), 5000);
  });
}

// ---------------------------------------------------------------------------
// Claude Code output helpers
// ---------------------------------------------------------------------------

function outputDeny(reason: string): never {
  process.stderr.write(reason + '\n');
  process.exit(2);
}

function outputAsk(reason: string): never {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

function outputAllow(): never {
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const input = await readStdin();
  if (!input) {
    process.exit(0);
  }

  const config = loadConfig();
  const nativeToolMapping = config.guard?.native_tool_mapping?.[PLATFORM_KEY];
  const adapter: HookAdapter = PLATFORM === 'codex'
    ? new CodexAdapter({ nativeToolMapping })
    : new ClaudeCodeAdapter({ nativeToolMapping });
  const nio = createNio();

  // Set up OTEL providers for metrics + audit logs
  const collectorConfig = loadCollectorConfig();
  const meterProvider = createMeterProvider(collectorConfig);
  const logsConfig = config.collector?.logs;
  const loggerProvider = (logsConfig?.enabled !== false)
    ? createLoggerProvider(collectorConfig)
    : null;

  const result = await evaluateHook(
    adapter, input, { config, nio },
    { loggerProvider, logsConfig },
  );

  // Record guard decision metrics
  if (meterProvider) {
    const toolName = (input as Record<string, unknown>).tool_name as string || '';
    await recordGuardDecision(
      meterProvider,
      result.decision,
      result.riskLevel || 'low',
      result.riskScore ?? 0,
      toolName,
      PLATFORM,
    );
  }

  // Flush OTEL providers before exit
  await Promise.all([
    meterProvider?.forceFlush(),
    loggerProvider?.forceFlush(),
  ]);

  if (result.decision === 'deny') outputDeny(result.reason || 'Action blocked');
  else if (result.decision === 'ask') {
    const confirmAction = config.guard?.confirm_action ?? 'ask';
    if (confirmAction === 'deny') outputDeny(result.reason || 'Action requires confirmation');
    else if (confirmAction === 'allow') outputAllow();
    else outputAsk(result.reason || 'Action requires confirmation');
  }
  else outputAllow();
}

main();
