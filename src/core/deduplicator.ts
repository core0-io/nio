// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Finding deduplication.
 *
 * Removes duplicate findings that match on:
 *   - Same rule_id + same file + same line (exact)
 *   - Same rule_id + same file + lines within tolerance (near-duplicate)
 */

import type { Finding } from './models.js';
import { SEVERITY_WEIGHT } from './models.js';

/** Default line tolerance for near-duplicate detection. */
const LINE_TOLERANCE = 3;

/**
 * Deduplicate findings.  When two findings have the same rule_id and file,
 * and their lines are within `tolerance`, keep the one with higher severity
 * (or higher confidence as tiebreaker).
 */
export function deduplicateFindings(
  findings: Finding[],
  tolerance: number = LINE_TOLERANCE,
): Finding[] {
  if (findings.length <= 1) return findings;

  // Group by rule_id + file
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = `${f.rule_id}:${f.location.file}`;
    const group = groups.get(key) ?? [];
    group.push(f);
    groups.set(key, group);
  }

  const result: Finding[] = [];

  for (const group of groups.values()) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }

    // Sort by line number
    group.sort((a, b) => a.location.line - b.location.line);

    // Merge near-duplicates
    const merged: Finding[] = [group[0]];
    for (let i = 1; i < group.length; i++) {
      const current = group[i];
      const last = merged[merged.length - 1];

      if (Math.abs(current.location.line - last.location.line) <= tolerance) {
        // Near-duplicate — keep the one with higher severity/confidence
        if (
          SEVERITY_WEIGHT[current.severity] > SEVERITY_WEIGHT[last.severity] ||
          (SEVERITY_WEIGHT[current.severity] === SEVERITY_WEIGHT[last.severity] &&
            current.confidence > last.confidence)
        ) {
          merged[merged.length - 1] = current;
        }
        // else keep last (already in merged)
      } else {
        merged.push(current);
      }
    }

    result.push(...merged);
  }

  return result;
}
