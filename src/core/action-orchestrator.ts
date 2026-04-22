// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * ActionOrchestrator — 6-phase dynamic guard pipeline.
 *
 * Orchestrates six phase analysers against an ActionEnvelope, short-
 * circuiting on critical findings per protection level. "Action" because
 * inputs are normalized action envelopes (platform-agnostic); each phase
 * is a distinct analyser sub-class with a uniform .analyse() interface.
 *
 *   Phase 1: AllowlistAnalyser (<1ms)         → allow? exit
 *   Phase 2: RuntimeAnalyser patterns (<5ms)  → score a → critical? exit
 *   Phase 3: StaticAnalyser on file (<50ms)   → score b → critical? exit (Write/Edit only)
 *   Phase 4: BehaviouralAnalyser (<200ms)     → score c → critical? exit (Write/Edit .ts/.js only)
 *   Phase 5: LLMAnalyser (2-10s, optional)    → score d → critical? exit
 *   Phase 6: ExternalAnalyser (optional)      → score e
 *   Final:   Weighted aggregate → allow/deny/confirm
 */

import type { ActionEnvelope } from '../types/action.js';
import type { RiskLevel } from '../types/scanner.js';
import type { Finding } from './models.js';
import { aggregateRiskLevel } from './models.js';
import { AllowlistAnalyser } from './analysers/allowlist.js';
import { RuntimeAnalyser, type GuardRulesConfig } from './analysers/runtime.js';
import {
  findingsToScore,
  aggregateScores,
  DEFAULT_WEIGHTS,
  type PhaseWeights,
  type PhaseScores,
} from './scoring.js';
import {
  scoreToDecision,
  shouldShortCircuit,
  type ProtectionLevel,
  type GuardDecision,
} from './action-decision.js';
import { ExternalAnalyser } from './analysers/external/index.js';

// ── Types ───────────────────────────────────────────────────────────────

export interface PhaseTimingEntry {
  score: number;
  finding_count: number;
  duration_ms: number;
}

export type PhaseTimings = Partial<
  Record<'allowlist' | 'runtime' | 'static' | 'behavioural' | 'llm' | 'external', PhaseTimingEntry>
>;

export interface ActionDecision {
  decision: GuardDecision;
  risk_level: RiskLevel;
  /** Highest severity among all findings (independent of score). */
  max_finding_severity: RiskLevel;
  findings: Finding[];
  scores: PhaseScores & { final?: number };
  phase_stopped: 1 | 2 | 3 | 4 | 5 | 6;
  phase_timings?: PhaseTimings;
  explanation?: string;
}

/** Map a 0-1 risk score to a risk level. */
function scoreToRiskLevel(score: number): RiskLevel {
  if (score >= 0.9) return 'critical';
  if (score >= 0.7) return 'high';
  if (score >= 0.5) return 'medium';
  return 'low';
}

export type AllowlistMode = 'exit' | 'continue';

export interface ActionOrchestratorOptions {
  scoringWeights?: Partial<PhaseWeights>;
  level?: ProtectionLevel;
  allowedCommands?: string[];
  /**
   * Behavior when Phase 1 allowlist matches.
   *   'continue' (default) — treat as hint, continue to Phase 2-6 so
   *                           external/LLM policy is not bypassed
   *   'exit'               — allow + exit immediately (fast path)
   */
  allowlistMode?: AllowlistMode;
  /** Extra regex patterns for Phase 3 static analysis (from guard.file_scan_rules config). */
  fileScanRules?: Partial<Record<string, string[]>>;
  /** Extra patterns for Phase 2 guard analysis (from guard.action_guard_rules config). */
  actionGuardRules?: GuardRulesConfig;
  // Phase 5: LLM analyser
  llmEnabled?: boolean;
  llmApiKey?: string;
  llmModel?: string;
  // Phase 6: External analyser
  externalEnabled?: boolean;
  scoringEndpoint?: string;
  scoringApiKey?: string;
  scoringTimeout?: number;
}

