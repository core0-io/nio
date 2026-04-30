// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Nio — OpenClaw Plugin
 *
 * Registers before_tool_call, after_tool_call hooks with the OpenClaw
 * plugin API to evaluate tool safety at runtime and collect telemetry.
 *
 * Usage in OpenClaw plugin config:
 *   export { default } from '@core0-io/nio/openclaw';
 *
 * Or register manually:
 *   import { registerOpenClawPlugin } from '@core0-io/nio';
 *   registerOpenClawPlugin(api);
 */

import { OpenClawAdapter } from './openclaw.js';
import { evaluateHook } from './hook-engine.js';
import { loadConfig, writeAuditLog } from './common.js';
import type { WriteAuditLogOptions } from './common.js';
import type { AuditLifecycleEntry } from './audit-types.js';
import type { NioInstance } from './types.js';
import { ActionOrchestrator } from '../core/action-orchestrator.js';
import type { ProtectionLevel } from '../core/action-decision.js';
import { SkillScanner } from '../scanner/index.js';
import { dispatchNioCommand } from './openclaw-dispatch.js';
import { loadCollectorConfig } from '../scripts/lib/config-loader.js';
import {
  createTracerProvider,
  ensureTurn,
  recordPreToolUse,
  recordPreTaskToolUse,
  recordPostToolUse,
  recordPostTaskToolUse,
  endTurn,
  recordUserPrompt,
  recordAssistantReply,
  recordCacheHitRate,
  accumulateGenAiUsage,
  genAiToolCallInputAttributes,
  genAiToolCallOutputAttributes,
  nioGuardAttributes,
  nioToolRunIdAttribute,
  type CollectorState,
} from '../scripts/lib/traces-collector.js';
import { toolSummary } from '../scripts/lib/collector-core.js';
import { createMeterProvider, recordToolUse, recordTurn, recordGuardDecision } from '../scripts/lib/metrics-collector.js';
import { createLoggerProvider } from '../scripts/lib/logs-collector.js';

// ---------------------------------------------------------------------------
// In-memory turn / span state (same-process daemon, no disk persistence
// needed). All trace span construction routes through traces-collector's
// pure functions — the same ones Claude Code and Hermes use across
// processes via the deferred model. State per session lives in
// `sessionState`; pending guard-decision attrs that need to attach to a
// tool span at post time live in `pendingGuardAttrs` (a side channel
// because traces-collector's pure-function API has no mid-flight span
// mutation primitive).
// ---------------------------------------------------------------------------

const sessionState = new Map<string, CollectorState>();
const pendingGuardAttrs = new Map<string, Record<string, unknown>>();   // key: `${sessionId}:${spanKey}`

// ---------------------------------------------------------------------------
// OpenClaw Types (subset we use)
// ---------------------------------------------------------------------------

/**
 * OpenClaw plugin register API interface (subset we use).
 * Matches the `api` object passed to `register(api)` by OpenClaw's plugin loader.
 */
interface OpenClawRegisterApi {
  on(
    hookName: string,
    handler: (event: unknown, ctx?: unknown) => Promise<unknown> | unknown,
    opts?: { priority?: number }
  ): void;
  registerTool?(tool: OpenClawToolDefinition): void;
}

interface OpenClawToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    id: string,
    params: { command: string; commandName: string; skillName: string },
  ): Promise<{ content: Array<{ type: 'text'; text: string }> }>;
}

/**
 * OpenClaw plugin entry object shape.
 */
interface OpenClawPluginEntry {
  id: string;
  name: string;
  register(api: OpenClawRegisterApi): void;
}

// ---------------------------------------------------------------------------
// Plugin registration options
// ---------------------------------------------------------------------------

export interface OpenClawPluginOptions {
  /** Protection level (strict/balanced/permissive) */
  level?: string;
  /** Custom Nio instance factory */
  nioFactory?: () => NioInstance;
}

// ---------------------------------------------------------------------------
// Main Registration
// ---------------------------------------------------------------------------

/**
 * Register Nio hooks with OpenClaw plugin API
 */
