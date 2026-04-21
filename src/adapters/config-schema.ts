import { z } from 'zod';

// ---------------------------------------------------------------------------
// Zod schemas — Collector (telemetry)
// ---------------------------------------------------------------------------

export const CollectorMetricsConfigSchema = z.object({
  enabled: z.boolean().optional(),
  local: z.boolean().optional(),
  log: z.string().optional(),
  max_size_mb: z.number().optional(),
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

export const ExternalAnalyserConfigSchema = z.object({
  enabled: z.boolean().optional(),
  endpoint: z.string().optional(),
  api_key: z.string().optional(),
  timeout: z.number().positive().optional(),
});

export const GuardConfigSchema = z.object({
  protection_level: z.enum(['strict', 'balanced', 'permissive']).optional(),
  confirm_action: z.enum(['allow', 'deny', 'ask']).optional(),
  file_scan_rules: RulesPatternsSchema.optional(),
  action_guard_rules: GuardRulesSchema.optional(),
  llm_analyser: LLMConfigSchema.optional(),
  external_analyser: ExternalAnalyserConfigSchema.optional(),
  allowed_commands: z.array(z.string()).optional(),
  allowlist_mode: z.enum(['exit', 'continue']).optional(),
  available_tools: z.record(z.string(), z.array(z.string())).optional(),
  blocked_tools: z.record(z.string(), z.array(z.string())).optional(),
  guarded_tools: z.record(
    z.string(),
    z.record(z.string(), z.enum(['exec_command', 'write_file', 'network_request', 'read_file'])),
  ).optional(),
  scoring_weights: z.object({
    runtime: z.number().optional(),
    static: z.number().optional(),
    behavioural: z.number().optional(),
    llm: z.number().optional(),
    external: z.number().optional(),
  }).optional(),
});

export type GuardConfig = z.infer<typeof GuardConfigSchema>;

// ---------------------------------------------------------------------------
// Root schema
// ---------------------------------------------------------------------------

export const AgentGuardConfigSchema = z.object({
  guard: GuardConfigSchema.optional(),
  collector: CollectorConfigSchema.optional(),
});

// ---------------------------------------------------------------------------
// Derived TypeScript types
// ---------------------------------------------------------------------------

export type CollectorConfig = z.infer<typeof CollectorConfigSchema>;
export type CollectorLogsConfig = z.infer<typeof CollectorLogsConfigSchema>;
export type CollectorMetricsConfig = z.infer<typeof CollectorMetricsConfigSchema>;
export type AgentGuardConfig = z.infer<typeof AgentGuardConfigSchema>;

/** Resolved metrics config with defaults applied. */
export interface ResolvedMetricsConfig {
  endpoint: string;
  api_key: string;
  timeout: number;
  log: string;
  protocol: 'http' | 'grpc';
  enabled: boolean;
}


// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateConfig(data: unknown, source: string): AgentGuardConfig {
  const result = AgentGuardConfigSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid config (${source}):\n${issues}`);
  }
  return result.data;
}
