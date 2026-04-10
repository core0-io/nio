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
  /** Anthropic API key for the LLM analyzer. */
  api_key: z.string().optional(),
  /** Model identifier (e.g. "claude-sonnet-4-20250514"). */
  model: z.string().optional(),
  /** Maximum input token budget for LLM analysis. */
  max_input_tokens: z.number().positive().optional(),
});

export type LLMConfig = z.infer<typeof LLMConfigSchema>;

export const AgentGuardConfigSchema = z.object({
  level: z.enum(['strict', 'balanced', 'permissive']),
  auto_scan: z.boolean().optional(),
  collector: MetricsConfigSchema.optional(),
  rules: RulesPatternsSchema.optional(),
  llm: LLMConfigSchema.optional(),
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
