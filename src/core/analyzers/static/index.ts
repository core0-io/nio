/**
 * Static Analyzer — Phase 1 deterministic detection engine.
 *
 * Runs multiple detection passes over collected files using regex-based
 * rules from the RuleRegistry.  This is the TypeScript equivalent of
 * Cisco skill-scanner's StaticAnalyzer with its 14-pass architecture,
 * adapted to our rule set.
 *
 * Detection passes:
 *   1. Pattern matching  — regex rules against file content
 *   2. Base64 decoding   — extract and re-scan encoded payloads
 *   3. Markdown extraction — only scan fenced code blocks in .md files
 */

import { BaseAnalyzer, type AnalysisContext } from '../base.js';
import type { Finding, AnalyzerName } from '../../models.js';
import { findingId, riskTagToCategory } from '../../models.js';
import { RuleRegistry, ruleRegistry } from '../../rule-registry.js';
import type { ScanRule, RiskTag } from '../../../types/scanner.js';
import type { FileInfo } from '../../../scanner/file-walker.js';

// ── Static Analyzer ──────────────────────────────────────────────────────

export class StaticAnalyzer extends BaseAnalyzer {
  readonly name: AnalyzerName = 'static';
  readonly phase: 1 = 1;

  private registry: RuleRegistry;

  constructor(registry?: RuleRegistry) {
    super();
    this.registry = registry ?? ruleRegistry;
  }

  async analyze(ctx: AnalysisContext): Promise<Finding[]> {
    const findings: Finding[] = [];

    for (const file of ctx.files) {
      // Get applicable rules for this file type
      const rules = this.registry.getRulesForExtension(
        file.extension,
        ctx.policy.extra_patterns,
      );

      // Filter out disabled rules
      const activeRules = rules.filter(
        (r) => !ctx.policy.rules.disabled_rules.includes(r.id),
      );

      // Pass 1: Pattern matching
      // For Markdown: only scan inside fenced code blocks
      const contentToScan = file.extension === '.md'
        ? extractMarkdownCodeBlocks(file.content)
        : file.content;

      this.runPatternPass(contentToScan, activeRules, file.relativePath, findings);

      // Pass 2: Base64 decoding — extract encoded payloads and re-scan
      const decodedPayloads = extractAndDecodeBase64(file.content);
      if (decodedPayloads.length > 0) {
        // Re-scan decoded content against ALL rules (not just extension-matched)
        const allRules = this.registry.allRules().filter(
          (r) => !ctx.policy.rules.disabled_rules.includes(r.id),
        );
        for (const decoded of decodedPayloads) {
          this.runPatternPass(decoded, allRules, file.relativePath, findings, 'decoded_from:base64');
        }
      }
    }

    // Apply severity overrides from policy
    for (const f of findings) {
      const override = ctx.policy.rules.severity_overrides.find(
        (o) => o.rule_id === f.rule_id,
      );
      if (override) {
        f.severity = override.severity;
      }
    }

    return findings;
  }

  /**
   * Run regex patterns against content and collect findings.
   */
  private runPatternPass(
    content: string,
    rules: ScanRule[],
    filePath: string,
    findings: Finding[],
    context?: string,
  ): void {
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

          const meta = this.registry.getMeta(rule.id);
          const finding: Finding = {
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
            analyzer: 'static',
            confidence: 1.0, // regex matches are deterministic
            metadata: context ? { context } : undefined,
          };

          findings.push(finding);
        }
      }
    }
  }
}

// ── Helper functions (extracted from SkillScanner) ───────────────────────

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
