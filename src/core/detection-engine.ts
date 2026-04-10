/**
 * Detection Engine — shared pure functions for regex-based pattern matching.
 *
 * Extracted from StaticAnalyzer.runPatternPass() so both the static scan
 * pipeline and the dynamic guard (RuntimeAnalyzer) can reuse the same logic.
 *
 * Pure functions — no class state, no side effects.
 */

import type { ScanRule, RiskTag } from '../types/scanner.js';
import type { Finding, AnalyzerName } from './models.js';
import { findingId, riskTagToCategory } from './models.js';
import { RuleRegistry } from './rule-registry.js';

// ── Pattern Matching ────────────────────────────────────────────────────

/**
 * Run regex rules against content and return findings.
 *
 * This is the core detection loop shared by StaticAnalyzer (scan) and
 * RuntimeAnalyzer (guard). Each rule's patterns are tested line-by-line.
 */
export function runRules(
  content: string,
  rules: ScanRule[],
  filePath: string,
  analyzer: AnalyzerName,
  registry?: RuleRegistry,
  context?: string,
): Finding[] {
  const findings: Finding[] = [];
  const lines = content.split('\n');

  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const match = line.match(pattern);
        if (!match) continue;

        // Run validator if present
        if (rule.validator && !rule.validator(content, match)) {
          continue;
        }

        const meta = registry?.getMeta(rule.id);
        findings.push({
          id: findingId(rule.id, filePath, i + 1),
          rule_id: rule.id,
          category: riskTagToCategory(rule.id as RiskTag),
          severity: rule.severity === 'low' ? 'low'
            : rule.severity === 'medium' ? 'medium'
            : rule.severity === 'high' ? 'high'
            : 'critical',
          title: meta?.title ?? rule.description,
          description: rule.description,
          location: {
            file: filePath,
            line: i + 1,
            snippet: match[0].slice(0, 200),
          },
          remediation: meta?.remediation,
          analyzer,
          confidence: 1.0, // regex matches are deterministic
          metadata: context ? { context } : undefined,
        });
      }
    }
  }

  return findings;
}

// ── Base64 Decoding ─────────────────────────────────────────────────────

/**
 * Extract and decode base64 strings from content.
 * Returns decoded strings that look like text (for re-scanning).
 */
export function extractAndDecodeBase64(content: string): string[] {
  const decoded: string[] = [];
  const b64Regex = /(?:['"`]|base64[,\s]+)([A-Za-z0-9+/]{20,}={0,2})(?:['"`]|\s|$)/g;
  let m: RegExpExecArray | null;

  while ((m = b64Regex.exec(content)) !== null) {
    try {
      const text = Buffer.from(m[1], 'base64').toString('utf-8');
      // Only keep if decoded result looks like text (not binary)
      if (/^[\x20-\x7e\t\r\n]+$/.test(text) && text.length > 5) {
        decoded.push(text);
      }
    } catch {
      // invalid base64 — skip
    }
  }
  return decoded;
}

/**
 * Run base64 decode pass: extract encoded payloads from content, decode them,
 * then run rules against the decoded content.
 */
export function runBase64Pass(
  content: string,
  rules: ScanRule[],
  filePath: string,
  analyzer: AnalyzerName,
  registry?: RuleRegistry,
): Finding[] {
  const decodedPayloads = extractAndDecodeBase64(content);
  if (decodedPayloads.length === 0) return [];

  const findings: Finding[] = [];
  for (const decoded of decodedPayloads) {
    findings.push(...runRules(decoded, rules, filePath, analyzer, registry, 'decoded_from:base64'));
  }
  return findings;
}

// ── Markdown Extraction ─────────────────────────────────────────────────

/**
 * Extract fenced code blocks from Markdown content.
 * Returns content with non-code lines blanked to preserve line numbers.
 */
export function extractMarkdownCodeBlocks(content: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let inBlock = false;

  for (const line of lines) {
    if (/^```/.test(line)) {
      inBlock = !inBlock;
      result.push(''); // keep line count aligned
    } else if (inBlock) {
      result.push(line);
    } else {
      result.push(''); // outside code block: blank line to preserve numbering
    }
  }
  return result.join('\n');
}
