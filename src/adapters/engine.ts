import type { HookAdapter, HookInput, HookOutput, EngineOptions } from './types.js';
import type { RiskLevel } from '../types/scanner.js';
import { riskLevelToNumericScore } from '../types/scanner.js';
import { writeAuditLog } from './common.js';
import type { RuntimeDecision } from '../core/analyzers/runtime/index.js';
import type { ProtectionLevel } from '../core/analyzers/runtime/decision.js';

function scoreForLevel(level: string | undefined): number {
  return riskLevelToNumericScore((level || 'medium') as RiskLevel);
}

function policyHookReason(
  explanation: string,
  skillTag: string,
  riskTags: string[] | undefined,
  riskLevel: string
): string {
  const score = scoreForLevel(riskLevel);
  const tagPart =
    riskTags && riskTags.length > 0 ? ` [${riskTags.join(', ')}]` : '';
  return `[score: ${score}][level: ${riskLevel}]${tagPart} FFWD AgentGuard: ${explanation}${skillTag}`;
}

/**
 * Map RuntimeDecision to HookOutput using the new score-based system.
 */
function runtimeDecisionToHookOutput(
  rd: RuntimeDecision,
  initiatingSkill: string | null,
): HookOutput {
  const skillTag = initiatingSkill ? ` (via skill: ${initiatingSkill})` : '';
  const riskTags = rd.findings.map(f => f.rule_id);
  const uniqueTags = [...new Set(riskTags)];

  if (rd.decision === 'deny') {
    return {
      decision: 'deny',
      reason: policyHookReason(
        rd.explanation || 'Action blocked',
        skillTag,
        uniqueTags,
        rd.risk_level,
      ),
      riskLevel: rd.risk_level,
      riskScore: scoreForLevel(rd.risk_level),
      riskTags: uniqueTags,
      initiatingSkill,
    };
  }

  if (rd.decision === 'confirm') {
    return {
      decision: 'ask',
      reason: policyHookReason(
        rd.explanation || 'Action requires confirmation',
        skillTag,
        uniqueTags,
        rd.risk_level,
      ),
      riskLevel: rd.risk_level,
      riskScore: scoreForLevel(rd.risk_level),
      riskTags: uniqueTags,
      initiatingSkill,
    };
  }

  return { decision: 'allow', initiatingSkill };
}

/**
 * Evaluate a hook event using the RuntimeAnalyzer pipeline.
 *
 * This is the platform-agnostic core — adapters handle I/O protocol,
 * this function handles security logic via the 6-phase pipeline.
 */
export async function evaluateHook(
  adapter: HookAdapter,
  rawInput: unknown,
  options: EngineOptions
): Promise<HookOutput> {
  const input = adapter.parseInput(rawInput);

  // Post-tool events → audit only
  if (input.eventType === 'post') {
    const skill = await adapter.inferInitiatingSkill(input);
    writeAuditLog(input, null, skill, adapter.name);
    return { decision: 'allow' };
  }

  // Build envelope
  const initiatingSkill = await adapter.inferInitiatingSkill(input);
  const envelope = adapter.buildEnvelope(input, initiatingSkill);

  if (!envelope) {
    return { decision: 'allow' };
  }

  // Run RuntimeAnalyzer pipeline
  try {
    const level = (options.config.level || 'balanced') as ProtectionLevel;
    const rd: RuntimeDecision = await options.ffwdAgentGuard.runtimeAnalyzer.evaluate(envelope, level);

    // Write audit log
    const riskTags = [...new Set(rd.findings.map(f => f.rule_id))];
    writeAuditLog(
      input,
      { decision: rd.decision, risk_level: rd.risk_level, risk_tags: riskTags },
      initiatingSkill,
      adapter.name,
    );

    return runtimeDecisionToHookOutput(rd, initiatingSkill);
  } catch {
    // Engine error → fail open
    writeAuditLog(
      input,
      { decision: 'error', risk_level: 'low', risk_tags: ['ENGINE_ERROR'] },
      initiatingSkill,
      adapter.name,
    );
    return { decision: 'allow' };
  }
}
