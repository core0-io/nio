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

// ---------------------------------------------------------------------------
// Types (local declarations to avoid cross-project imports)
// ---------------------------------------------------------------------------

interface HookOutput {
  decision: string;
  reason?: string;
}

interface AgentGuardModule {
  createAgentGuard: (options?: { registryPath?: string }) => Record<string, unknown>;
  ClaudeCodeAdapter: new (opts?: { guardedTools?: Record<string, string> }) => unknown;
  evaluateHook: (adapter: unknown, rawInput: unknown, options: Record<string, unknown>) => Promise<HookOutput>;
  loadConfig: () => { level: string; guard?: { guarded_tools?: Record<string, string> }; metrics?: Record<string, unknown> };
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
  const adapter = new ClaudeCodeAdapter({ guardedTools: config.guard?.guarded_tools });
  const ffwdAgentGuard = createAgentGuard();

  const result = await evaluateHook(adapter, input, { config, ffwdAgentGuard });

  if (result.decision === 'deny') outputDeny(result.reason || 'Action blocked');
  else if (result.decision === 'ask') outputAsk(result.reason || 'Action requires confirmation');
  else outputAllow();
}

main();