// ── ActionOrchestrator ─────────────────────────────────────────────────

export class ActionOrchestrator {
  private weights: PhaseWeights;
  private level: ProtectionLevel;
  private allowlistAnalyser: AllowlistAnalyser;
  private allowlistMode: AllowlistMode;
  private runtimeAnalyser: RuntimeAnalyser;
  private fileScanRules?: Partial<Record<string, string[]>>;
  private llmEnabled: boolean;
  private llmApiKey?: string;
  private llmModel?: string;
  private externalEnabled: boolean;
  private externalScorer?: ExternalAnalyser;

  constructor(opts?: ActionOrchestratorOptions) {
    this.weights = { ...DEFAULT_WEIGHTS, ...opts?.scoringWeights };
    this.level = opts?.level ?? 'balanced';
    this.allowlistAnalyser = new AllowlistAnalyser({ allowedCommands: opts?.allowedCommands });
    this.allowlistMode = opts?.allowlistMode ?? 'continue';
    this.runtimeAnalyser = new RuntimeAnalyser({ actionGuardRules: opts?.actionGuardRules });
    this.fileScanRules = opts?.fileScanRules;
    this.llmEnabled = opts?.llmEnabled ?? false;
    this.llmApiKey = opts?.llmApiKey;
    this.llmModel = opts?.llmModel;
    this.externalEnabled = opts?.externalEnabled ?? false;

    if (opts?.scoringEndpoint) {
      this.externalScorer = new ExternalAnalyser({
        endpoint: opts.scoringEndpoint,
        apiKey: opts.scoringApiKey,
        timeout: opts.scoringTimeout,
      });
    }
  }

