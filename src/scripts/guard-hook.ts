#!/usr/bin/env node

export {};

/**
 * FFWD AgentGuard PreToolUse / PostToolUse Hook (Claude Code)
 *
 * Uses the common adapter + engine architecture.
 * Reads Claude Code hook input from stdin, delegates to evaluateHook(),
 * and outputs allow / deny / ask via Claude Code protocol.
 *
 * PreToolUse exit codes:
 *   0  = allow (or JSON with permissionDecision)
 *   2  = deny  (stderr = reason shown to Claude)
 *
 * PostToolUse: appends audit log entry (async, always exits 0)
 */

import { loadCollectorConfig } from './lib/config-loader.js';
import { createMeterProvider, recordGuardDecision } from './lib/metrics-collector.js';
import { createLoggerProvider } from './lib/logs-collector.js';
import { createAgentGuard, ClaudeCodeAdapter, evaluateHook, loadConfig } from '../index.js';

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
  const guardedTools = config.guard?.guarded_tools?.claude_code;
  const adapter = new ClaudeCodeAdapter({ guardedTools });
  const ffwdAgentGuard = createAgentGuard();

  // Set up OTEL providers for metrics + audit logs
  const collectorConfig = loadCollectorConfig();
  const meterProvider = createMeterProvider(collectorConfig);
  const logsConfig = config.collector?.logs;
  const loggerProvider = (logsConfig?.enabled !== false)
    ? createLoggerProvider(collectorConfig)
    : null;

  const result = await evaluateHook(
    adapter, input, { config, ffwdAgentGuard },
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
      'claude-code',
    );
  }

  // Flush OTEL providers before exit
  await Promise.all([
    meterProvider?.forceFlush(),
    loggerProvider?.forceFlush(),
  ]);

  if (result.decision === 'deny') outputDeny(result.reason || 'Action blocked');
  else if (result.decision === 'ask') outputAsk(result.reason || 'Action requires confirmation');
  else outputAllow();
}

main();
