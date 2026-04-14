/**
 * Scoring — convert Finding[] to a 0-1 score and aggregate weighted scores.
 *
 * Each phase produces Finding[], which are converted to a score using
 * severity weights and confidence. The final score is a weighted average
 * across all phases that ran.
 */

import type { Finding, Severity } from './models.js';
import { SEVERITY_WEIGHT } from './models.js';

// ── Phase Weights ───────────────────────────────────────────────────────

export interface PhaseWeights {
  runtime: number;     // Phase 2
  static: number;      // Phase 3
  behavioural: number;  // Phase 4
  llm: number;         // Phase 5
  external: number;    // Phase 6
}

export const DEFAULT_WEIGHTS: PhaseWeights = {
  runtime: 1.0,
  static: 1.0,
  behavioural: 2.0,
  llm: 1.0,
  external: 2.0,
};

// ── Score Labels ────────────────────────────────────────────────────────

export type ScoreLabel = keyof PhaseWeights;

// ── Score Conversion ────────────────────────────────────────────────────

/** Maximum severity weight (critical = 4). */
const MAX_SEVERITY = SEVERITY_WEIGHT['critical'];

/**
 * Convert Finding[] to a 0-1 score.
 *
 * Strategy: take the maximum severity×confidence across all findings,
 * normalized to [0, 1]. This gives a conservative score — a single
 * high-confidence critical finding yields ~1.0.
 */
export function findingsToScore(findings: Finding[]): number {
  if (findings.length === 0) return 0;

  let maxWeighted = 0;
  for (const f of findings) {
    const sevWeight = SEVERITY_WEIGHT[f.severity as Severity] || 0;
    const weighted = (sevWeight / MAX_SEVERITY) * (f.confidence ?? 1.0);
    if (weighted > maxWeighted) maxWeighted = weighted;
  }

  return Math.min(1.0, maxWeighted);
}

// ── Weighted Aggregation ────────────────────────────────────────────────

export interface PhaseScores {
  runtime?: number;
  static?: number;
  behavioural?: number;
  llm?: number;
  external?: number;
}

/**
 * Compute the weighted average of phase scores.
 *
 *   final_score = Σ(wi × si) / Σ(wi)   (only phases that ran)
 *
 * Returns 0 if no phases produced a score.
 */
export function aggregateScores(
  scores: PhaseScores,
  weights: PhaseWeights = DEFAULT_WEIGHTS,
): number {
  let numerator = 0;
  let denominator = 0;

  for (const key of Object.keys(weights) as ScoreLabel[]) {
    const score = scores[key];
    if (score != null) {
      const w = weights[key];
      numerator += w * score;
      denominator += w;
    }
  }

  if (denominator === 0) return 0;
  return numerator / denominator;
}
