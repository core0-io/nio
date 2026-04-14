/**
 * RuntimeAnalyser — 6-phase dynamic guard pipeline.
 *
 * Executes phases sequentially with short-circuit evaluation:
 *
 *   Phase 1: Allowlist gate (<1ms)          → allow? exit
 *   Phase 2: RuntimeAnalyser patterns (<5ms) → score a → critical? exit
 *   Phase 3: StaticAnalyser on file (<50ms)  → score b → critical? exit (Write/Edit only)
 *   Phase 4: BehaviouralAnalyser (<200ms)     → score c → critical? exit (Write/Edit .ts/.js only)
 *   Phase 5: LLM (2-10s, optional)          → score d → critical? exit
 *   Phase 6: External API (optional)         → score e
 *   Final:   Weighted aggregate → allow/deny/confirm
 */

import type { ActionEnvelope } from '../../../types/action.js';
import type { RiskLevel } from '../../../types/scanner.js';
import type { Finding } from '../../models.js';
import { aggregateRiskLevel } from '../../models.js';
import { checkAllowlist } from './allowlist.js';
import { analyzeAction } from './denylist.js';
import {
  findingsToScore,
  aggregateScores,
  DEFAULT_WEIGHTS,
  type PhaseWeights,
  type PhaseScores,
} from '../../scoring.js';
import {
  scoreToDecision,
  shouldShortCircuit,
  type ProtectionLevel,
  type GuardDecision,
} from './decision.js';
import { ExternalAnalyser } from '../external/index.js';

// ── Types ───────────────────────────────────────────────────────────────

export interface RuntimeDecision {
  decision: GuardDecision;
  risk_level: RiskLevel;
  findings: Finding[];
  scores: PhaseScores & { final?: number };
  phase_stopped: 1 | 2 | 3 | 4 | 5 | 6;
  explanation?: string;
}

export interface RuntimeAnalyserOptions {
  weights?: Partial<PhaseWeights>;
  level?: ProtectionLevel;
  extraAllowlist?: string[];
  // Phase 5/6 options (Phase 2C)
  llmApiKey?: string;
  llmModel?: string;
  scoringEndpoint?: string;
  scoringApiKey?: string;
  scoringTimeout?: number;
}

// ── RuntimeAnalyser ─────────────────────────────────────────────────────

export class RuntimeAnalyser {
  private weights: PhaseWeights;
  private level: ProtectionLevel;
  private extraAllowlist: string[];
  private llmApiKey?: string;
  private llmModel?: string;
  private externalScorer?: ExternalAnalyser;

