/**
 * FFWD AgentGuard — Security guard for AI agents
 *
 * Three-module security framework:
 * - Skill Scanner: Static analysis of skill code
 * - Skill Registry: Trust level and capability management
 * - Action Scanner: Runtime action decision engine
 */

// Export types
export * from './types/index.js';

// Export core analysis engine
export * from './core/index.js';

// Export modules
export { SkillScanner, type ScannerOptions } from './scanner/index.js';
export {
  SkillRegistry,
  RegistryStorage,
  type RegistryOptions,
  type StorageOptions,
  type LookupResult,
  type AttestResult,
} from './registry/index.js';
export {
  ActionScanner,
  type ActionScannerOptions,
} from './action/index.js';

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
import { SkillRegistry } from './registry/index.js';
import { loadConfig } from './adapters/index.js';
import { ActionScanner } from './action/index.js';
import type { CapabilityModel } from './types/skill.js';

/**
 * Create a complete AgentGuard instance with all modules
 */
export function createAgentGuard(options?: {
  registryPath?: string;
  useExternalScanner?: boolean;
  /** Default capabilities used when no registry record is found for an actor */
  defaultCapabilities?: CapabilityModel;
}) {
  const registry = new SkillRegistry({
    filePath: options?.registryPath,
  });

  const config = loadConfig();
  const scanner = new SkillScanner({
    useExternalScanner: options?.useExternalScanner ?? true,
    extraPatterns: config.rules,
  });

  const actionScanner = new ActionScanner({
    registry,
    defaultCapabilities: options?.defaultCapabilities,
  });

  return {
    scanner,
    registry,
    actionScanner,
  };
}

// Default export
export default createAgentGuard;
