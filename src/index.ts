// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Nio — Security guard for AI agents
 *
 * Two-pipeline security framework:
 * - Static Scan: On-demand code analysis (ScanOrchestrator → Static + Behavioural + LLM)
 * - Dynamic Guard: Real-time hook protection (ActionOrchestrator → 6-phase pipeline)
 */

// Export types
export * from './types/index.js';

// Export core analysis engine
export * from './core/index.js';

// Export modules
export { SkillScanner, type ScannerOptions } from './scanner/index.js';

// Export ActionOrchestrator (6-phase guard pipeline) + Phase 2 RuntimeAnalyser
export { ActionOrchestrator, type ActionDecision, type ActionOrchestratorOptions } from './core/action-orchestrator.js';
export { RuntimeAnalyser, type RuntimeAnalyserOptions, type GuardRulesConfig } from './core/analysers/runtime.js';
export { AllowlistAnalyser, type AllowlistAnalyserOptions, type AllowlistResult } from './core/analysers/allowlist.js';

// Export ExternalAnalyser (pluggable HTTP scorer for both pipelines)
export { ExternalAnalyser, type ExternalAnalyserOptions, type ExternalScoreRequest, type ExternalScoreResponse } from './core/analysers/external/index.js';

// Export policy presets
export {
  DEFAULT_POLICIES,
  RESTRICTIVE_CAPABILITY,
  PERMISSIVE_CAPABILITY,
  CAPABILITY_PRESETS,
  type PolicyConfig,
} from './policy/default.js';

// Export utility functions
export {
  containsSensitiveData,
  maskSensitiveData,
  extractDomain,
  isDomainAllowed,
  SENSITIVE_PATTERNS,
} from './utils/patterns.js';

// Export adapters (multi-platform hook support)
export {
  ClaudeCodeAdapter,
  OpenClawAdapter,
  evaluateHook,
  registerOpenClawPlugin,
  loadConfig,
  resetConfig,
  loadMetricsConfig,
  type HookAdapter,
  type HookInput,
  type HookOutput,
  type EngineOptions,
  type NioConfig,
  type CollectorConfig,
  type CollectorLogsConfig,
  type ResolvedMetricsConfig,
  validateConfig,
  NioConfigSchema,
  CollectorConfigSchema,
} from './adapters/index.js';

// Convenience factory functions
import { SkillScanner } from './scanner/index.js';
import { loadConfig } from './adapters/index.js';
import { ActionOrchestrator } from './core/action-orchestrator.js';
import type { ProtectionLevel } from './core/action-decision.js';

/**
 * Create a complete Nio instance with all modules
 */
export function createNio(options?: {
  useExternalScanner?: boolean;
}) {
  const config = loadConfig();
  const guard = config.guard;
  const scanner = new SkillScanner({
    useExternalScanner: options?.useExternalScanner ?? true,
    fileScanRules: guard?.file_scan_rules,
  });

  const orchestrator = new ActionOrchestrator({
    level: (guard?.protection_level || 'balanced') as ProtectionLevel,
    scoringWeights: guard?.scoring_weights,
    allowedCommands: guard?.allowed_commands,
    allowlistMode: guard?.allowlist_mode,
    fileScanRules: guard?.file_scan_rules,
    actionGuardRules: guard?.action_guard_rules,
    llmEnabled: guard?.llm_analyser?.enabled ?? false,
    llmApiKey: guard?.llm_analyser?.api_key,
    llmModel: guard?.llm_analyser?.model,
    externalEnabled: guard?.external_analyser?.enabled ?? false,
    scoringEndpoint: guard?.external_analyser?.endpoint,
    scoringApiKey: guard?.external_analyser?.api_key,
    scoringTimeout: guard?.external_analyser?.timeout,
  });

  return {
    scanner,
    orchestrator,
  };
}

// Default export
export default createNio;
