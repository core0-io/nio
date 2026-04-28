// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import type { HookAdapter, HookInput, HookOutput, EngineOptions } from './types.js';
import { writeAuditLog, buildGuardAuditEntry } from './common.js';
import type { WriteAuditLogOptions } from './common.js';
import type { ActionDecision } from '../core/action-orchestrator.js';
import type { ProtectionLevel } from '../core/action-decision.js';
import {
  extractMcpCallsFromCommand,
  extractCommandString,
  type ExtractedMcpCall,
} from './mcp-route-detect/index.js';
import { isNioSelfInvocation } from './self-invocation.js';

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
  return `[score: ${rounded}][level: ${riskLevel}]${tagPart} Nio: ${explanation}${skillTag}`;
}

/**
 * Map ActionDecision to HookOutput using the new score-based system.
 */
function runtimeDecisionToHookOutput(
  rd: ActionDecision,
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

export interface ParsedMcpToolName {
  isMcp: boolean;
  server?: string;
  local?: string;
}

/**
 * Parse a platform-specific tool name into a normalized `{ server, local }`
 * pair when it refers to an MCP tool.
 *
 * - Claude Code exposes MCP tools as `mcp__<server>__<tool>`.
 * - OpenClaw exposes MCP tools as `<safeServerName>__<tool>` (native tools
 *   never contain `__`, so the separator is a reliable marker).
 */
export function parseMcpToolName(toolName: string, platform: string): ParsedMcpToolName {
  const name = toolName ?? '';

  if (platform === 'claude-code' && name.startsWith('mcp__')) {
    const rest = name.slice(5);
    const idx = rest.indexOf('__');
    if (idx > 0 && idx < rest.length - 2) {
      return { isMcp: true, server: rest.slice(0, idx), local: rest.slice(idx + 2) };
    }
    return { isMcp: false };
  }

  if (platform === 'openclaw') {
    const idx = name.indexOf('__');
    if (idx > 0 && idx < name.length - 2) {
      return { isMcp: true, server: name.slice(0, idx), local: name.slice(idx + 2) };
    }
    return { isMcp: false };
  }

  return { isMcp: false };
}

function matchesCaseInsensitive(list: readonly string[], candidates: readonly string[]): boolean {
  const lowered = candidates.map(c => c.toLowerCase());
  return list.some(entry => lowered.includes(entry.toLowerCase()));
}

/**
 * Phase 0: Tool-level gate.
 *
 * Checks `blocked_tools` and `available_tools` from config before any
 * content-level analysis. Returns a deny HookOutput if the tool is
 * blocked or not in the available list; null to proceed to Phase 1-6.
 *
 * The `mcp` namespace under each list applies when the incoming tool is an
 * MCP tool (detected by platform-specific naming convention). Entries may
 * be either bare local names (`HassTurnOn`) — match any server — or
 * server-qualified (`hass__HassTurnOn`) — match that server only.
 *
 * The same `mcp` lists also apply to MCP calls invoked via a shell command
 * (e.g. `Bash` / `exec` calling `mcporter call server.tool`). Shell-
 * embedded targets are extracted from `toolInput` and matched against the
 * same `mcp` entries.
 */
function checkToolGate(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  config: EngineOptions['config'],
  platform: string,
): HookOutput | null {
  const platformKey = platform.replace(/-/g, '_');
  const blockedPlatform = config.guard?.blocked_tools?.[platformKey] ?? [];
  const availablePlatform = config.guard?.available_tools?.[platformKey] ?? [];
  const blockedMcp = config.guard?.blocked_tools?.['mcp'] ?? [];
  const availableMcp = config.guard?.available_tools?.['mcp'] ?? [];

  const parsed = parseMcpToolName(toolName, platform);
  const nameMcpCandidates = parsed.isMcp && parsed.local && parsed.server
    ? [parsed.local, `${parsed.server}__${parsed.local}`]
    : [];

  const shellHits = extractMcpCallsFromCommand(extractCommandString(toolInput));
  const shellMcpCandidates = shellHits.flatMap(h => [h.local, `${h.server}__${h.local}`]);

  const allMcpCandidates = [...nameMcpCandidates, ...shellMcpCandidates];
  const hasMcpContext = parsed.isMcp || shellHits.length > 0;

  // --- Blocked (additive: any hit denies) ---
  const nameBlocked = blockedPlatform.length > 0 && matchesCaseInsensitive(blockedPlatform, [toolName]);
  const nativeMcpBlocked = parsed.isMcp && blockedMcp.length > 0
    && matchesCaseInsensitive(blockedMcp, nameMcpCandidates);
  const shellMcpBlockHit: ExtractedMcpCall | undefined = blockedMcp.length > 0 && shellHits.length > 0
    ? shellHits.find(h => matchesCaseInsensitive(blockedMcp, [h.local, `${h.server}__${h.local}`]))
    : undefined;

  if (nameBlocked || nativeMcpBlocked || shellMcpBlockHit) {
    const reason = (shellMcpBlockHit && !nameBlocked && !nativeMcpBlocked)
      ? `Tool "${shellMcpBlockHit.server}__${shellMcpBlockHit.local}" is blocked (blocked_tools; invoked via mcporter)`
      : `Tool "${toolName}" is blocked (blocked_tools)`;
    return {
      decision: 'deny',
      reason: policyHookReason(reason, '', ['TOOL_GATE_BLOCKED'], 'critical', 1.0),
      riskLevel: 'critical',
      riskScore: 1.0,
      riskTags: ['TOOL_GATE_BLOCKED'],
    };
  }

  // --- Available (namespaced: mcp and platform lists gate independently) ---
  if (hasMcpContext) {
    if (availableMcp.length > 0) {
      if (!matchesCaseInsensitive(availableMcp, allMcpCandidates)) {
        return denyUnavailable(toolName);
      }
    } else if (availablePlatform.length > 0 && !matchesCaseInsensitive(availablePlatform, [toolName])) {
      return denyUnavailable(toolName);
    }
  } else if (availablePlatform.length > 0 && !matchesCaseInsensitive(availablePlatform, [toolName])) {
    return denyUnavailable(toolName);
  }

  return null;
}

function denyUnavailable(toolName: string): HookOutput {
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

/**
 * Evaluate a hook event using the ActionOrchestrator pipeline.
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
  const toolGate = checkToolGate(input.toolName, input.toolInput, options.config, adapter.name);
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

  // Nio self-invocation short-circuit: when the skill/E2E/debug flow
  // runs Nio's own action-cli via a shell-exec tool (e.g. Claude Code's
  // Bash), the outer hook must not double-analyse. action-cli itself
  // runs the full Phase 1-6 pipeline on the real envelope inside its
  // subprocess, so one analysis is enough. Phase 0 has already passed
  // above, so blocked_tools still applies. Silent (no audit entry) to
  // keep skill queries from polluting ~/.nio/audit.jsonl.
  if (
    envelope.action.type === 'exec_command' &&
    isNioSelfInvocation((envelope.action.data as { command?: string }).command)
  ) {
    return { decision: 'allow' };
  }

  // Run ActionOrchestrator pipeline (Phase 1-6)
  try {
    const level = (options.config.guard?.protection_level || 'balanced') as ProtectionLevel;
    const rd: ActionDecision = await options.nio.orchestrator.evaluate(envelope, level);

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
