// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Analyser factory — creates analyser instances from a ScanPolicy.
 */

import type { BaseAnalyser } from './analysers/base.js';
import type { ScanPolicy } from './scan-policy.js';
import { StaticAnalyser } from './analysers/static/index.js';
import { BehaviouralAnalyser } from './analysers/behavioural/index.js';
import { LLMAnalyser } from './analysers/llm/index.js';
import { RuleRegistry, ruleRegistry } from './rule-registry.js';

export interface AnalyserFactoryOptions {
  registry?: RuleRegistry;
  llmApiKey?: string;
  llmModel?: string;
  llmMaxInputTokens?: number;
}

/**
 * Build the analyser set for a given policy.
 * Returns Phase 1 and Phase 2 analysers separately.
 */
export function createAnalysers(
  policy: ScanPolicy,
  opts?: AnalyserFactoryOptions,
): {
  phase1: BaseAnalyser[];
  phase2: BaseAnalyser[];
} {
  const registry = opts?.registry ?? ruleRegistry;
  const phase1: BaseAnalyser[] = [];
  const phase2: BaseAnalyser[] = [];

  // Phase 1 analysers
  const staticAnalyser = new StaticAnalyser(registry);
  if (staticAnalyser.isEnabled(policy)) {
    phase1.push(staticAnalyser);
  }

  const behaviouralAnalyser = new BehaviouralAnalyser();
  if (behaviouralAnalyser.isEnabled(policy)) {
    phase1.push(behaviouralAnalyser);
  }

  // Phase 2 analysers
  const llmAnalyser = new LLMAnalyser({
    apiKey: opts?.llmApiKey,
    model: opts?.llmModel,
    maxInputTokens: opts?.llmMaxInputTokens,
  });
  if (llmAnalyser.isEnabled(policy)) {
    phase2.push(llmAnalyser);
  }

  return { phase1, phase2 };
}
