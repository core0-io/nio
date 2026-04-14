/**
 * Static Analyser — Phase 1 deterministic detection engine.
 *
 * Runs multiple detection passes over collected files using regex-based
 * rules from the RuleRegistry.  This is the TypeScript equivalent of
 * Cisco skill-scanner's StaticAnalyser with its 14-pass architecture,
 * adapted to our rule set.
 *
 * Detection passes:
 *   1. Pattern matching  — regex rules against file content
 *   2. Base64 decoding   — extract and re-scan encoded payloads
 *   3. Markdown extraction — only scan fenced code blocks in .md files
 *
 * The actual matching logic lives in `detection-engine.ts` so it can be
 * reused by the RuntimeAnalyser (dynamic guard).
 */

import { BaseAnalyser, type AnalysisContext } from '../base.js';
import type { Finding, AnalyserName } from '../../models.js';
import { RuleRegistry, ruleRegistry } from '../../rule-registry.js';
import {
  runRules,
  runBase64Pass,
  extractMarkdownCodeBlocks,
} from '../../detection-engine.js';

// ── Static Analyser ──────────────────────────────────────────────────────

export class StaticAnalyser extends BaseAnalyser {
  readonly name: AnalyserName = 'static';
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

      findings.push(
        ...runRules(contentToScan, activeRules, file.relativePath, 'static', this.registry),
      );

      // Pass 2: Base64 decoding — extract encoded payloads and re-scan
      const allRules = this.registry.allRules().filter(
        (r) => !ctx.policy.rules.disabled_rules.includes(r.id),
      );
      findings.push(
        ...runBase64Pass(file.content, allRules, file.relativePath, 'static', this.registry),
      );
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
}

// Re-export helpers for backward compatibility (tests may import from here)
export { extractMarkdownCodeBlocks, extractAndDecodeBase64 } from '../../detection-engine.js';
