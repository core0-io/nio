export type { HookAdapter, HookInput, HookOutput, EngineOptions, AgentGuardInstance } from './types.js';
export { ClaudeCodeAdapter } from './claude-code.js';
export { OpenClawAdapter } from './openclaw.js';
export { evaluateHook } from './engine.js';
export {
  registerOpenClawPlugin,
  type OpenClawPluginOptions,
} from './openclaw-plugin.js';
export {
  loadConfig,
  resetConfig,
  loadMetricsConfig,
  isSensitivePath,
  shouldDenyAtLevel,
  shouldAskAtLevel,
  writeAuditLog,
  type AgentGuardConfig,
  type CollectorConfig,
  type CollectorLogsConfig,
  type ResolvedMetricsConfig,
} from './common.js';
export {
  validateConfig,
  AgentGuardConfigSchema,
  CollectorConfigSchema,
} from './config-schema.js';
