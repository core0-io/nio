// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export type { HookAdapter, HookInput, HookOutput, EngineOptions, NioInstance } from './types.js';
export { ClaudeCodeAdapter } from './claude-code.js';
export { OpenClawAdapter } from './openclaw.js';
export { HermesAdapter, type HermesAdapterOptions } from './hermes.js';
export { evaluateHook } from './hook-engine.js';
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
  type NioConfig,
  type CollectorConfig,
  type CollectorLogsConfig,
  type ResolvedMetricsConfig,
} from './common.js';
export {
  validateConfig,
  NioConfigSchema,
  CollectorConfigSchema,
} from './config-schema.js';
export {
  loadMCPRegistry,
  clearMCPRegistryCache,
  type MCPRegistry,
  type MCPServerEntry,
  type MCPSource,
  type LoadMCPRegistryOptions,
} from './mcp-registry.js';
export {
  detectMcpCalls,
  extractMcpCallsFromCommand,
  extractCommandString,
  type RoutedMcpCall,
  type DetectorTag,
  type ExtractedMcpCall,
} from './mcp-route-detect/index.js';
