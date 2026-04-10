/**
 * Analyzer factory — creates analyzer instances from a ScanPolicy.
 */

import type { BaseAnalyzer } from './analyzers/base.js';
import type { ScanPolicy } from './scan-policy.js';
import { StaticAnalyzer } from './analyzers/static/index.js';
import { BehavioralAnalyzer } from './analyzers/behavioral/index.js';
import { LLMAnalyzer } from './analyzers/llm/index.js';
import { RuleRegistry, ruleRegistry } from './rule-registry.js';

export interface AnalyzerFactoryOptions {
  registry?: RuleRegistry;
  llmApiKey?: string;
  llmModel?: string;
  llmMaxInputTokens?: number;
}

/**
 * Build the analyzer set for a given policy.
 * Returns Phase 1 and Phase 2 analyzers separately.
 */
export function createAnalyzers(
  policy: ScanPolicy,
  opts?: AnalyzerFactoryOptions,
): {
  phase1: BaseAnalyzer[];
  phase2: BaseAnalyzer[];
} {
  const registry = opts?.registry ?? ruleRegistry;
  const phase1: BaseAnalyzer[] = [];
  const phase2: BaseAnalyzer[] = [];

  // Phase 1 analyzers
  const staticAnalyzer = new StaticAnalyzer(registry);
  if (staticAnalyzer.isEnabled(policy)) {
    phase1.push(staticAnalyzer);
  }

  const behavioralAnalyzer = new BehavioralAnalyzer();
  if (behavioralAnalyzer.isEnabled(policy)) {
    phase1.push(behavioralAnalyzer);
  }

  // Phase 2 analyzers
  const llmAnalyzer = new LLMAnalyzer({
    apiKey: opts?.llmApiKey,
    model: opts?.llmModel,
    maxInputTokens: opts?.llmMaxInputTokens,
  });
  if (llmAnalyzer.isEnabled(policy)) {
    phase2.push(llmAnalyzer);
  }

  return { phase1, phase2 };
}
