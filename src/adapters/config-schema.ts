import { z } from 'zod';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const MetricsConfigSchema = z.object({
  endpoint: z.string().optional(),
  api_key: z.string().optional(),
  timeout: z.number().positive().optional(),
  log: z.string().optional(),
});

export const AgentGuardConfigSchema = z.object({
  level: z.enum(['strict', 'balanced', 'permissive']),
  auto_scan: z.boolean().optional(),
  metrics: MetricsConfigSchema.optional(),
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
