import type { HookAdapter, HookInput, HookOutput, EngineOptions } from './types.js';
import { writeAuditLog, buildGuardAuditEntry } from './common.js';
import type { WriteAuditLogOptions } from './common.js';
import type { RuntimeDecision } from '../core/analysers/runtime/index.js';
import type { ProtectionLevel } from '../core/analysers/runtime/decision.js';

function policyHookReason(
  explanation: string,
  skillTag: string,
  riskTags: string[] | undefined,
  riskLevel: string,
  score: number,
): string {
  const rounded = Math.round(score * 1000) / 1000;
  const tagPart =
    riskTags && riskTags.length > 0 ? ` [${riskTags.join(', ')}]` : '';
  return `[score: ${rounded}][level: ${riskLevel}]${tagPart} FFWD AgentGuard: ${explanation}${skillTag}`;
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

  const finalScore = rd.scores.final ?? 0;

  if (rd.decision === 'deny') {
    return {
      decision: 'deny',
      reason: policyHookReason(
        rd.explanation || 'Action blocked',
        skillTag,
        uniqueTags,
        rd.risk_level,
        finalScore,
      ),
      riskLevel: rd.risk_level,
      riskScore: finalScore,
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
        finalScore,
      ),
      riskLevel: rd.risk_level,
      riskScore: finalScore,
      riskTags: uniqueTags,
      initiatingSkill,
    };
  }

  return {
    decision: 'allow',
    riskLevel: rd.risk_level,
    riskScore: finalScore,
    initiatingSkill,
  };
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
        `Tool "${toolName}" is blocked (blocked_tools)`, '', ['TOOL_GATE_BLOCKED'], 'critical', 1.0
      ),
      riskLevel: 'critical',
      riskScore: 1.0,
      riskTags: ['TOOL_GATE_BLOCKED'],
    };
  }

  if (available.length > 0 && !available.some(t => t.toLowerCase() === toolName.toLowerCase())) {
    return {
      decision: 'deny',
      reason: policyHookReason(
        `Tool "${toolName}" is not available (available_tools)`, '', ['TOOL_GATE_UNAVAILABLE'], 'critical', 1.0
      ),
      riskLevel: 'critical',
      riskScore: 1.0,
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
  const t0 = performance.now();
  const toolGate = checkToolGate(input.toolName, options.config, adapter.name);
  const t0End = performance.now();
  if (toolGate) {
    const skill = await adapter.inferInitiatingSkill(input);
    const entry = buildGuardAuditEntry(input, null, skill, adapter.name);
    entry.decision = 'deny';
    entry.risk_level = 'critical';
    entry.risk_score = 1.0;
    entry.risk_tags = toolGate.riskTags ?? [];
    entry.explanation = toolGate.reason;
    entry.phase_stopped = 0;
    entry.phases = { tool_gate: { score: 1, finding_count: 1, duration_ms: Math.round(t0End - t0) } };
    writeAuditLog(entry, auditOpts);
    return toolGate;
  }

  // Post-tool events → no guard evaluation needed
  if (input.eventType === 'post') {
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
