// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Zod schemas — Collector (telemetry)
// ---------------------------------------------------------------------------

export const CollectorMetricsConfigSchema = z.object({
  // Toggle OTLP metrics export. Local persistence was removed: the
  // legacy `local` / `log` / `max_size_mb` fields used to write hook-
  // event audits to a misnamed `metrics.jsonl`; those records now flow
  // through `collector.logs.path` via writeAuditLog.
  enabled: z.boolean().optional(),
});

export const CollectorTracesConfigSchema = z.object({
  enabled: z.boolean().optional(),
});

export const CollectorLogsConfigSchema = z.object({
  enabled: z.boolean().optional(),
  local: z.boolean().optional(),
  path: z.string().optional(),
  max_size_mb: z.number().optional(),
});

export const CollectorConfigSchema = z.object({
  endpoint: z.string().optional(),
  api_key: z.string().optional(),
  timeout: z.number().positive().optional(),
  protocol: z.enum(['http', 'grpc']).optional(),
  metrics: CollectorMetricsConfigSchema.optional(),
  traces: CollectorTracesConfigSchema.optional(),
  logs: CollectorLogsConfigSchema.optional(),
});

// ---------------------------------------------------------------------------
// Zod schemas — Guard (security)
// ---------------------------------------------------------------------------

const RulesPatternsSchema = z.object({
  shell_exec:       z.array(z.string()).optional(),
  remote_loader:    z.array(z.string()).optional(),
  secrets:          z.array(z.string()).optional(),
  obfuscation:      z.array(z.string()).optional(),
  prompt_injection: z.array(z.string()).optional(),
  exfiltration:     z.array(z.string()).optional(),
  trojan:           z.array(z.string()).optional(),
});

export type ScanRulesPatterns = z.infer<typeof RulesPatternsSchema>;

const GuardRulesSchema = z.object({
  dangerous_commands:  z.array(z.string()).optional(),
  dangerous_patterns:  z.array(z.string()).optional(),
  sensitive_commands:  z.array(z.string()).optional(),
  system_commands:     z.array(z.string()).optional(),
  network_commands:    z.array(z.string()).optional(),
  webhook_domains:     z.array(z.string()).optional(),
  sensitive_paths:         z.array(z.string()).optional(),
  sensitive_path_patterns: z.array(z.string()).optional(),
  secret_patterns:         z.array(z.string()).optional(),
});

export type GuardRules = z.infer<typeof GuardRulesSchema>;

export const LLMConfigSchema = z.object({
  enabled: z.boolean().optional(),
  api_key: z.string().optional(),
  model: z.string().optional(),
  max_input_tokens: z.number().positive().optional(),
});

export type LLMConfig = z.infer<typeof LLMConfigSchema>;

// ---------------------------------------------------------------------------
// External analyser — per-endpoint config (Phase 6)
//
// Phase 6 supports an arbitrary number of HTTP scoring endpoints, each
// optionally authenticated via Bearer API key or OAuth2 client_credentials
// grant.
// ---------------------------------------------------------------------------

const BearerAuthSchema = z.object({
  type:    z.literal('bearer'),
  api_key: z.string().min(1),
});

const OAuthAuthSchema = z.object({
  type:          z.literal('oauth'),
  oauth_url:     z.string().url(),       // base; runtime appends /token
  client_id:     z.string().min(1),      // pre-registered with the OAuth provider
  client_secret: z.string().min(1),      // required for the client_credentials grant
});

export const ExternalAnalyserAuthSchema =
  z.discriminatedUnion('type', [BearerAuthSchema, OAuthAuthSchema]);

export type ExternalAnalyserAuth = z.infer<typeof ExternalAnalyserAuthSchema>;

export const ExternalAnalyserEntrySchema = z.object({
  name:     z.string().min(1),
  enabled:  z.boolean().optional(),
  endpoint: z.string().min(1),
  /**
   * Custom request headers. Merged on top of nio's defaults (Authorization
   * from `auth`). User entries OVERRIDE nio's defaults — set Authorization
   * here only if you intentionally want to bypass `auth`.
   */
  headers:  z.record(z.string(), z.string()).optional(),
  timeout:  z.number().positive().optional(),
  weight:   z.number().nonnegative().optional(),
  auth:     ExternalAnalyserAuthSchema.optional(),
});

export type ExternalAnalyserEntry = z.infer<typeof ExternalAnalyserEntrySchema>;

export const GuardConfigSchema = z.object({
  protection_level: z.enum(['strict', 'balanced', 'permissive']).optional(),
  confirm_action: z.enum(['allow', 'deny', 'ask']).optional(),
  file_scan_rules: RulesPatternsSchema.optional(),
  action_guard_rules: GuardRulesSchema.optional(),
  llm_analyser: LLMConfigSchema.optional(),
  external_analyser: z.array(ExternalAnalyserEntrySchema)
    .refine(
      arr => new Set(arr.map(e => e.name)).size === arr.length,
      { message: 'external_analyser entries must have unique names' },
    )
    .optional(),
  allowed_commands: z.array(z.string()).optional(),
  allowlist_mode: z.enum(['exit', 'continue']).optional(),
  permitted_tools: z.record(z.string(), z.array(z.string())).optional(),
  blocked_tools: z.record(z.string(), z.array(z.string())).optional(),
  mcp_servers: z.record(z.string(), z.object({
    urls:        z.array(z.string()).optional(),
    sockets:     z.array(z.string()).optional(),
    binaries:    z.array(z.string()).optional(),
    cliPackages: z.array(z.string()).optional(),
  })).optional(),
  native_tool_mapping: z.record(
    z.string(),
    z.record(z.string(), z.enum(['exec_command', 'write_file', 'network_request', 'read_file'])),
  ).optional(),
  scoring_weights: z.object({
    runtime: z.number().optional(),
    static: z.number().optional(),
    behavioural: z.number().optional(),
    llm: z.number().optional(),
  }).optional(),
});

export type GuardConfig = z.infer<typeof GuardConfigSchema>;

// ---------------------------------------------------------------------------
// Root schema
// ---------------------------------------------------------------------------

export const NioConfigSchema = z.object({
  guard: GuardConfigSchema.optional(),
  collector: CollectorConfigSchema.optional(),
});

// ---------------------------------------------------------------------------
// Derived TypeScript types
// ---------------------------------------------------------------------------

export type CollectorConfig = z.infer<typeof CollectorConfigSchema>;
export type CollectorLogsConfig = z.infer<typeof CollectorLogsConfigSchema>;
export type CollectorMetricsConfig = z.infer<typeof CollectorMetricsConfigSchema>;
export type NioConfig = z.infer<typeof NioConfigSchema>;

/**
 * Resolved collector config with defaults applied. Used by the OTLP
 * exporter factories (metrics / traces / logs); does NOT carry any
 * audit-log path — that's owned by `CollectorLogsConfig.path`.
 */
export interface ResolvedMetricsConfig {
  endpoint: string;
  api_key: string;
  timeout: number;
  protocol: 'http' | 'grpc';
  /** OTLP export readiness — true iff endpoint is set. */
  enabled: boolean;
  /** Honors collector.metrics.enabled (default true). */
  metrics_enabled: boolean;
  /** Honors collector.traces.enabled (default true). */
  traces_enabled: boolean;
  /** Honors collector.logs.enabled (default true). */
  logs_enabled: boolean;
}


// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateConfig(data: unknown, source: string): NioConfig {
  const result = NioConfigSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid config (${source}):\n${issues}`);
  }
  return result.data;
}