  constructor(opts?: RuntimeAnalyserOptions) {
    this.weights = { ...DEFAULT_WEIGHTS, ...opts?.weights };
    this.level = opts?.level ?? 'balanced';
    this.extraAllowlist = opts?.extraAllowlist ?? [];
    this.llmApiKey = opts?.llmApiKey;
    this.llmModel = opts?.llmModel;

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
  async evaluate(envelope: ActionEnvelope, levelOverride?: ProtectionLevel): Promise<RuntimeDecision> {
    const level = levelOverride ?? this.level;
    const allFindings: Finding[] = [];
    const scores: PhaseScores = {};

    // ── Phase 1: Allowlist Gate ───────────────────────────────────────
    const allowlistResult = checkAllowlist(envelope, this.extraAllowlist);
    if (allowlistResult.allowed) {
      return {
        decision: 'allow',
        risk_level: allowlistResult.audit ? 'medium' : 'low',
        findings: [],
        scores: {},
        phase_stopped: 1,
        explanation: allowlistResult.audit
          ? allowlistResult.auditReason
          : 'Matched allowlist',
      };
    }

    // ── Phase 2: RuntimeAnalyser (pattern matching) ──────────────────
    const phase2Findings = analyzeAction(envelope);
    allFindings.push(...phase2Findings);
    const scoreA = findingsToScore(phase2Findings);
    scores.runtime = scoreA;

    if (shouldShortCircuit(scoreA, level)) {
      return this.buildResult(allFindings, scores, 2, level);
    }

    // ── Phase 3: StaticAnalyser (Write/Edit only) ────────────────────
    if (envelope.action.type === 'write_file') {
      const data = envelope.action.data as { content_preview?: string; path?: string };
      if (data.content_preview) {
        const phase3Findings = await this.runStaticOnContent(
          data.content_preview,
          data.path || 'unknown',
        );
        allFindings.push(...phase3Findings);
        const scoreB = findingsToScore(phase3Findings);
        scores.static = scoreB;

        if (shouldShortCircuit(scoreB, level)) {
          return this.buildResult(allFindings, scores, 3, level);
        }
      }
    }

    // ── Phase 4: BehaviouralAnalyser (Write/Edit .ts/.js/.py only) ─────
    if (envelope.action.type === 'write_file') {
      const data = envelope.action.data as { content_preview?: string; path?: string };
      const path = data.path || '';
      const isBehaviouralTarget = /\.(js|ts|mjs|mts|jsx|tsx|py|pyw|sh|bash|zsh|fish|ksh|rb|rake|gemspec|php|phtml|go)$/.test(path);

      if (isBehaviouralTarget && data.content_preview) {
        const phase4Findings = await this.runBehaviouralOnContent(
          data.content_preview,
          path,
        );
        allFindings.push(...phase4Findings);
        const scoreC = findingsToScore(phase4Findings);
        scores.behavioural = scoreC;

        if (shouldShortCircuit(scoreC, level)) {
          return this.buildResult(allFindings, scores, 4, level);
        }
      }
    }

    // ── Phase 5: LLM (optional, gated on API key) ────────────────────
    if (this.llmApiKey) {
      const phase5Findings = await this.runLLMOnAction(envelope);
      allFindings.push(...phase5Findings);
      const scoreD = findingsToScore(phase5Findings);
      scores.llm = scoreD;

      if (shouldShortCircuit(scoreD, level)) {
        return this.buildResult(allFindings, scores, 5, level);
      }
    }

    // ── Phase 6: External API (optional, gated on endpoint) ─────────
    if (this.externalScorer) {
      const result = await this.externalScorer.scoreAction(
          envelope.action.type,
          envelope.action.data as unknown as Record<string, unknown>,
          scores as Record<string, number | undefined>,
          allFindings,
          envelope.context.initiating_skill,
        );
      if (result) {
        scores.external = result.score;

        if (shouldShortCircuit(result.score, level)) {
          // Add a synthetic finding for the external score
          allFindings.push({
            id: `EXTERNAL_SCORE:${envelope.action.type}:0`,
            rule_id: 'EXTERNAL_SCORE',
            category: 'policy_violation',
            severity: result.score >= 0.9 ? 'critical' : result.score >= 0.7 ? 'high' : 'medium',
            title: 'External scorer flagged action',
            description: result.reason || 'External scoring API returned high risk score',
            location: { file: envelope.action.type, line: 0 },
            analyser: 'static',
            confidence: result.score,
          });
          return this.buildResult(allFindings, scores, 6, level);
        }
      }
    }

    // ── Final: Aggregate scores ──────────────────────────────────────
    return this.buildResult(allFindings, scores, 6, level);
  }

  // ── Phase 3: Static analysis on file content ──────────────────────────

  private async runStaticOnContent(content: string, filePath: string): Promise<Finding[]> {
    // Lazy import to avoid circular dependency and keep lightweight
    const { runRules, runBase64Pass } = await import('../../detection-engine.js');
    const { ruleRegistry } = await import('../../rule-registry.js');

    const ext = '.' + (filePath.split('.').pop() || 'txt');
    const rules = ruleRegistry.getRulesForExtension(ext);
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
    const { BehaviouralAnalyser } = await import('../behavioural/index.js');
    const { defaultPolicy } = await import('../../scan-policy.js');

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

    return analyser.analyze({
      rootDir: '.',
      files: [fakeFileInfo],
      policy,
    });
  }

  // ── Phase 5: LLM analysis on action ────────────────────────────────────

  private async runLLMOnAction(envelope: ActionEnvelope): Promise<Finding[]> {
    // Lazy import to avoid loading Anthropic SDK when not needed
    const { LLMAnalyser } = await import('../llm/index.js');
    const { defaultPolicy } = await import('../../scan-policy.js');

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
    return analyser.analyze({
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
  ): RuntimeDecision {
    const finalScore = aggregateScores(scores, this.weights);
    const decision = scoreToDecision(finalScore, level);
    const riskLevel = findings.length > 0
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
      findings,
      scores: { ...scores, final: finalScore },
      phase_stopped: phaseStopped,
      explanation,
    };
  }
}
