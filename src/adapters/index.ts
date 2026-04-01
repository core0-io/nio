export type { HookAdapter, HookInput, HookOutput, EngineOptions, AgentGuardInstance } from './types.js';
export { ClaudeCodeAdapter } from './claude-code.js';
export { OpenClawAdapter } from './openclaw.js';
export { evaluateHook } from './engine.js';
export {
  registerOpenClawPlugin,
  getPluginIdFromTool,
  getPluginScanResult,
  type OpenClawPluginOptions,
} from './openclaw-plugin.js';
export {
  loadConfig,
  resetConfig,
  loadMetricsConfig,
  detectPlatform,
  isSensitivePath,
  shouldDenyAtLevel,
  shouldAskAtLevel,
  writeAuditLog,
  getSkillTrustPolicy,
  isActionAllowedByCapabilities,
  type AgentGuardConfig,
  type MetricsConfig,
  type ResolvedMetricsConfig,
} from './common.js';
export {
  validateConfig,
  AgentGuardConfigSchema,
  MetricsConfigSchema,
} from './config-schema.js';
