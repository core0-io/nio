// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import type { HookAdapter, HookInput, HookOutput, EngineOptions } from './types.js';
import { writeAuditLog, buildGuardAuditEntry } from './common.js';
import type { WriteAuditLogOptions } from './common.js';
import type { ActionDecision } from '../core/action-orchestrator.js';
import type { ProtectionLevel } from '../core/action-decision.js';
import type { ActionEnvelope, McpToolCallData } from '../types/action.js';
import {
  detectMcpCalls,
  extractCommandString,
  type RoutedMcpCall,
} from './mcp-route-detect/index.js';
import { loadMCPRegistry } from './mcp-registry.js';
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

  const diagnostics = rd.diagnostics?.length ? rd.diagnostics : undefined;
  const phaseStopped = rd.phase_stopped;
  const topFindingRule = rd.findings[0]?.rule_id;

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
      phaseStopped,
      ...(topFindingRule ? { topFindingRule } : {}),
      initiatingSkill,
      diagnostics,
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
      phaseStopped,
      ...(topFindingRule ? { topFindingRule } : {}),
      initiatingSkill,
      diagnostics,
    };
  }

  return {
    decision: 'allow',
    riskLevel: rd.risk_level,
    riskScore: finalScore,
    phaseStopped,
    ...(topFindingRule ? { topFindingRule } : {}),
    initiatingSkill,
    diagnostics,
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
 * - Claude Code and Codex expose MCP tools as `mcp__<server>__<tool>`.
 * - OpenClaw exposes MCP tools as `<safeServerName>__<tool>` (native tools
 *   never contain `__`, so the separator is a reliable marker).
 */
export function parseMcpToolName(toolName: string, platform: string): ParsedMcpToolName {
  const name = toolName ?? '';

  if ((platform === 'claude-code' || platform === 'codex') && name.startsWith('mcp__')) {
    const rest = name.slice(5);
    const idx = rest.indexOf('__');
    if (idx > 0 && idx < rest.length - 2) {
      return { isMcp: true, server: rest.slice(0, idx), local: rest.slice(idx + 2) };
    }
    return { isMcp: false };
  }

  // Hermes uses the same `<server>__<tool>` format as OpenClaw — see
  // plugins/hermes/config.default.yaml notes on `permitted_tools.mcp`.
  if (platform === 'openclaw' || platform === 'hermes') {
    const idx = name.indexOf('__');
    if (idx > 0 && idx < name.length - 2) {
      return { isMcp: true, server: name.slice(0, idx), local: name.slice(idx + 2) };
    }
    // Hermes-only fallback: `mcp_<...>` single-underscore convention.
    // Hermes flattens MCP server+tool with `_` separators
    // (`mcp_<server>_<tool>`), making a reliable server/tool split
    // impossible. We keep the FULL tool name as `local` and leave
    // `server` unset — so users can list the tool name verbatim in
    // `permitted_tools.mcp` / `blocked_tools.mcp` exactly as they see
    // it in the Hermes hook payload (no prefix-stripping mental gymnastics).
    if (platform === 'hermes' && name.startsWith('mcp_') && name.length > 4) {
      return { isMcp: true, local: name };
    }
    return { isMcp: false };
  }

  return { isMcp: false };
}

/**
 * Build an `mcp_tool_call` envelope from a parsed MCP tool name plus the
 * raw `tool_input` payload. Adapters call this from `buildEnvelope()` as
 * the fallback path when their `nativeToolMapping` doesn't match —
 * MCP tools are dynamic and not enumerated in the mapping table, but
 * they should still flow through Phase 1-6 deep analysis.
 *
 * `parsed.server` may be undefined when the platform's naming convention
 * doesn't permit a reliable server/tool split (e.g. Hermes single-
 * underscore `mcp_<...>` form). Stored as `null` in the envelope so it
 * round-trips through JSON cleanly.
 */
export function buildMcpEnvelope(
  input: HookInput,
  parsed: ParsedMcpToolName,
  initiatingSkill: string | null | undefined,
  platform: string,
): ActionEnvelope {
  const actor = {
    skill: {
      id: initiatingSkill || `${platform}-session`,
      source: initiatingSkill || platform,
      version_ref: '0.0.0',
      artifact_hash: '',
    },
  };

  const context = {
    session_id: input.sessionId || `${platform}-mcp-${Date.now()}`,
    user_present: true,
    env: 'prod' as const,
    time: new Date().toISOString(),
    initiating_skill: initiatingSkill || undefined,
  };

  const data: McpToolCallData = {
    server: parsed.server ?? null,
    tool: parsed.local ?? input.toolName,
    args: input.toolInput ?? {},
  };

  return {
    actor,
    action: { type: 'mcp_tool_call', data },
    context,
  };
}

function matchesCaseInsensitive(list: readonly string[], candidates: readonly string[]): boolean {
  const lowered = candidates.map(c => c.toLowerCase());
  return list.some(entry => lowered.includes(entry.toLowerCase()));
}

/**
 * Used when a shell-side detector resolves an MCP server but cannot extract
 * the tool name (e.g. raw TCP, body shape we can't decode). Returns true if
 * any entry in `mcpList` could plausibly be a tool on `server`:
 *   - bare entries (no `__`) are candidate tool names regardless of server
 *   - `server__tool` entries only count if the prefix matches this server
 * Used by blocked_tools (bias toward deny on ambiguous hits).
 */
function ambiguousServerHit(server: string, mcpList: readonly string[]): boolean {
  const serverLower = server.toLowerCase();
  return mcpList.some(entry => {
    const lower = entry.toLowerCase();
    if (!lower.includes('__')) return true;
    return lower.startsWith(`${serverLower}__`);
  });
}

/**
 * Phase 0: Tool-level gate.
 *
 * Checks `blocked_tools` and `permitted_tools` from config before any
 * content-level analysis. Returns a deny HookOutput if the tool is
 * blocked or not in the permitted list; null to proceed to Phase 1-6.
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
  injectedRegistry?: ReturnType<typeof loadMCPRegistry>,
): HookOutput | null {
  const platformKey = platform.replace(/-/g, '_');
  const blockedPlatform = config.guard?.blocked_tools?.[platformKey] ?? [];
  const permittedPlatform = config.guard?.permitted_tools?.[platformKey] ?? [];
  const blockedMcp = config.guard?.blocked_tools?.['mcp'] ?? [];
  const permittedMcp = config.guard?.permitted_tools?.['mcp'] ?? [];

  const parsed = parseMcpToolName(toolName, platform);
  const nameMcpCandidates = parsed.isMcp && parsed.local
    ? (parsed.server
        ? [parsed.local, `${parsed.server}__${parsed.local}`]
        : [parsed.local])
    : [];

  const registry = injectedRegistry ?? loadMCPRegistry();
  const allShellHits = detectMcpCalls(extractCommandString(toolInput), registry);
  // Audit-only hits (D12 self-launch, D15 compile-and-run, D16 obfuscation
  // fallback) inform the audit pipeline but must not gate execution.
  const shellHits = allShellHits.filter(h => !h.auditOnly);
  const shellMcpCandidates = shellHits.flatMap(h =>
    h.tool ? [h.tool, `${h.server}__${h.tool}`] : [`${h.server}__*`]);

  const allMcpCandidates = [...nameMcpCandidates, ...shellMcpCandidates];
  const hasMcpContext = parsed.isMcp || shellHits.length > 0;

  // --- Blocked (additive: any hit denies) ---
  const nameBlocked = blockedPlatform.length > 0 && matchesCaseInsensitive(blockedPlatform, [toolName]);
  const nativeMcpBlocked = parsed.isMcp && blockedMcp.length > 0
    && matchesCaseInsensitive(blockedMcp, nameMcpCandidates);
  const shellMcpBlockHit: RoutedMcpCall | undefined = blockedMcp.length > 0 && shellHits.length > 0
    ? shellHits.find(h => {
        const cands = h.tool ? [h.tool, `${h.server}__${h.tool}`] : [`${h.server}__*`, h.server];
        if (matchesCaseInsensitive(blockedMcp, cands)) return true;
        // Bias toward deny when detector resolved a server but not a tool
        // (e.g. `nc host port`, `python urlopen(URL)` with a body shape we
        // can't statically decode). Any blocked_tools.mcp entry that *could*
        // be a tool on this server triggers — bare entries (no `__`) might
        // match any server; server-qualified entries (`server__tool`) only
        // count if they target THIS server. Trade-off: also denies legit
        // indirect calls to non-blocked tools on the same server. Users who
        // need fine-grained allow/deny on the same server should switch to
        // permitted_tools.mcp allowlist mode.
        if (h.tool) return false;
        return ambiguousServerHit(h.server, blockedMcp);
      })
    : undefined;

  if (nameBlocked || nativeMcpBlocked || shellMcpBlockHit) {
    const reason = (shellMcpBlockHit && !nameBlocked && !nativeMcpBlocked)
      ? `Tool "${shellMcpBlockHit.server}__${shellMcpBlockHit.tool ?? '*'}" is blocked (blocked_tools; invoked via ${shellMcpBlockHit.via})`
      : `Tool "${toolName}" is blocked (blocked_tools)`;
    return {
      decision: 'deny',
      reason: policyHookReason(reason, '', ['TOOL_GATE_BLOCKED'], 'critical', 1.0),
      riskLevel: 'critical',
      riskScore: 1.0,
      riskTags: ['TOOL_GATE_BLOCKED'],
      phaseStopped: 0,
      topFindingRule: 'TOOL_GATE_BLOCKED',
    };
  }

  // --- Permitted (namespaced: mcp and platform lists gate independently) ---
  if (hasMcpContext) {
    if (permittedMcp.length > 0) {
      if (!matchesCaseInsensitive(permittedMcp, allMcpCandidates)) {
        return denyNotPermitted(toolName);
      }
    } else if (permittedPlatform.length > 0 && !matchesCaseInsensitive(permittedPlatform, [toolName])) {
      return denyNotPermitted(toolName);
    }
  } else if (permittedPlatform.length > 0 && !matchesCaseInsensitive(permittedPlatform, [toolName])) {
    return denyNotPermitted(toolName);
  }

  return null;
}

function denyNotPermitted(toolName: string): HookOutput {
  return {
    decision: 'deny',
    reason: policyHookReason(
      `Tool "${toolName}" is not permitted (permitted_tools)`, '', ['TOOL_GATE_NOT_PERMITTED'], 'critical', 1.0
    ),
    riskLevel: 'critical',
    riskScore: 1.0,
    riskTags: ['TOOL_GATE_NOT_PERMITTED'],
    phaseStopped: 0,
    topFindingRule: 'TOOL_GATE_NOT_PERMITTED',
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

  // Resolve telemetry identity: user-configured `agent_name` overrides
  // the platform-derived default. Empty/unset → fall back to platform
  // (preserves today's behaviour where gen_ai.agent.name = platform).
  const agentName = options.config.agent_name && options.config.agent_name.length > 0
    ? options.config.agent_name
    : undefined;

  // Phase 0: Tool-level gate
  const t0 = performance.now();
  const toolGate = checkToolGate(input.toolName, input.toolInput, options.config, adapter.name, options.mcpRegistry);
  const t0End = performance.now();
  if (toolGate) {
    const skill = await adapter.inferInitiatingSkill(input);
    const entry = buildGuardAuditEntry(input, null, skill, adapter.name, undefined, agentName);
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
  let envelope = adapter.buildEnvelope(input, initiatingSkill);

  // MCP fallback: when the adapter can't classify the tool via its native
  // mapping, check whether the name matches the platform's MCP convention
  // and build an `mcp_tool_call` envelope so Phase 1-6 still runs. This
  // lifts MCP calls from "silent allow" to first-class actions evaluated
  // by all rules + analysers.
  if (!envelope && input.toolName) {
    const parsed = parseMcpToolName(input.toolName, adapter.name);
    if (parsed.isMcp && parsed.local) {
      envelope = buildMcpEnvelope(input, parsed, initiatingSkill, adapter.name);
    }
  }

  if (!envelope) {
    // Truly uncategorised tool — not in `native_tool_mapping`, not an MCP
    // call. Allow but record the pass-through so the audit log has a row
    // for every tool invocation. The `UNCATEGORIZED_TOOL` risk tag makes
    // these visible in /nio report and downstream queries.
    const entry = buildGuardAuditEntry(input, null, initiatingSkill, adapter.name, undefined, agentName);
    entry.decision = 'allow';
    entry.risk_level = 'low';
    entry.risk_score = 0;
    entry.risk_tags = ['UNCATEGORIZED_TOOL'];
    entry.explanation =
      `Tool "${input.toolName}" has no action mapping; passed through without Phase 1-6 analysis`;
    entry.phase_stopped = 0;
    writeAuditLog(entry, auditOpts);
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
      input, rd, initiatingSkill, adapter.name, envelope.action.type, agentName,
    );
    writeAuditLog(entry, auditOpts);

    return runtimeDecisionToHookOutput(rd, initiatingSkill);
  } catch {
    // Engine error → fail open
    const entry = buildGuardAuditEntry(input, null, initiatingSkill, adapter.name, undefined, agentName);
    entry.decision = 'error';
    entry.risk_tags = ['ENGINE_ERROR'];
    writeAuditLog(entry, auditOpts);
    return { decision: 'allow' };
  }
}