export function registerOpenClawPlugin(
  api: OpenClawRegisterApi,
  options: OpenClawPluginOptions = {}
): void {
  const config = loadConfig();
  const guard = config.guard;
  if (options.level && guard) guard.protection_level = options.level as typeof guard.protection_level;

  const adapter = new OpenClawAdapter({ guardedTools: guard?.guarded_tools?.openclaw });
  const confirmAction = guard?.confirm_action ?? 'allow';

  const collectorConfig = loadCollectorConfig();
  const tracerProvider = createTracerProvider(collectorConfig);
  const meterProvider = createMeterProvider(collectorConfig);
  const logsConfig = config.collector?.logs;
  const loggerProvider = (logsConfig?.enabled !== false)
    ? createLoggerProvider(collectorConfig)
    : null;
  const auditOpts: WriteAuditLogOptions = { loggerProvider, logsConfig };

  const logger = (msg: string) => console.log(msg);

  // Lazy-initialize engine instance
  let nio: NioInstance | null = null;

  function getNio(): NioInstance {
    if (!nio) {
      if (options.nioFactory) {
        nio = options.nioFactory();
      } else {
        nio = {
          orchestrator: new ActionOrchestrator({
            level: (guard?.protection_level || 'balanced') as ProtectionLevel,
            allowedCommands: guard?.allowed_commands,
            allowlistMode: guard?.allowlist_mode,
            fileScanRules: guard?.file_scan_rules,
            actionGuardRules: guard?.action_guard_rules,
            scoringWeights: guard?.scoring_weights,
            llmEnabled: guard?.llm_analyser?.enabled ?? false,
            llmApiKey: guard?.llm_analyser?.api_key,
            llmModel: guard?.llm_analyser?.model,
            externalEnabled: guard?.external_analyser?.enabled ?? true,
            scoringEndpoint: guard?.external_analyser?.endpoint,
            scoringApiKey: guard?.external_analyser?.api_key,
            scoringTimeout: guard?.external_analyser?.timeout,
          }),
        };
      }
    }
    return nio!;
  }

  // before_tool_call → evaluate and optionally block
  api.on('before_tool_call', async (event: unknown, ctx: unknown) => {
    try {
      const toolEvent = event as {
        toolName?: string;
        params?: Record<string, unknown>;
        runId?: string;
        toolCallId?: string;
      };
      const c = (ctx ?? {}) as { sessionKey?: string; sessionId?: string; runId?: string };

      const toolName = toolEvent.toolName || 'unknown';
      const sessionId = c.sessionKey || c.sessionId || c.runId || toolEvent.runId || 'openclaw';
      const spanKey = toolEvent.toolCallId || toolName;
      const cwd = process.cwd();
      const fullKey = `${sessionId}:${spanKey}`;

      // Record pre-tool span data into per-session state. Span is not
      // emitted yet — the post side (after_tool_call OR the block path
      // below) reconstructs it via recordPostToolUse.
      if (tracerProvider) {
        let state = sessionState.get(sessionId) ?? null;
        state = ensureTurn(state, sessionId);
        const params = (toolEvent.params ?? {}) as Record<string, unknown>;
        const preAttrs: Record<string, unknown> = {
          ...genAiToolCallInputAttributes(params, toolEvent.toolCallId),
          ...(toolEvent.runId ? nioToolRunIdAttribute(toolEvent.runId) : {}),
        };
        state = recordPreToolUse(state, spanKey, toolName, toolSummary(toolName, params), preAttrs);
        sessionState.set(sessionId, state);
      }
      if (meterProvider) {
        recordToolUse(meterProvider, toolName, 'PreToolUse', 'openclaw').catch(() => {});
      }

      const result = await evaluateHook(adapter, event, {
        config,
        nio: getNio(),
      }, auditOpts);

      // Record guard decision metrics
      if (meterProvider) {
        recordGuardDecision(
          meterProvider,
          result.decision,
          result.riskLevel || 'low',
          result.riskScore ?? 0,
          toolName,
          'openclaw',
        ).catch(() => {});
      }

      // Categorise guard decision and stash attrs to merge onto the
      // tool span at post time. `decision` here is the user-visible
      // taxonomy (allow / deny / confirm_allowed / confirm_denied).
      const isBlock =
        result.decision === 'deny' || (result.decision === 'ask' && confirmAction === 'deny');
      const decisionTag =
        result.decision === 'deny'
          ? 'deny'
          : result.decision === 'ask'
            ? confirmAction === 'deny'
              ? 'confirm_denied'
              : 'confirm_allowed'
            : 'allow';
      const guardAttrs = nioGuardAttributes(
        decisionTag,
        result.riskLevel || (decisionTag === 'allow' ? 'low' : 'unknown'),
        result.riskScore ?? 0,
        result.riskTags,
      );
      pendingGuardAttrs.set(fullKey, guardAttrs);

      // Block path: after_tool_call won't fire because the tool didn't
      // run. Flush the orphan post-span here with guard-error status.
      if (isBlock) {
        const reason =
          result.reason || (decisionTag === 'deny' ? 'Blocked by Nio' : 'Requires confirmation (Nio)');
        if (tracerProvider) {
          const state = sessionState.get(sessionId);
          if (state) {
            const r = await recordPostToolUse(
              tracerProvider, state, spanKey, 'openclaw', cwd,
              guardAttrs,
              reason,
            );
            sessionState.set(sessionId, r.state);
          }
        }
        pendingGuardAttrs.delete(fullKey);
        return { block: true, blockReason: reason };
      }

      // Allow / confirm_allowed: leave guardAttrs in pendingGuardAttrs;
      // after_tool_call will drain and emit the span.
      return undefined;
    } catch {
      // Fail open
      return undefined;
    }
  });

  // after_tool_call → audit log + collector (fire-and-forget)
  api.on('after_tool_call', async (event: unknown, ctx: unknown) => {
    try {
      const toolEvent = event as {
        toolName?: string;
        params?: Record<string, unknown>;
        runId?: string;
        toolCallId?: string;
        result?: unknown;
        error?: string;
        durationMs?: number;
      };
      const c = (ctx ?? {}) as { sessionKey?: string; sessionId?: string; runId?: string };

      const toolName = toolEvent.toolName || 'unknown';
      const sessionId = c.sessionKey || c.sessionId || c.runId || toolEvent.runId || 'openclaw';
      const spanKey = toolEvent.toolCallId || toolName;
      const cwd = process.cwd();
      const fullKey = `${sessionId}:${spanKey}`;

      if (tracerProvider) {
        const state = sessionState.get(sessionId);
        if (state) {
          const guardAttrs = pendingGuardAttrs.get(fullKey) ?? {};
          pendingGuardAttrs.delete(fullKey);
          const postAttrs: Record<string, unknown> = {
            ...guardAttrs,
            ...genAiToolCallOutputAttributes({
              result: toolEvent.result,
              error: toolEvent.error ?? null,
              durationMs: toolEvent.durationMs,
            }),
          };
          const r = await recordPostToolUse(
            tracerProvider, state, spanKey, 'openclaw', cwd,
            postAttrs,
            toolEvent.error ?? null,
          );
          sessionState.set(sessionId, r.state);
        }
      }
      if (meterProvider) {
        await recordToolUse(meterProvider, toolName, 'PostToolUse', 'openclaw');
      }
    } catch {
      // Non-critical
    }
  });

  // subagent_spawning → collector pre-task span
  api.on('subagent_spawning', async (event: unknown, ctx: unknown) => {
    try {
      const e = event as { subagentId?: string; runId?: string };
      const c = (ctx ?? {}) as { sessionKey?: string; sessionId?: string; runId?: string };
      const lifecycleEntry: AuditLifecycleEntry = {
        event: 'lifecycle',
        timestamp: new Date().toISOString(),
        platform: 'openclaw',
        session_id: c.sessionKey || c.sessionId || c.runId || e.runId || 'openclaw',
        lifecycle_type: 'subagent_spawning',
        details: { subagent_id: e.subagentId, run_id: e.runId },
      };
      writeAuditLog(lifecycleEntry, auditOpts);
      const taskId = e.subagentId || e.runId || 'unknown';
      const sessionId = c.sessionKey || c.sessionId || c.runId || e.runId || 'openclaw';
      if (tracerProvider) {
        let state = sessionState.get(sessionId) ?? null;
        state = ensureTurn(state, sessionId);
        state = recordPreTaskToolUse(state, taskId, '');
        sessionState.set(sessionId, state);
      }
      if (meterProvider) {
        await recordToolUse(meterProvider, 'Task', 'TaskCreated', 'openclaw');
      }
    } catch {
      // Non-critical
    }
  });

  // subagent_ended → collector post-task span
  api.on('subagent_ended', async (event: unknown, ctx: unknown) => {
    try {
      const e = event as { subagentId?: string; runId?: string };
      const c = (ctx ?? {}) as { sessionKey?: string; sessionId?: string; runId?: string };
      const endEntry: AuditLifecycleEntry = {
        event: 'lifecycle',
        timestamp: new Date().toISOString(),
        platform: 'openclaw',
        session_id: c.sessionKey || c.sessionId || c.runId || e.runId || 'openclaw',
        lifecycle_type: 'subagent_ended',
        details: { subagent_id: e.subagentId, run_id: e.runId },
      };
      writeAuditLog(endEntry, auditOpts);
      const taskId = e.subagentId || e.runId || 'unknown';
      const sessionId = c.sessionKey || c.sessionId || c.runId || e.runId || 'openclaw';
      const cwd = process.cwd();
      if (tracerProvider) {
        const state = sessionState.get(sessionId);
        if (state) {
          const r = await recordPostTaskToolUse(tracerProvider, state, taskId, 'openclaw', cwd);
          sessionState.set(sessionId, r.state);
        }
      }
      if (meterProvider) {
        await recordToolUse(meterProvider, 'Task', 'TaskCompleted', 'openclaw');
      }
    } catch {
      // Non-critical
    }
  });

  // before_agent_reply → capture user prompt onto turn state (applied
  // to the turn span at endTurn time).
  api.on('before_agent_reply', async (event: unknown, ctx: unknown) => {
    try {
      const e = event as { cleanedBody?: string };
      const c = (ctx ?? {}) as { sessionKey?: string; sessionId?: string; runId?: string };
      const sessionId = c.sessionKey || c.sessionId || c.runId || 'openclaw';
      if (tracerProvider && e.cleanedBody) {
        let state = sessionState.get(sessionId) ?? null;
        state = ensureTurn(state, sessionId);
        state = recordUserPrompt(state, e.cleanedBody);
        sessionState.set(sessionId, state);
      }
    } catch { /* non-critical */ }
  });

  // llm_output → accumulate token usage + capture assistant reply
  api.on('llm_output', async (event: unknown, ctx: unknown) => {
    try {
      const e = event as { assistantTexts?: string[]; usage?: Record<string, number> };
      const c = (ctx ?? {}) as { sessionKey?: string; sessionId?: string; runId?: string };
      const sessionId = c.sessionKey || c.sessionId || c.runId || 'openclaw';

      let state = sessionState.get(sessionId) ?? null;
      state = ensureTurn(state, sessionId);

      if (e.usage) {
        state = accumulateGenAiUsage(state, {
          input: e.usage['input'] as number,
          output: e.usage['output'] as number,
          cacheRead: e.usage['cacheRead'] as number,
          cacheWrite: e.usage['cacheWrite'] as number,
        });
      }

      if (tracerProvider && e.assistantTexts?.length) {
        state = recordAssistantReply(state, e.assistantTexts.join('\n'));
      }

      sessionState.set(sessionId, state);
    } catch { /* non-critical */ }
  });

  // agent_end → end-turn span flush
  // session_start: hard session boundary. Reset turn counters so a
  // fresh session doesn't inherit numbering from a previous one.
  // Flush an active session: compute cache_hit_rate, defensively close
  // any leftover pending tool/task spans, emit the turn root span, and
  // drop the per-session state. Idempotent: no-op if no state exists.
  async function flushSessionTurn(sessionId: string): Promise<void> {
    if (!tracerProvider) return;
    let state = sessionState.get(sessionId);
    if (!state) return;

    state = recordCacheHitRate(state);

    for (const k of Object.keys(state.pending_spans)) {
      const r = await recordPostToolUse(tracerProvider, state, k, 'openclaw', process.cwd(), {}, null);
      state = r.state;
    }
    for (const k of Object.keys(state.pending_task_spans ?? {})) {
      const r = await recordPostTaskToolUse(tracerProvider, state, k, 'openclaw', process.cwd());
      state = r.state;
    }

    await endTurn(tracerProvider, state, 'openclaw', process.cwd());
    sessionState.delete(sessionId);
    pendingGuardAttrs.forEach((_, k) => { if (k.startsWith(`${sessionId}:`)) pendingGuardAttrs.delete(k); });
    await tracerProvider.forceFlush();
  }

  api.on('session_start', async (_event: unknown, ctx: unknown) => {
    try {
      const c = (ctx ?? {}) as { sessionKey?: string; sessionId?: string; runId?: string };
      const sessionId = c.sessionKey || c.sessionId || c.runId || 'openclaw';
      sessionState.delete(sessionId);
      const entry: AuditLifecycleEntry = {
        event: 'lifecycle',
        timestamp: new Date().toISOString(),
        platform: 'openclaw',
        session_id: sessionId,
        lifecycle_type: 'session_start',
      };
      writeAuditLog(entry, auditOpts);
    } catch {
      // Non-critical
    }
  });

  // session_end: hard session boundary. Defensively close any in-flight
  // turn span — agent_end usually handles this per-turn, but
  // session_end is the last-resort flush before a session is torn down.
  api.on('session_end', async (_event: unknown, ctx: unknown) => {
    try {
      const c = (ctx ?? {}) as { sessionKey?: string; sessionId?: string; runId?: string };
      const sessionId = c.sessionKey || c.sessionId || c.runId || 'openclaw';
      const entry: AuditLifecycleEntry = {
        event: 'lifecycle',
        timestamp: new Date().toISOString(),
        platform: 'openclaw',
        session_id: sessionId,
        lifecycle_type: 'session_end',
      };
      writeAuditLog(entry, auditOpts);
      await flushSessionTurn(sessionId);
    } catch {
      // Non-critical
    }
  });

  api.on('agent_end', async (_event: unknown, ctx: unknown) => {
    try {
      const c = (ctx ?? {}) as { sessionKey?: string; sessionId?: string; runId?: string };
      const sessionId = c.sessionKey || c.sessionId || c.runId || 'openclaw';
      const agentEndEntry: AuditLifecycleEntry = {
        event: 'lifecycle',
        timestamp: new Date().toISOString(),
        platform: 'openclaw',
        session_id: sessionId,
        lifecycle_type: 'agent_end',
      };
      writeAuditLog(agentEndEntry, auditOpts);
      await flushSessionTurn(sessionId);
      if (meterProvider) {
        await recordTurn(meterProvider, 'openclaw');
      }
      if (loggerProvider) {
        await loggerProvider.forceFlush();
      }
    } catch {
      // Non-critical
    }
  });

  // Register the `/nio` slash-command tool (dispatched directly, bypassing the LLM
  // via SKILL.md's `command-dispatch: tool`).
  if (typeof api.registerTool === 'function') {
    const scanner = new SkillScanner({ fileScanRules: guard?.file_scan_rules });
    api.registerTool({
      name: 'nio_command',
      description:
        'Dispatcher for the /nio slash command. Forwards raw args to the in-process Nio subcommand router (config, action, scan, report, reset).',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Raw args string after /nio' },
          commandName: { type: 'string' },
          skillName: { type: 'string' },
        },
        required: ['command', 'commandName', 'skillName'],
      },
      async execute(_id, params) {
        try {
          const text = await dispatchNioCommand(params.command ?? '', {
            orchestrator: getNio().orchestrator,
            scanner,
          });
          return { content: [{ type: 'text', text }] };
        } catch (err) {
          const msg = err instanceof Error ? err.stack || err.message : String(err);
          return { content: [{ type: 'text', text: `[nio_command error] ${msg}` }] };
        }
      },
    });
  }

  logger(`[Nio] Registered with OpenClaw (protection level: ${guard?.protection_level || 'balanced'})`);
}

/**
 * Default export — OpenClaw plugin entry object.
 *
 * Usage: export { default } from '@core0-io/nio/openclaw'
 */
const pluginEntry: OpenClawPluginEntry = {
  id: 'nio',
  name: 'Nio',
  register(api: OpenClawRegisterApi): void {
    registerOpenClawPlugin(api);
  },
};

export default pluginEntry;
