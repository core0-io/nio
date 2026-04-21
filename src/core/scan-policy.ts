// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Scan policy — controls which analysers run, severity thresholds, and
 * rule-level overrides.
 *
 * Three built-in presets: strict, balanced, permissive.
 * Users can also supply custom YAML that deep-merges over a base preset.
 */

import type { Severity } from './models.js';

// ── Policy types ─────────────────────────────────────────────────────────

export interface AnalyserFlags {
  /** Enable/disable the static (regex) analyser. Default: true. */
  static: boolean;
  /** Enable/disable the behavioural (AST + dataflow) analyser. Default: true. */
  behavioural: boolean;
  /** Enable/disable the LLM (semantic) analyser. Default: false. */
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
  /** Which analysers are active. */
  analysers: AnalyserFlags;
  /** Minimum severity to include in results (findings below are dropped). */
  min_severity: Severity;
  /** Rule-level knobs. */
  rules: RuleScoping;
  /** Extra regex patterns injected into static analyser rule modules. */
  extra_patterns: Partial<Record<string, string[]>>;
}

// ── Presets ──────────────────────────────────────────────────────────────

const BASE: ScanPolicy = {
  analysers: { static: true, behavioural: true, llm: false },
  min_severity: 'low',
  rules: { disabled_rules: [], severity_overrides: [] },
  extra_patterns: {},
};

export const POLICY_PRESETS: Record<string, ScanPolicy> = {
  strict: {
    ...BASE,
    analysers: { static: true, behavioural: true, llm: true },
    min_severity: 'info',
  },
  balanced: {
    ...BASE,
  },
  permissive: {
    ...BASE,
    analysers: { static: true, behavioural: false, llm: false },
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
    analysers: { ...base.analysers, ...overrides.analysers },
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
