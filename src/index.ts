/**
 * FFWD AgentGuard — Security guard for AI agents
 *
 * Two-pipeline security framework:
 * - Static Scan: On-demand code analysis (ScanOrchestrator → Static + Behavioral + LLM)
 * - Dynamic Guard: Real-time hook protection (RuntimeAnalyzer → 6-phase pipeline)
 */

// Export types
export * from './types/index.js';

// Export core analysis engine
export * from './core/index.js';

// Export modules
export { SkillScanner, type ScannerOptions } from './scanner/index.js';

// Export RuntimeAnalyzer (guard pipeline)
export { RuntimeAnalyzer, type RuntimeDecision, type RuntimeAnalyzerOptions } from './core/analyzers/runtime/index.js';

// Export ExternalAnalyzer (pluggable HTTP scorer for both pipelines)
export { ExternalAnalyzer, type ExternalAnalyzerOptions, type ExternalScoreRequest, type ExternalScoreResponse } from './core/analyzers/external/index.js';

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
  type MetricsConfig,
  type ResolvedMetricsConfig,
  validateConfig,
  AgentGuardConfigSchema,
  MetricsConfigSchema,
} from './adapters/index.js';

// Convenience factory functions
import { SkillScanner } from './scanner/index.js';
import { loadConfig } from './adapters/index.js';
import { RuntimeAnalyzer } from './core/analyzers/runtime/index.js';
import type { ProtectionLevel } from './core/analyzers/runtime/decision.js';

/**
 * Create a complete AgentGuard instance with all modules
 */
export function createAgentGuard(options?: {
  useExternalScanner?: boolean;
}) {
  const config = loadConfig();
  const scanner = new SkillScanner({
    useExternalScanner: options?.useExternalScanner ?? true,
    extraPatterns: config.rules,
  });

  const runtimeAnalyzer = new RuntimeAnalyzer({
    level: (config.level || 'balanced') as ProtectionLevel,
    weights: config.guard?.weights,
    extraAllowlist: config.guard?.extra_allowlist,
    llmApiKey: config.llm?.api_key,
    llmModel: config.llm?.model,
    scoringEndpoint: config.guard?.scoring_endpoint,
    scoringApiKey: config.guard?.scoring_api_key,
    scoringTimeout: config.guard?.scoring_timeout,
  });

  return {
    scanner,
    runtimeAnalyzer,
  };
}

// Default export
export default createAgentGuard;
