/**
 * Scan policy — controls which analyzers run, severity thresholds, and
 * rule-level overrides.
 *
 * Three built-in presets: strict, balanced, permissive.
 * Users can also supply custom YAML that deep-merges over a base preset.
 */

import type { Severity } from './models.js';

// ── Policy types ─────────────────────────────────────────────────────────

export interface AnalyzerFlags {
  /** Enable/disable the static (regex) analyzer. Default: true. */
  static: boolean;
  /** Enable/disable the behavioral (AST + dataflow) analyzer. Default: true. */
  behavioral: boolean;
  /** Enable/disable the LLM (semantic) analyzer. Default: false. */
  llm: boolean;
}

export interface SeverityOverride {
  /** Rule ID to override. */
  rule_id: string;
  /** New severity. */
  severity: Severity;
}

export interface RuleScoping {
  /** Rule IDs to disable entirely. */
  disabled_rules: string[];
  /** Per-rule severity overrides. */
  severity_overrides: SeverityOverride[];
}

export interface ScanPolicy {
  /** Which analyzers are active. */
  analyzers: AnalyzerFlags;
  /** Minimum severity to include in results (findings below are dropped). */
  min_severity: Severity;
  /** Rule-level knobs. */
  rules: RuleScoping;
  /** Extra regex patterns injected into static analyzer rule modules. */
  extra_patterns: Partial<Record<string, string[]>>;
}

// ── Presets ──────────────────────────────────────────────────────────────

const BASE: ScanPolicy = {
  analyzers: { static: true, behavioral: true, llm: false },
  min_severity: 'low',
  rules: { disabled_rules: [], severity_overrides: [] },
  extra_patterns: {},
};

export const POLICY_PRESETS: Record<string, ScanPolicy> = {
  strict: {
    ...BASE,
    analyzers: { static: true, behavioral: true, llm: true },
    min_severity: 'info',
  },
  balanced: {
    ...BASE,
  },
  permissive: {
    ...BASE,
    analyzers: { static: true, behavioral: false, llm: false },
    min_severity: 'medium',
  },
};

/** Return the default (balanced) policy. */
export function defaultPolicy(): ScanPolicy {
  return { ...POLICY_PRESETS.balanced };
}

/** Load a preset by name, falling back to balanced. */
export function policyFromPreset(name: string): ScanPolicy {
  const preset = POLICY_PRESETS[name];
  if (!preset) return defaultPolicy();
  return { ...preset };
}

/**
 * Deep-merge a partial user policy over a base.  Only defined keys win.
 */
export function mergePolicy(
  base: ScanPolicy,
  overrides: Partial<ScanPolicy>,
): ScanPolicy {
  return {
    analyzers: { ...base.analyzers, ...overrides.analyzers },
    min_severity: overrides.min_severity ?? base.min_severity,
    rules: {
      disabled_rules: [
        ...base.rules.disabled_rules,
        ...(overrides.rules?.disabled_rules ?? []),
      ],
      severity_overrides: [
        ...base.rules.severity_overrides,
        ...(overrides.rules?.severity_overrides ?? []),
      ],
    },
    extra_patterns: {
      ...base.extra_patterns,
      ...overrides.extra_patterns,
    },
  };
}
