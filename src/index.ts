/**
 * FFWD AgentGuard — Security guard for AI agents
 *
 * Two-pipeline security framework:
 * - Static Scan: On-demand code analysis (ScanOrchestrator → Static + Behavioural + LLM)
 * - Dynamic Guard: Real-time hook protection (RuntimeAnalyser → 6-phase pipeline)
 */

// Export types
export * from './types/index.js';

// Export core analysis engine
export * from './core/index.js';

// Export modules
export { SkillScanner, type ScannerOptions } from './scanner/index.js';

// Export RuntimeAnalyser (guard pipeline)
export { RuntimeAnalyser, type RuntimeDecision, type RuntimeAnalyserOptions } from './core/analysers/runtime/index.js';

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
  type AgentGuardConfig,
  type CollectorConfig,
  type CollectorLogsConfig,
  type ResolvedMetricsConfig,
  validateConfig,
  AgentGuardConfigSchema,
  CollectorConfigSchema,
} from './adapters/index.js';

// Convenience factory functions
import { SkillScanner } from './scanner/index.js';
import { loadConfig } from './adapters/index.js';
import { RuntimeAnalyser } from './core/analysers/runtime/index.js';
import type { ProtectionLevel } from './core/analysers/runtime/decision.js';

/**
 * Create a complete AgentGuard instance with all modules
 */
export function createAgentGuard(options?: {
  useExternalScanner?: boolean;
}) {
  const config = loadConfig();
  const guard = config.guard;
  const scanner = new SkillScanner({
    useExternalScanner: options?.useExternalScanner ?? true,
    fileScanRules: guard?.file_scan_rules,
  });

  const runtimeAnalyser = new RuntimeAnalyser({
    level: (guard?.protection_level || 'balanced') as ProtectionLevel,
    scoringWeights: guard?.scoring_weights,
    allowedCommands: guard?.allowed_commands,
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
    runtimeAnalyser,
  };
}

// Default export
export default createAgentGuard;
