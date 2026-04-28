// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeCodeAdapter } from '../../adapters/claude-code.js';
import { OpenClawAdapter } from '../../adapters/openclaw.js';
import { HermesAdapter } from '../../adapters/hermes.js';
import { ActionOrchestrator } from '../../core/action-orchestrator.js';
import type { EngineOptions } from '../../adapters/types.js';
import type { GuardRulesConfig } from '../../core/analysers/runtime/index.js';
import type { PhaseWeights } from '../../core/scoring.js';
import type { ProtectionLevel } from '../../core/action-decision.js';
import type { MCPRegistry } from '../../adapters/mcp-registry.js';

/**
 * Create an isolated test context with injectable config level.
 * No real ~/.nio/ pollution.
 */
export interface TestContextOptions {
  level?: string;
  guard?: {
    available_tools?: Record<string, string[]>;
    blocked_tools?: Record<string, string[]>;
    guarded_tools?: Record<string, string>;
    action_guard_rules?: GuardRulesConfig;
    file_scan_rules?: Partial<Record<string, string[]>>;
    allowed_commands?: string[];
    allowlist_mode?: 'exit' | 'continue';
    scoring_weights?: Partial<PhaseWeights>;
  };
  mcpRegistry?: MCPRegistry;
}

export function createTestContext(levelOrOpts: string | TestContextOptions = 'balanced') {
  const opts: TestContextOptions = typeof levelOrOpts === 'string'
    ? { level: levelOrOpts }
    : levelOrOpts;

  const tempDir = mkdtempSync(join(tmpdir(), 'nio-integ-'));
  // Create an isolated ActionOrchestrator — no external services, no loadConfig() side effects
  const nio = {
    orchestrator: new ActionOrchestrator({
      level: (opts.level ?? 'balanced') as ProtectionLevel,
      allowedCommands: opts.guard?.allowed_commands,
      allowlistMode: opts.guard?.allowlist_mode,
      fileScanRules: opts.guard?.file_scan_rules,
      actionGuardRules: opts.guard?.action_guard_rules,
      scoringWeights: opts.guard?.scoring_weights,
    }),
  };

  const config: EngineOptions['config'] = {
    guard: {
      protection_level: opts.level ?? 'balanced',
      available_tools: opts.guard?.available_tools,
      blocked_tools: opts.guard?.blocked_tools,
    },
  };
  const options: EngineOptions = {
    config,
    nio: nio as unknown as EngineOptions['nio'],
    mcpRegistry: opts.mcpRegistry,
  };

  return {
    tempDir,
    nio,
    config,
    options,
    claudeAdapter: new ClaudeCodeAdapter({ guardedTools: opts.guard?.guarded_tools }),
    openclawAdapter: new OpenClawAdapter(),
    hermesAdapter: new HermesAdapter(),
    cleanup() {
      try {
        rmSync(tempDir, { recursive: true });
      } catch {
        // ignore
      }
    },
  };
}