  /**
   * Evaluate an action through the 6-phase pipeline.
   * @param envelope  The action to evaluate
   * @param levelOverride  Optional protection level override (e.g. from config)
   */
  async evaluate(envelope: ActionEnvelope, levelOverride?: ProtectionLevel): Promise<ActionDecision> {
    const level = levelOverride ?? this.level;
    const allFindings: Finding[] = [];
    const scores: PhaseScores = {};
    const timings: PhaseTimings = {};

    // ── Phase 1: Allowlist Gate ───────────────────────────────────────
    const t1 = performance.now();
    const allowlistResult = this.allowlistAnalyser.analyse(envelope);
    const t1End = performance.now();
    timings.allowlist = { score: 0, finding_count: 0, duration_ms: Math.round(t1End - t1) };
    if (allowlistResult.allowed && this.allowlistMode === 'exit') {
      return {
        decision: 'allow',
        risk_level: allowlistResult.audit ? 'medium' : 'low',
        max_finding_severity: 'low',
        findings: [],
        scores: {},
        phase_stopped: 1,
        phase_timings: timings,
        explanation: allowlistResult.audit
          ? allowlistResult.auditReason
          : 'Matched allowlist',
      };
    }

    // ── Phase 2: RuntimeAnalyser (pattern matching) ──────────────────
    const t2 = performance.now();
    const phase2Findings = this.runtimeAnalyser.analyse(envelope);
    const t2End = performance.now();
    allFindings.push(...phase2Findings);
    const scoreA = findingsToScore(phase2Findings);
    scores.runtime = scoreA;
    timings.runtime = { score: scoreA, finding_count: phase2Findings.length, duration_ms: Math.round(t2End - t2) };

    if (shouldShortCircuit(scoreA, level)) {
      return this.buildResult(allFindings, scores, 2, level, timings);
    }

    // ── Phase 3: StaticAnalyser (Write/Edit only) ────────────────────
    if (envelope.action.type === 'write_file') {
      const data = envelope.action.data as { content_preview?: string; path?: string };
      if (data.content_preview) {
        const t3 = performance.now();
        const phase3Findings = await this.runStaticOnContent(
          data.content_preview,
          data.path || 'unknown',
        );
        const t3End = performance.now();
        allFindings.push(...phase3Findings);
        const scoreB = findingsToScore(phase3Findings);
        scores.static = scoreB;
        timings.static = { score: scoreB, finding_count: phase3Findings.length, duration_ms: Math.round(t3End - t3) };

        if (shouldShortCircuit(scoreB, level)) {
          return this.buildResult(allFindings, scores, 3, level, timings);
        }
      }
    }

    // ── Phase 4: BehaviouralAnalyser (Write/Edit .ts/.js/.py only) ─────
    if (envelope.action.type === 'write_file') {
      const data = envelope.action.data as { content_preview?: string; path?: string };
      const path = data.path || '';
      const isBehaviouralTarget = /\.(js|ts|mjs|mts|jsx|tsx|py|pyw|sh|bash|zsh|fish|ksh|rb|rake|gemspec|php|phtml|go)$/.test(path);

      if (isBehaviouralTarget && data.content_preview) {
        const t4 = performance.now();
        const phase4Findings = await this.runBehaviouralOnContent(
          data.content_preview,
          path,
        );
        const t4End = performance.now();
        allFindings.push(...phase4Findings);
        const scoreC = findingsToScore(phase4Findings);
        scores.behavioural = scoreC;
        timings.behavioural = { score: scoreC, finding_count: phase4Findings.length, duration_ms: Math.round(t4End - t4) };

        if (shouldShortCircuit(scoreC, level)) {
          return this.buildResult(allFindings, scores, 4, level, timings);
        }
      }
    }

    // ── Phase 5: LLM (optional, gated on enabled + API key) ──────────
    if (this.llmEnabled && this.llmApiKey) {
      const t5 = performance.now();
      const phase5Findings = await this.runLLMOnAction(envelope);
      const t5End = performance.now();
      allFindings.push(...phase5Findings);
      const scoreD = findingsToScore(phase5Findings);
      scores.llm = scoreD;
      timings.llm = { score: scoreD, finding_count: phase5Findings.length, duration_ms: Math.round(t5End - t5) };

      if (shouldShortCircuit(scoreD, level)) {
        return this.buildResult(allFindings, scores, 5, level, timings);
      }
    }

    // ── Phase 6: External API (optional, gated on enabled + endpoint)
    if (this.externalEnabled && this.externalScorer) {
      const t6 = performance.now();
      const result = await this.externalScorer.scoreAction(
          envelope.action.type,
          envelope.action.data as unknown as Record<string, unknown>,
          scores as Record<string, number | undefined>,
          allFindings,
          envelope.context.initiating_skill,
        );
      const t6End = performance.now();
      if (result) {
        scores.external = result.score;
        timings.external = { score: result.score, finding_count: 0, duration_ms: Math.round(t6End - t6) };

        // Emit a synthetic finding when external score indicates risk (≥ 0.5)
        if (result.score >= 0.5) {
          allFindings.push({
            id: `EXTERNAL_SCORE:${envelope.action.type}:0`,
            rule_id: 'EXTERNAL_SCORE',
            category: 'policy_violation',
            severity: result.score >= 0.9 ? 'critical' : result.score >= 0.7 ? 'high' : 'medium',
            title: 'External scorer flagged action',
            description: result.reason || 'External scoring API returned elevated risk score',
            location: { file: envelope.action.type, line: 0 },
            analyser: 'static',
            confidence: result.score,
          });
          timings.external!.finding_count = 1;
        }

        if (shouldShortCircuit(result.score, level)) {
          return this.buildResult(allFindings, scores, 6, level, timings);
        }
      }
    }

    // ── Final: Aggregate scores ──────────────────────────────────────
    return this.buildResult(allFindings, scores, 6, level, timings);
  }

  // ── Phase 3: Static analysis on file content ──────────────────────────

