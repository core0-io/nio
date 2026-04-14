/**
 * Abstract base class for all analysers.
 *
 * Every analyser runs in either Phase 1 (parallel, no prior context) or
 * Phase 2 (sequential, enriched with Phase 1 findings).
 */

import type { Finding, AnalyserName } from '../models.js';
import type { ScanPolicy } from '../scan-policy.js';
import type { FileInfo } from '../../scanner/file-walker.js';

// ── Analysis context ─────────────────────────────────────────────────────

/**
 * Immutable context passed to every analyser.
 */
export interface AnalysisContext {
  /** Absolute path to the scan root directory. */
  rootDir: string;
  /** Pre-collected files (content already read). */
  files: FileInfo[];
  /** Active scan policy. */
  policy: ScanPolicy;
  /** Phase 1 findings — only populated for Phase 2 analysers. */
  priorFindings?: Finding[];
}

// ── Base analyser ────────────────────────────────────────────────────────

export abstract class BaseAnalyser {
  /** Human-readable analyser name (e.g. "static", "behavioural", "llm"). */
  abstract readonly name: AnalyserName;

  /** Execution phase: 1 = independent/parallel, 2 = enriched/sequential. */
  abstract readonly phase: 1 | 2;

  /**
   * Run the analysis and return findings.
   *
   * Implementations must be safe to call concurrently with other Phase 1
   * analysers — do not mutate shared state.
   */
  abstract analyze(ctx: AnalysisContext): Promise<Finding[]>;

  /**
   * Whether this analyser should run given the current policy.
   * Override to gate on config flags, API keys, etc.
   */
  isEnabled(_policy: ScanPolicy): boolean {
    return true;
  }
}
