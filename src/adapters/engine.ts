import type { HookAdapter, HookInput, HookOutput, EngineOptions } from './types.js';
import type { RiskLevel } from '../types/scanner.js';
import { riskLevelToNumericScore } from '../types/scanner.js';
import {
  isSensitivePath,
  shouldDenyAtLevel,
  shouldAskAtLevel,
  writeAuditLog,
  getSkillTrustPolicy,
  isActionAllowedByCapabilities,
} from './common.js';

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
 * Evaluate a hook event using the common AgentGuard decision engine.
 *
 * This is the platform-agnostic core — adapters handle I/O protocol,
 * this function handles security logic.
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

  // Fast check: sensitive file paths (Write/Edit and shell commands targeting sensitive paths)
  const actionType = adapter.mapToolToActionType(input.toolName);
  if (actionType === 'write_file') {
    const filePath = (input.toolInput.file_path as string) ||
                     (input.toolInput.path as string) || '';
    if (isSensitivePath(filePath)) {
      const skillTag = initiatingSkill ? ` (via skill: ${initiatingSkill})` : '';
      const reason = policyHookReason(
        `blocked write to sensitive path "${filePath}"`,
        skillTag,
        ['SENSITIVE_PATH'],
        'critical'
      );
      writeAuditLog(input, { decision: 'deny', risk_level: 'critical', risk_tags: ['SENSITIVE_PATH'] }, initiatingSkill, adapter.name);

      // In permissive mode, ask for user-initiated writes
      if (options.config.level === 'permissive' && !initiatingSkill) {
        return {
          decision: 'ask',
          reason,
          riskLevel: 'critical',
          riskScore: scoreForLevel('critical'),
          riskTags: ['SENSITIVE_PATH'],
          initiatingSkill,
        };
      }
      return {
        decision: 'deny',
        reason,
        riskLevel: 'critical',
        riskScore: scoreForLevel('critical'),
        riskTags: ['SENSITIVE_PATH'],
        initiatingSkill,
      };
    }
  }

  // Full ActionScanner evaluation
  try {
    const decision = await options.ffwdAgentGuard.actionScanner.decide(envelope);

    // Skill trust policy enforcement
    if (initiatingSkill) {
      const policy = await getSkillTrustPolicy(initiatingSkill, options.ffwdAgentGuard.registry);

      if (!policy.isKnown || policy.trustLevel === 'untrusted') {
        if (!isActionAllowedByCapabilities(
          envelope.action.type,
          { can_exec: false, can_network: false, can_write: false, can_read: true }
        )) {
          const reason = `FFWD AgentGuard: untrusted skill "${initiatingSkill}" attempted ${envelope.action.type} — register it with /ffwd-agent-guard trust attest to allow [score: ${scoreForLevel('high')}]`;
          writeAuditLog(input, { decision: 'deny', risk_level: 'high', risk_tags: ['UNTRUSTED_SKILL', ...(decision.risk_tags || [])] }, initiatingSkill, adapter.name);
          return {
            decision: 'ask',
            reason,
            riskLevel: 'high',
            riskScore: scoreForLevel('high'),
            riskTags: ['UNTRUSTED_SKILL'],
            initiatingSkill,
          };
        }
      }

      if (policy.isKnown && policy.capabilities) {
        if (!isActionAllowedByCapabilities(envelope.action.type, policy.capabilities)) {
          const reason = `FFWD AgentGuard: skill "${initiatingSkill}" is not allowed to ${envelope.action.type} per its trust policy [score: ${scoreForLevel('high')}]`;
          writeAuditLog(input, { decision: 'deny', risk_level: 'high', risk_tags: ['CAPABILITY_EXCEEDED', ...(decision.risk_tags || [])] }, initiatingSkill, adapter.name);
          return {
            decision: 'deny',
            reason,
            riskLevel: 'high',
            riskScore: scoreForLevel('high'),
            riskTags: ['CAPABILITY_EXCEEDED'],
            initiatingSkill,
          };
        }
      }
    }

    // Write audit log
    writeAuditLog(input, decision, initiatingSkill, adapter.name);

    // Apply protection level thresholds
    const skillTag = initiatingSkill ? ` (via skill: ${initiatingSkill})` : '';
    const riskScore = scoreForLevel(decision.risk_level);

    if (shouldDenyAtLevel(decision, options.config)) {
      return {
        decision: 'deny',
        reason: policyHookReason(
          decision.explanation || 'Action blocked',
          skillTag,
          decision.risk_tags,
          decision.risk_level
        ),
        riskLevel: decision.risk_level,
        riskScore,
        riskTags: decision.risk_tags,
        initiatingSkill,
      };
    }

    if (shouldAskAtLevel(decision, options.config)) {
      return {
        decision: 'ask',
        reason: policyHookReason(
          decision.explanation || 'Action requires confirmation',
          skillTag,
          decision.risk_tags,
          decision.risk_level
        ),
        riskLevel: decision.risk_level,
        riskScore,
        riskTags: decision.risk_tags,
        initiatingSkill,
      };
    }

    return { decision: 'allow', initiatingSkill };
  } catch {
    // Engine error → fail open
    writeAuditLog(input, { decision: 'error', risk_level: 'low', risk_tags: ['ENGINE_ERROR'] }, initiatingSkill, adapter.name);
    return { decision: 'allow' };
  }
}