  private async runStaticOnContent(content: string, filePath: string): Promise<Finding[]> {
    // Lazy import to avoid circular dependency and keep lightweight
    const { runRules, runBase64Pass } = await import('./detection-engine.js');
    const { ruleRegistry } = await import('./rule-registry.js');

    const ext = '.' + (filePath.split('.').pop() || 'txt');
    const rules = ruleRegistry.getRulesForExtension(ext, this.fileScanRules);
    const allRules = ruleRegistry.allRules();

    const findings = [
      ...runRules(content, rules, filePath, 'static', ruleRegistry),
      ...runBase64Pass(content, allRules, filePath, 'static', ruleRegistry),
    ];

    return findings;
  }

  // ── Phase 4: Behavioural analysis on file content ──────────────────────

  private async runBehaviouralOnContent(content: string, filePath: string): Promise<Finding[]> {
    // Lazy import
    const { BehaviouralAnalyser } = await import('./analysers/behavioural/index.js');
    const { defaultPolicy } = await import('./scan-policy.js');

    const analyser = new BehaviouralAnalyser();
    const policy = defaultPolicy();

    // BehaviouralAnalyser expects FileInfo[] in AnalysisContext
    const ext = '.' + (filePath.split('.').pop() || 'ts');
    const fakeFileInfo = {
      path: filePath,
      relativePath: filePath,
      content,
      extension: ext,
    };

    return analyser.analyse({
      rootDir: '.',
      files: [fakeFileInfo],
      policy,
    });
  }

  // ── Phase 5: LLM analysis on action ────────────────────────────────────

  private async runLLMOnAction(envelope: ActionEnvelope): Promise<Finding[]> {
    // Lazy import to avoid loading Anthropic SDK when not needed
    const { LLMAnalyser } = await import('./analysers/llm/index.js');
    const { defaultPolicy } = await import('./scan-policy.js');

    const analyser = new LLMAnalyser({
      apiKey: this.llmApiKey,
      model: this.llmModel,
    });

    const policy = defaultPolicy();
    if (!analyser.isEnabled(policy)) return [];

    // Build a synthetic file from the action data for LLM analysis
    let content: string;
    let filePath: string;

    if (envelope.action.type === 'write_file') {
      const data = envelope.action.data as { content_preview?: string; path?: string };
      content = data.content_preview || '';
      filePath = data.path || 'unknown';
    } else if (envelope.action.type === 'exec_command') {
      const data = envelope.action.data as { command: string };
      content = `#!/bin/bash\n${data.command}`;
      filePath = 'command.sh';
    } else if (envelope.action.type === 'network_request') {
      const data = envelope.action.data as { url?: string; method?: string; body_preview?: string };
      content = JSON.stringify(data, null, 2);
      filePath = 'request.json';
    } else {
      return [];
    }

    if (!content) return [];

    const ext = '.' + (filePath.split('.').pop() || 'txt');
    return analyser.analyse({
      rootDir: '.',
      files: [{
        path: filePath,
        relativePath: filePath,
        content,
        extension: ext,
      }],
      policy,
    });
  }

  // ── Result Builder ────────────────────────────────────────────────────

  private buildResult(
    findings: Finding[],
    scores: PhaseScores,
    phaseStopped: 1 | 2 | 3 | 4 | 5 | 6,
    level: ProtectionLevel = this.level,
    phaseTimings?: PhaseTimings,
  ): ActionDecision {
    const finalScore = aggregateScores(scores, this.weights);
    const decision = scoreToDecision(finalScore, level);
    const riskLevel = scoreToRiskLevel(finalScore);
    const maxFindingSeverity = findings.length > 0
      ? aggregateRiskLevel(findings)
      : 'low';

    // Build explanation from top finding
    const topFinding = findings[0];
    const explanation = topFinding
      ? `${topFinding.title}: ${topFinding.description}`
      : undefined;

    return {
      decision,
      risk_level: riskLevel,
      max_finding_severity: maxFindingSeverity,
      findings,
      scores: { ...scores, final: finalScore },
      phase_stopped: phaseStopped,
      phase_timings: phaseTimings,
      explanation,
    };
  }
}
