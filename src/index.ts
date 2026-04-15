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
    extraPatterns: guard?.rules,
  });

  const runtimeAnalyser = new RuntimeAnalyser({
    level: (guard?.level || 'balanced') as ProtectionLevel,
    weights: guard?.weights,
    extraAllowlist: guard?.allowed_commands,
    extraPatterns: guard?.rules,
    llmApiKey: guard?.llm?.api_key,
    llmModel: guard?.llm?.model,
    scoringEndpoint: guard?.external_scoring?.endpoint,
    scoringApiKey: guard?.external_scoring?.api_key,
    scoringTimeout: guard?.external_scoring?.timeout,
  });

  return {
    scanner,
    runtimeAnalyser,
  };
}

// Default export
export default createAgentGuard;
