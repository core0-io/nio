/**
 * ScanOrchestrator — the main analysis pipeline.
 *
 * Executes the two-phase analysis pipeline:
 *
 *   Phase 1 (parallel):   Static + Behavioral analyzers
 *   Phase 2 (sequential): LLM analyzer (enriched with Phase 1 findings)
 *   Post-processing:      Deduplication, severity filtering, sorting
 *
 * Returns an ExtendedScanResult that includes both structured `findings`
 * and the legacy `evidence` / `risk_tags` for backward compatibility.
 */

import type { AnalysisContext } from './analyzers/base.js';
import type { ScanPolicy } from './scan-policy.js';
import type { FileInfo } from '../scanner/file-walker.js';
import type { Finding, ExtendedScanResult, AnalyzerName } from './models.js';
import {
  aggregateRiskLevel,
  findingsToLegacy,
  generateSummary,
  sortFindings,
  SEVERITY_WEIGHT,
} from './models.js';
import type { Severity } from './models.js';
import { deduplicateFindings } from './deduplicator.js';
import { createAnalyzers, type AnalyzerFactoryOptions } from './analyzer-factory.js';
import { defaultPolicy } from './scan-policy.js';

// ── Orchestrator ─────────────────────────────────────────────────────────

export interface OrchestratorOptions extends AnalyzerFactoryOptions {
  policy?: ScanPolicy;
}

export class ScanOrchestrator {
  private policy: ScanPolicy;
  private factoryOpts: AnalyzerFactoryOptions;

  constructor(opts?: OrchestratorOptions) {
    this.policy = opts?.policy ?? defaultPolicy();
    this.factoryOpts = {
      registry: opts?.registry,
      llmApiKey: opts?.llmApiKey,
      llmModel: opts?.llmModel,
      llmMaxInputTokens: opts?.llmMaxInputTokens,
    };
  }

  /**
   * Run the full analysis pipeline on a set of files.
   */
  async run(rootDir: string, files: FileInfo[]): Promise<ExtendedScanResult> {
    const startTime = Date.now();
    const analyzersUsed: Set<AnalyzerName> = new Set();

    // Create analyzers based on policy
    const { phase1, phase2 } = createAnalyzers(this.policy, this.factoryOpts);

    // Build Phase 1 context (no prior findings)
    const ctx: AnalysisContext = {
      rootDir,
      files,
      policy: this.policy,
    };

    // ── Phase 1: Run analyzers in parallel ──────────────────────────
    const phase1Results = await Promise.all(
      phase1.map(async (analyzer) => {
        const findings = await analyzer.analyze(ctx);
        analyzersUsed.add(analyzer.name);
        return findings;
      }),
    );

    let allFindings: Finding[] = phase1Results.flat();

    // ── Phase 2: Run enriched analyzers sequentially ────────────────
    if (phase2.length > 0 && allFindings.length > 0) {
      const phase2Ctx: AnalysisContext = {
        ...ctx,
        priorFindings: allFindings,
      };

      for (const analyzer of phase2) {
        const findings = await analyzer.analyze(phase2Ctx);
        analyzersUsed.add(analyzer.name);
        allFindings = [...allFindings, ...findings];
      }
    }

    // ── Post-processing ─────────────────────────────────────────────

    // 1. Deduplicate
    allFindings = deduplicateFindings(allFindings);

    // 2. Filter by minimum severity
    allFindings = allFindings.filter(
      (f) => SEVERITY_WEIGHT[f.severity] >= SEVERITY_WEIGHT[this.policy.min_severity as Severity],
    );

    // 3. Sort (critical first, then by file+line)
    allFindings = sortFindings(allFindings);

    // 4. Project to legacy format
    const { risk_tags, evidence } = findingsToLegacy(allFindings);
    const riskLevel = aggregateRiskLevel(allFindings);

    return {
      risk_level: riskLevel,
      risk_tags,
      evidence,
      findings: allFindings,
      summary: generateSummary(allFindings),
      metadata: {
        files_scanned: files.length,
        scan_duration_ms: Date.now() - startTime,
        scan_time: new Date().toISOString(),
        analyzers_used: Array.from(analyzersUsed),
      },
    };
  }
}
