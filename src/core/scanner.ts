// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * ScanOrchestrator — the main analysis pipeline.
 *
 * Executes the two-phase analysis pipeline:
 *
 *   Phase 1 (parallel):   Static + Behavioural analysers
 *   Phase 2 (sequential): LLM analyser (enriched with Phase 1 findings)
 *   Post-processing:      Deduplication, severity filtering, sorting
 *
 * Returns an ExtendedScanResult that includes both structured `findings`
 * and the legacy `evidence` / `risk_tags` for backward compatibility.
 */

import type { AnalysisContext } from './analysers/base.js';
import type { ScanPolicy } from './scan-policy.js';
import type { FileInfo } from '../scanner/file-walker.js';
import type { Finding, ExtendedScanResult, AnalyserName } from './models.js';
import {
  aggregateRiskLevel,
  findingsToLegacy,
  generateSummary,
  sortFindings,
  SEVERITY_WEIGHT,
} from './models.js';
import type { Severity } from './models.js';
import { deduplicateFindings } from './deduplicator.js';
import { createAnalysers, type AnalyserFactoryOptions } from './analyser-factory.js';
import { defaultPolicy } from './scan-policy.js';
import { ScanCache } from './scan-cache.js';

// ── Orchestrator ─────────────────────────────────────────────────────────

export interface OrchestratorOptions extends AnalyserFactoryOptions {
  policy?: ScanPolicy;
  /** Optional scan cache instance for persisting results */
  scanCache?: ScanCache;
}

export class ScanOrchestrator {
  private policy: ScanPolicy;
  private factoryOpts: AnalyserFactoryOptions;
  private scanCache?: ScanCache;

  constructor(opts?: OrchestratorOptions) {
    this.policy = opts?.policy ?? defaultPolicy();
    this.scanCache = opts?.scanCache;
    this.factoryOpts = {
      registry: opts?.registry,
      llmApiKey: opts?.llmApiKey,
      llmModel: opts?.llmModel,
      llmMaxInputTokens: opts?.llmMaxInputTokens,
    };
  }

  /**
   * Run the full analysis pipeline on a set of files.
   * @param rootDir  Root directory being scanned
   * @param files    Pre-collected files with content
   * @param skillId  Optional skill identifier — when provided, results are cached
   * @param artifactHash  Optional artifact hash for cache staleness detection
   */
  async run(
    rootDir: string,
    files: FileInfo[],
    skillId?: string,
    artifactHash?: string,
  ): Promise<ExtendedScanResult> {
    const startTime = Date.now();
    const analysersUsed: Set<AnalyserName> = new Set();

    // Create analysers based on policy
    const { phase1, phase2 } = createAnalysers(this.policy, this.factoryOpts);

    // Build Phase 1 context (no prior findings)
    const ctx: AnalysisContext = {
      rootDir,
      files,
      policy: this.policy,
    };

    // ── Phase 1: Run analysers in parallel ──────────────────────────
    const phase1Results = await Promise.all(
      phase1.map(async (analyser) => {
        const findings = await analyser.analyze(ctx);
        analysersUsed.add(analyser.name);
        return findings;
      }),
    );

    let allFindings: Finding[] = phase1Results.flat();

    // ── Phase 2: Run enriched analysers sequentially ────────────────
    if (phase2.length > 0 && allFindings.length > 0) {
      const phase2Ctx: AnalysisContext = {
        ...ctx,
        priorFindings: allFindings,
      };

      for (const analyser of phase2) {
        const findings = await analyser.analyze(phase2Ctx);
        analysersUsed.add(analyser.name);
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

    const scanTime = new Date().toISOString();

    // Write to scan cache if a skill ID was provided
    if (skillId && this.scanCache) {
      this.scanCache.set({
        skill_id: skillId,
        scan_time: scanTime,
        artifact_hash: artifactHash || '',
        risk_level: riskLevel,
        finding_count: allFindings.length,
        critical_findings: allFindings.filter(f => f.severity === 'critical').length,
        high_findings: allFindings.filter(f => f.severity === 'high').length,
      });
    }

    return {
      risk_level: riskLevel,
      risk_tags,
      evidence,
      findings: allFindings,
      summary: generateSummary(allFindings),
      metadata: {
        files_scanned: files.length,
        scan_duration_ms: Date.now() - startTime,
        scan_time: scanTime,
        analysers_used: Array.from(analysersUsed),
      },
    };
  }
}
