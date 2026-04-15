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

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCollectorConfig } from './lib/config-loader.js';
import { createMeterProvider, recordGuardDecision } from './lib/metrics-collector.js';
import { createLoggerProvider } from './lib/logs-collector.js';

// ---------------------------------------------------------------------------
// Types (local declarations to avoid cross-project imports)
// ---------------------------------------------------------------------------

interface HookOutput {
  decision: string;
  reason?: string;
  riskLevel?: string;
  riskScore?: number;
}

interface AgentGuardModule {
  createAgentGuard: (options?: { registryPath?: string }) => Record<string, unknown>;
  ClaudeCodeAdapter: new (opts?: { guardedTools?: Record<string, string> }) => unknown;
  evaluateHook: (adapter: unknown, rawInput: unknown, options: Record<string, unknown>, auditOpts?: Record<string, unknown>) => Promise<HookOutput>;
  loadConfig: () => {
    guard?: {
      level?: string;
      guarded_tools?: Record<string, Record<string, string>>;
    };
    collector?: {
      logs?: { enabled?: boolean; local?: boolean; max_size_mb?: number };
    };
  };
}

// ---------------------------------------------------------------------------
// Load AgentGuard engine + adapters
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const agentguardPath = join(dirname(__filename), '..', '..', '..', '..', '..', 'dist', 'index.js');

let mod: AgentGuardModule;
try {
  mod = await import(agentguardPath) as AgentGuardModule;
} catch {
  try {
    mod = // @ts-expect-error fallback to npm package if relative import fails
    await import('@core0-io/ffwd-agent-guard') as AgentGuardModule;
  } catch {
    process.stderr.write('FFWD AgentGuard: unable to load engine, allowing action\n');
    process.exit(0);
  }
}

const { createAgentGuard, ClaudeCodeAdapter, evaluateHook, loadConfig } = mod!;

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
