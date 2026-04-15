import { z } from 'zod';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const MetricsConfigSchema = z.object({
  endpoint: z.string().optional(),
  api_key: z.string().optional(),
  timeout: z.number().positive().optional(),
  log: z.string().optional(),
  protocol: z.enum(['http', 'grpc']).optional(),
});

const RulesPatternsSchema = z.object({
  shell_exec:       z.array(z.string()).optional(),
  remote_loader:    z.array(z.string()).optional(),
  secrets:          z.array(z.string()).optional(),
  obfuscation:      z.array(z.string()).optional(),
  prompt_injection: z.array(z.string()).optional(),
  exfiltration:     z.array(z.string()).optional(),
  trojan:           z.array(z.string()).optional(),
});

export type RulesPatterns = z.infer<typeof RulesPatternsSchema>;

export const LLMConfigSchema = z.object({
  /** Anthropic API key for the LLM analyser. */
  api_key: z.string().optional(),
  /** Model identifier (e.g. "claude-sonnet-4-20250514"). */
  model: z.string().optional(),
  /** Maximum input token budget for LLM analysis. */
  max_input_tokens: z.number().positive().optional(),
});

export type LLMConfig = z.infer<typeof LLMConfigSchema>;

export const GuardConfigSchema = z.object({
  /** External scoring endpoint URL. */
  scoring_endpoint: z.string().optional(),
  /** External scoring timeout in ms. */
  scoring_timeout: z.number().positive().optional(),
  /** API key for external scoring endpoint. */
  scoring_api_key: z.string().optional(),
  /** User-injected safe command prefixes for the allowlist. */
  extra_allowlist: z.array(z.string()).optional(),
  /** Tool-level allowlist (Phase 0). When non-empty, only listed tools are available. */
  available_tools: z.array(z.string()).optional(),
  /** Tool-level denylist (Phase 0). Listed tools are unconditionally blocked. */
  blocked_tools: z.array(z.string()).optional(),
  /** Tool → action type mapping. Tools listed here enter Phase 1-6 deep analysis. */
  guarded_tools: z.record(z.string(), z.enum(['exec_command', 'write_file', 'network_request'])).optional(),
  /** Phase weights for score aggregation. */
  weights: z.object({
    runtime: z.number().optional(),
    static: z.number().optional(),
    behavioural: z.number().optional(),
    llm: z.number().optional(),
    external: z.number().optional(),
  }).optional(),
});

export type GuardConfig = z.infer<typeof GuardConfigSchema>;

export const AuditConfigSchema = z.object({
  /** Enable local JSONL audit log at ~/.ffwd-agent-guard/audit.jsonl */
  local: z.boolean().optional(),
  /** Maximum local log file size in MB before rotation (0 = no rotation) */
  max_size_mb: z.number().optional(),
  /** Enable OTEL Logs export (uses collector endpoint/api_key/protocol) */
  otel: z.boolean().optional(),
});

export type AuditConfig = z.infer<typeof AuditConfigSchema>;

export const AgentGuardConfigSchema = z.object({
  level: z.enum(['strict', 'balanced', 'permissive']),
  collector: MetricsConfigSchema.optional(),
  audit: AuditConfigSchema.optional(),
  rules: RulesPatternsSchema.optional(),
  llm: LLMConfigSchema.optional(),
  guard: GuardConfigSchema.optional(),
});

// ---------------------------------------------------------------------------
// Derived TypeScript types
// ---------------------------------------------------------------------------

export type MetricsConfig = z.infer<typeof MetricsConfigSchema>;
export type AgentGuardConfig = z.infer<typeof AgentGuardConfigSchema>;

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
