import type { HookAdapter, HookInput, HookOutput, EngineOptions } from './types.js';
import type { RiskLevel } from '../types/scanner.js';
import { riskLevelToNumericScore } from '../types/scanner.js';
import { writeAuditLog, buildGuardAuditEntry } from './common.js';
import type { WriteAuditLogOptions } from './common.js';
import type { RuntimeDecision } from '../core/analysers/runtime/index.js';
import type { ProtectionLevel } from '../core/analysers/runtime/decision.js';

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
function checkToolGate(toolName: string, config: EngineOptions['config'], platform: string): HookOutput | null {
  const platformKey = platform.replace(/-/g, '_');
  const blocked = config.guard?.blocked_tools?.[platformKey] ?? [];
  const available = config.guard?.available_tools?.[platformKey] ?? [];

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
 * Evaluate a hook event using the RuntimeAnalyser pipeline.
 *
 * This is the platform-agnostic core — adapters handle I/O protocol,
 * this function handles security logic via the Phase 0–6 pipeline.
 */
export async function evaluateHook(
  adapter: HookAdapter,
  rawInput: unknown,
  options: EngineOptions,
  auditOpts?: WriteAuditLogOptions,
): Promise<HookOutput> {
  const input = adapter.parseInput(rawInput);

  // Phase 0: Tool-level gate
  const toolGate = checkToolGate(input.toolName, options.config, adapter.name);
  if (toolGate) {
    const skill = await adapter.inferInitiatingSkill(input);
    const entry = buildGuardAuditEntry(input, null, skill, adapter.name);
    entry.decision = 'deny';
    entry.risk_level = 'critical';
    entry.risk_score = scoreForLevel('critical');
    entry.risk_tags = toolGate.riskTags ?? [];
    entry.explanation = toolGate.reason;
    writeAuditLog(entry, auditOpts);
    return toolGate;
  }

  // Post-tool events → audit only
  if (input.eventType === 'post') {
    const skill = await adapter.inferInitiatingSkill(input);
    const entry = buildGuardAuditEntry(input, null, skill, adapter.name);
    writeAuditLog(entry, auditOpts);
    return { decision: 'allow' };
  }

  // Build envelope
  const initiatingSkill = await adapter.inferInitiatingSkill(input);
  const envelope = adapter.buildEnvelope(input, initiatingSkill);

  if (!envelope) {
    return { decision: 'allow' };
  }

  // Run RuntimeAnalyser pipeline
  try {
    const level = (options.config.guard?.protection_level || 'balanced') as ProtectionLevel;
    const rd: RuntimeDecision = await options.ffwdAgentGuard.runtimeAnalyser.evaluate(envelope, level);

    const entry = buildGuardAuditEntry(
      input, rd, initiatingSkill, adapter.name, envelope.action.type,
    );
    writeAuditLog(entry, auditOpts);

    return runtimeDecisionToHookOutput(rd, initiatingSkill);
  } catch {
    // Engine error → fail open
    const entry = buildGuardAuditEntry(input, null, initiatingSkill, adapter.name);
    entry.decision = 'error';
    entry.risk_tags = ['ENGINE_ERROR'];
    writeAuditLog(entry, auditOpts);
    return { decision: 'allow' };
  }
}
