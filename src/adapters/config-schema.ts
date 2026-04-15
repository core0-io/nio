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

export type RulesPatterns = z.infer<typeof RulesPatternsSchema>;

export const LLMConfigSchema = z.object({
  api_key: z.string().optional(),
  model: z.string().optional(),
  max_input_tokens: z.number().positive().optional(),
});

export type LLMConfig = z.infer<typeof LLMConfigSchema>;

export const ExternalScoringConfigSchema = z.object({
  endpoint: z.string().optional(),
  api_key: z.string().optional(),
  timeout: z.number().positive().optional(),
});

export const GuardConfigSchema = z.object({
  level: z.enum(['strict', 'balanced', 'permissive']).optional(),
  rules: RulesPatternsSchema.optional(),
  llm: LLMConfigSchema.optional(),
  external_scoring: ExternalScoringConfigSchema.optional(),
  allowed_commands: z.array(z.string()).optional(),
  available_tools: z.record(z.string(), z.array(z.string())).optional(),
  blocked_tools: z.record(z.string(), z.array(z.string())).optional(),
  guarded_tools: z.record(
    z.string(),
    z.record(z.string(), z.enum(['exec_command', 'write_file', 'network_request', 'read_file'])),
  ).optional(),
  weights: z.object({
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
// Backward compatibility — normalizeConfig
// ---------------------------------------------------------------------------

/**
 * Detect old-format config (top-level `level`, `llm`, `audit`, `rules`,
 * flat `guard.scoring_*`, flat `guard.guarded_tools`) and migrate to the
 * new nested structure before Zod validation.
 */
export function normalizeConfig(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const r = raw as Record<string, unknown>;

  // --- Top-level `level` → guard.level ---
  if (typeof r['level'] === 'string') {
    const guard = ensureObject(r, 'guard');
    if (!guard['level']) guard['level'] = r['level'];
    delete r['level'];
  }

  // --- Top-level `rules` → guard.rules ---
  if (r['rules'] && typeof r['rules'] === 'object') {
    const guard = ensureObject(r, 'guard');
    if (!guard['rules']) guard['rules'] = r['rules'];
    delete r['rules'];
  }

  // --- Top-level `llm` → guard.llm ---
  if (r['llm'] && typeof r['llm'] === 'object') {
    const guard = ensureObject(r, 'guard');
    if (!guard['llm']) guard['llm'] = r['llm'];
    delete r['llm'];
  }

  // --- Top-level `audit` → collector.logs ---
  if (r['audit'] && typeof r['audit'] === 'object') {
    const audit = r['audit'] as Record<string, unknown>;
    const collector = ensureObject(r, 'collector');
    const logs = ensureObject(collector, 'logs');
    if (audit['otel'] !== undefined && logs['enabled'] === undefined) logs['enabled'] = audit['otel'];
    if (audit['local'] !== undefined && logs['local'] === undefined) logs['local'] = audit['local'];
    if (audit['max_size_mb'] !== undefined && logs['max_size_mb'] === undefined) logs['max_size_mb'] = audit['max_size_mb'];
    delete r['audit'];
  }

  // --- collector.log → collector.metrics.log ---
  if (r['collector'] && typeof r['collector'] === 'object') {
    const collector = r['collector'] as Record<string, unknown>;
    if (typeof collector['log'] === 'string') {
      const metrics = ensureObject(collector, 'metrics');
      if (!metrics['log']) metrics['log'] = collector['log'];
      delete collector['log'];
    }
  }

  // --- guard.scoring_* → guard.external_scoring ---
  if (r['guard'] && typeof r['guard'] === 'object') {
    const guard = r['guard'] as Record<string, unknown>;
    if (guard['scoring_endpoint'] !== undefined || guard['scoring_api_key'] !== undefined || guard['scoring_timeout'] !== undefined) {
      const es = ensureObject(guard, 'external_scoring');
      if (guard['scoring_endpoint'] !== undefined && !es['endpoint']) { es['endpoint'] = guard['scoring_endpoint']; delete guard['scoring_endpoint']; }
      if (guard['scoring_api_key'] !== undefined && !es['api_key']) { es['api_key'] = guard['scoring_api_key']; delete guard['scoring_api_key']; }
      if (guard['scoring_timeout'] !== undefined && !es['timeout']) { es['timeout'] = guard['scoring_timeout']; delete guard['scoring_timeout']; }
    }

    // --- guard.extra_allowlist → guard.allowed_commands ---
    if (guard['extra_allowlist'] !== undefined && guard['allowed_commands'] === undefined) {
      guard['allowed_commands'] = guard['extra_allowlist'];
      delete guard['extra_allowlist'];
    }

    // --- flat available_tools [] → available_tools.claude_code ---
    if (Array.isArray(guard['available_tools'])) {
      guard['available_tools'] = { claude_code: guard['available_tools'] };
    }

    // --- flat blocked_tools [] → blocked_tools.claude_code ---
    if (Array.isArray(guard['blocked_tools'])) {
      guard['blocked_tools'] = { claude_code: guard['blocked_tools'] };
    }

    // --- flat guarded_tools → guarded_tools.claude_code ---
    if (guard['guarded_tools'] && typeof guard['guarded_tools'] === 'object') {
      const gt = guard['guarded_tools'] as Record<string, unknown>;
      // Detect flat format: if any value is a string (not an object), it's old format
      const firstValue = Object.values(gt)[0];
      if (typeof firstValue === 'string') {
        guard['guarded_tools'] = { claude_code: gt };
      }
    }
  }

  return r;
}

function ensureObject(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  if (!parent[key] || typeof parent[key] !== 'object') {
    parent[key] = {};
  }
  return parent[key] as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateConfig(data: unknown, source: string): AgentGuardConfig {
  const normalized = normalizeConfig(data);
  const result = AgentGuardConfigSchema.safeParse(normalized);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid config (${source}):\n${issues}`);
  }
  return result.data;
}
