/**
 * Threat taxonomy mapping for LLM analyser output.
 *
 * Maps free-text threat descriptions from Claude to our structured
 * ThreatCategory and Severity types.
 */

import type { ThreatCategory, Severity } from '../../models.js';

/** An individual finding returned by the LLM. */
export interface LLMFinding {
  rule_id: string;
  category: string;
  severity: string;
  title: string;
  description: string;
  file: string;
  line: number;
  remediation?: string;
  is_false_positive?: boolean;
  /** IDs of Phase 1 findings this validates or refutes. */
  references?: string[];
}

/** The expected JSON schema of the LLM response. */
export interface LLMResponse {
  findings: LLMFinding[];
  false_positives: string[];  // IDs of Phase 1 findings deemed false positives
  summary: string;
}

// ── Category mapping ─────────────────────────────────────────────────────

const CATEGORY_MAP: Record<string, ThreatCategory> = {
  // Exact matches
  execution: 'execution',
  remote_loading: 'remote_loading',
  exfiltration: 'exfiltration',
  secrets: 'secrets',
  injection: 'injection',
  obfuscation: 'obfuscation',
  trojan: 'trojan',
  supply_chain: 'supply_chain',
  policy_violation: 'policy_violation',

  // Fuzzy matches from LLM output
  command_injection: 'execution',
  code_injection: 'execution',
  code_execution: 'execution',
  rce: 'execution',
  remote_code_execution: 'execution',
  shell_execution: 'execution',
  data_exfiltration: 'exfiltration',
  data_leak: 'exfiltration',
  information_disclosure: 'exfiltration',
  credential_theft: 'secrets',
  credential_access: 'secrets',
  secret_access: 'secrets',
  hardcoded_secret: 'secrets',
  prompt_injection: 'injection',
  jailbreak: 'injection',
  code_obfuscation: 'obfuscation',
  trojan_distribution: 'trojan',
  social_engineering: 'trojan',
  supply_chain_attack: 'supply_chain',
  dependency_confusion: 'supply_chain',
};

/** Map an LLM category string to our ThreatCategory. */
export function mapCategory(raw: string): ThreatCategory {
  const normalized = raw.toLowerCase().replace(/[\s-]/g, '_');
  return CATEGORY_MAP[normalized] ?? 'policy_violation';
}

// ── Severity mapping ─────────────────────────────────────────────────────

const SEVERITY_MAP: Record<string, Severity> = {
  info: 'info',
  informational: 'info',
  low: 'low',
  medium: 'medium',
  moderate: 'medium',
  high: 'high',
  critical: 'critical',
  severe: 'critical',
};

/** Map an LLM severity string to our Severity. */
export function mapSeverity(raw: string): Severity {
  return SEVERITY_MAP[raw.toLowerCase()] ?? 'medium';
}
