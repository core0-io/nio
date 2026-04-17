import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeCodeAdapter } from '../../adapters/claude-code.js';
import { OpenClawAdapter } from '../../adapters/openclaw.js';
import { RuntimeAnalyser } from '../../core/analysers/runtime/index.js';
import type { EngineOptions } from '../../adapters/types.js';
import type { GuardRulesConfig } from '../../core/analysers/runtime/denylist.js';
import type { PhaseWeights } from '../../core/scoring.js';
import type { ProtectionLevel } from '../../core/analysers/runtime/decision.js';

/**
 * Create an isolated test context with injectable config level.
 * No real ~/.ffwd-agent-guard/ pollution.
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
    scoring_weights?: Partial<PhaseWeights>;
  };
}

export function createTestContext(levelOrOpts: string | TestContextOptions = 'balanced') {
  const opts: TestContextOptions = typeof levelOrOpts === 'string'
    ? { level: levelOrOpts }
    : levelOrOpts;

  const tempDir = mkdtempSync(join(tmpdir(), 'ffwd-agent-guard-integ-'));
  // Create an isolated RuntimeAnalyser — no external services, no loadConfig() side effects
  const ffwdAgentGuard = {
    runtimeAnalyser: new RuntimeAnalyser({
      level: (opts.level ?? 'balanced') as ProtectionLevel,
      allowedCommands: opts.guard?.allowed_commands,
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
    ffwdAgentGuard: ffwdAgentGuard as unknown as EngineOptions['ffwdAgentGuard'],
  };

  return {
    tempDir,
    ffwdAgentGuard,
    config,
    options,
    claudeAdapter: new ClaudeCodeAdapter({ guardedTools: opts.guard?.guarded_tools }),
    openclawAdapter: new OpenClawAdapter(),
    cleanup() {
      try {
        rmSync(tempDir, { recursive: true });
      } catch {
        // ignore
      }
    },
  };
}
