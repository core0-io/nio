/**
 * Core models for the three-analyzer architecture.
 *
 * These types form the shared language between Static, Behavioral, and LLM
 * analyzers.  The `Finding` model is the primary output unit — every analyzer
 * produces an array of findings that the orchestrator merges, deduplicates,
 * and projects into the legacy `ScanResult` format.
 */

import * as crypto from 'crypto';
import type { RiskLevel, RiskTag, ScanEvidence, ScanResult } from '../types/scanner.js';

// ── Enums ────────────────────────────────────────────────────────────────

/**
 * Severity levels (ordered low → critical).
 */
export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

/** Numeric weight for each severity — useful for sorting and aggregation. */
export const SEVERITY_WEIGHT: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/**
 * Broad threat categories aligned with the Cisco AITech taxonomy.
 */
export type ThreatCategory =
  | 'execution'         // shell exec, eval, spawn
  | 'remote_loading'    // dynamic import, fetch+eval
  | 'exfiltration'      // data leaving the system
  | 'secrets'           // secret access or hard-coded credentials
  | 'injection'         // prompt injection
  | 'obfuscation'       // intentionally hidden logic
  | 'trojan'            // trojan distribution / social engineering
  | 'supply_chain'      // dependency / auto-update risks
  | 'policy_violation'; // capability or trust violations

// ── Finding ──────────────────────────────────────────────────────────────

/** Where in source a finding was detected. */
export interface FindingLocation {
  /** File path relative to the scan root. */
  file: string;
  /** 1-indexed line number. */
  line: number;
  /** 0-indexed column (optional). */
  column?: number;
  /** Source snippet around the match (max 200 chars). */
  snippet?: string;
}

/** Which analyzer produced this finding. */
export type AnalyzerName = 'static' | 'behavioral' | 'llm';

/**
 * A single security finding — the primary output of every analyzer.
 */
export interface Finding {
  /** Deterministic ID: sha256(rule_id + file + line). */
  id: string;
  /** Rule that triggered this finding (e.g. "SHELL_EXEC"). */
  rule_id: string;
  /** Broad threat category. */
  category: ThreatCategory;
  /** Severity level. */
  severity: Severity;
  /** Short human-readable title from the rule metadata. */
  title: string;
  /** Longer description of what was found. */
  description: string;
  /** Source location. */
  location: FindingLocation;
  /** Suggested remediation (optional). */
  remediation?: string;
  /** Analyzer that produced this finding. */
  analyzer: AnalyzerName;
  /** Confidence score 0.0–1.0 (1.0 = deterministic match). */
  confidence: number;
  /** Arbitrary metadata (e.g. decoded payload, dataflow path). */
  metadata?: Record<string, unknown>;
}

// ── Scan metadata ────────────────────────────────────────────────────────

export interface ScanMetadata {
  files_scanned: number;
  scan_duration_ms: number;
  scan_time: string;
  analyzers_used: AnalyzerName[];
}

/**
 * Extended scan result that includes structured `findings` alongside the
 * legacy `evidence` / `risk_tags` fields for backward compatibility.
 */
export interface ExtendedScanResult extends ScanResult {
  /** Structured findings from all analyzers. */
  findings: Finding[];
  /** Extended metadata. */
  metadata: ScanMetadata;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Generate a deterministic finding ID. */
export function findingId(ruleId: string, file: string, line: number): string {
  const hash = crypto.createHash('sha256');
  hash.update(`${ruleId}:${file}:${line}`);
  return hash.digest('hex').slice(0, 16);
}

/** Map a `Severity` to the legacy `RiskLevel` type. */
export function severityToRiskLevel(s: Severity): RiskLevel {
  if (s === 'info') return 'low';
  return s as RiskLevel;
}

/** Determine the highest risk level across a set of findings. */
export function aggregateRiskLevel(findings: Finding[]): RiskLevel {
  let max: Severity = 'info';
  for (const f of findings) {
    if (SEVERITY_WEIGHT[f.severity] > SEVERITY_WEIGHT[max]) {
      max = f.severity;
    }
  }
  return severityToRiskLevel(max);
}

/** Map RiskTag → ThreatCategory. */
export function riskTagToCategory(tag: RiskTag): ThreatCategory {
  const map: Record<RiskTag, ThreatCategory> = {
    SHELL_EXEC: 'execution',
    REMOTE_LOADER: 'remote_loading',
    AUTO_UPDATE: 'supply_chain',
    READ_ENV_SECRETS: 'secrets',
    READ_SSH_KEYS: 'secrets',
    READ_KEYCHAIN: 'secrets',
    PRIVATE_KEY_PATTERN: 'secrets',
    NET_EXFIL_UNRESTRICTED: 'exfiltration',
    WEBHOOK_EXFIL: 'exfiltration',
    OBFUSCATION: 'obfuscation',
    PROMPT_INJECTION: 'injection',
    TROJAN_DISTRIBUTION: 'trojan',
    SUSPICIOUS_PASTE_URL: 'trojan',
    SUSPICIOUS_IP: 'trojan',
    SOCIAL_ENGINEERING: 'trojan',
  };
  return map[tag] ?? 'policy_violation';
}

/**
 * Project an array of `Finding` objects back to the legacy
 * `ScanEvidence[]` + `RiskTag[]` format used by existing consumers.
 */
export function findingsToLegacy(findings: Finding[]): {
  risk_tags: RiskTag[];
  evidence: ScanEvidence[];
} {
  const tagSet = new Set<RiskTag>();
  const evidence: ScanEvidence[] = [];

  for (const f of findings) {
    const tag = f.rule_id as RiskTag;
    tagSet.add(tag);
    evidence.push({
      tag,
      file: f.location.file,
      line: f.location.line,
      match: f.location.snippet?.slice(0, 100) ?? f.description.slice(0, 100),
      context: f.metadata?.context as string | undefined,
    });
  }

  return {
    risk_tags: Array.from(tagSet),
    evidence,
  };
}

/** Sort findings by severity (critical first), then by file+line. */
export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const sevDiff = SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity];
    if (sevDiff !== 0) return sevDiff;
    const fileCmp = a.location.file.localeCompare(b.location.file);
    if (fileCmp !== 0) return fileCmp;
    return a.location.line - b.location.line;
  });
}

/** Generate a human-readable summary from findings. */
export function generateSummary(findings: Finding[]): string {
  if (findings.length === 0) {
    return 'No security issues detected';
  }

  const categories = new Set(findings.map((f) => f.category));
  const parts: string[] = [];

  if (categories.has('execution') || categories.has('remote_loading')) {
    parts.push('code execution capabilities');
  }
  if (categories.has('secrets')) {
    parts.push('hardcoded secrets or credential access');
  }
  if (categories.has('injection')) {
    parts.push('prompt injection attempts');
  }
  if (categories.has('exfiltration')) {
    parts.push('data exfiltration risks');
  }
  if (categories.has('obfuscation')) {
    parts.push('obfuscated code');
  }
  if (categories.has('trojan') || categories.has('supply_chain')) {
    parts.push('trojan/supply-chain risks');
  }

  return `Found ${findings.length} findings: ${parts.join(', ') || 'various security concerns'}`;
}
