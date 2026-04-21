// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Decision — map final score to allow/deny/confirm per protection level.
 *
 * | Mode        | allow      | confirm    | deny       |
 * |-------------|------------|------------|------------|
 * | strict      | 0 — 0.5   | (none)     | 0.5 — 1.0  |
 * | balanced    | 0 — 0.5   | 0.5 — 0.8  | 0.8 — 1.0  |
 * | permissive  | 0 — 0.9   | (none)     | 0.9 — 1.0  |
 */

export type ProtectionLevel = 'strict' | 'balanced' | 'permissive';
export type GuardDecision = 'allow' | 'deny' | 'confirm';

interface ThresholdConfig {
  deny: number;
  warning?: number; // undefined = no confirm zone
}

const THRESHOLDS: Record<ProtectionLevel, ThresholdConfig> = {
  strict: { deny: 0.5 },
  balanced: { deny: 0.8, warning: 0.5 },
  permissive: { deny: 0.9 },
};

/**
 * Map a final score to a guard decision based on protection level.
 */
export function scoreToDecision(
  score: number,
  level: ProtectionLevel = 'balanced',
): GuardDecision {
  const t = THRESHOLDS[level] || THRESHOLDS.balanced;

  if (score >= t.deny) return 'deny';
  if (t.warning != null && score >= t.warning) return 'confirm';
  return 'allow';
}

/**
 * Check if a single-phase score should short-circuit the pipeline.
 * Uses the deny threshold of the current protection level.
 */
export function shouldShortCircuit(
  score: number,
  level: ProtectionLevel = 'balanced',
): boolean {
  const t = THRESHOLDS[level] || THRESHOLDS.balanced;
  return score >= t.deny;
}
