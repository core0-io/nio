import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentGuard } from '../../index.js';
import { ClaudeCodeAdapter } from '../../adapters/claude-code.js';
import { OpenClawAdapter } from '../../adapters/openclaw.js';
import type { EngineOptions } from '../../adapters/types.js';

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
  };
}

export function createTestContext(levelOrOpts: string | TestContextOptions = 'balanced') {
  const opts: TestContextOptions = typeof levelOrOpts === 'string'
    ? { level: levelOrOpts }
    : levelOrOpts;

  const tempDir = mkdtempSync(join(tmpdir(), 'ffwd-agent-guard-integ-'));
  const ffwdAgentGuard = createAgentGuard();

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
