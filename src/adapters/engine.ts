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
 * Phase 0: Tool-level gate.
 *
 * Checks `blocked_tools` and `available_tools` from config before any
 * content-level analysis. Returns a deny HookOutput if the tool is
 * blocked or not in the available list; null to proceed to Phase 1-6.
 */
function checkToolGate(toolName: string, config: EngineOptions['config']): HookOutput | null {
  const blocked = config.guard?.blocked_tools ?? [];
  const available = config.guard?.available_tools ?? [];

  if (blocked.length > 0 && blocked.some(t => t.toLowerCase() === toolName.toLowerCase())) {
    return {
      decision: 'deny',
      reason: policyHookReason(
        `Tool "${toolName}" is blocked (blocked_tools)`, '', ['TOOL_GATE_BLOCKED'], 'critical'
      ),
      riskLevel: 'critical',
      riskScore: scoreForLevel('critical'),
      riskTags: ['TOOL_GATE_BLOCKED'],
    };
  }

  if (available.length > 0 && !available.some(t => t.toLowerCase() === toolName.toLowerCase())) {
    return {
      decision: 'deny',
      reason: policyHookReason(
        `Tool "${toolName}" is not available (available_tools)`, '', ['TOOL_GATE_UNAVAILABLE'], 'critical'
      ),
      riskLevel: 'critical',
      riskScore: scoreForLevel('critical'),
      riskTags: ['TOOL_GATE_UNAVAILABLE'],
    };
  }

  return null;
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

  // Phase 0: Tool-level gate
  const toolGate = checkToolGate(input.toolName, options.config);
  if (toolGate) {
    const skill = await adapter.inferInitiatingSkill(input);
    writeAuditLog(
      input,
      { decision: 'deny', risk_level: 'critical', risk_tags: toolGate.riskTags ?? [] },
      skill,
      adapter.name,
    );
    return toolGate;
  }

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
