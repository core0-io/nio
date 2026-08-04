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
import { isSessionMonitored, forgetSession } from '../scripts/lib/monitor-check.js';
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

/**
 * Drop all in-memory state associated with a session — its turn/pending-
 * span state and any (session, span) guard-attr scratch entries.
 *
 * Must run regardless of monitor state, and must never be skipped just
 * because a session is currently unmonitored: a session that accumulated
 * real state (user prompts, assistant replies, pending spans) while
 * armed, and was then disarmed before a lifecycle boundary fired, must
 * not have that state survive to be exported later if the session is
 * re-armed. Only *exporting* what's here is conditional on monitor
 * state (see flushSessionTurn) — clearing it is not.
 */
function clearSessionState(sessionId: string): void {
  sessionState.delete(sessionId);
  const prefix = `${sessionId}:`;
  for (const k of pendingGuardAttrs.keys()) {
    if (k.startsWith(prefix)) pendingGuardAttrs.delete(k);
  }
}

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

  const adapter = new OpenClawAdapter({ nativeToolMapping: guard?.native_tool_mapping?.openclaw });
  const confirmAction = guard?.confirm_action ?? 'allow';

  const collectorConfig = loadCollectorConfig();
  // Resource-level agent name is only set when the operator actually
  // configured one — empty / unset means "no gen_ai.agent.name on the
  // resource". Span-level fallback (used by endTurn below) keeps its
  // own platform-default behaviour.
  const resourceAgentName = config.agent_name && config.agent_name.length > 0
    ? config.agent_name
    : undefined;
  const tracerProvider = createTracerProvider(collectorConfig, 'openclaw', resourceAgentName);
  const meterProvider = createMeterProvider(collectorConfig, 'openclaw', resourceAgentName);
  const logsConfig = config.collector?.logs;
  const loggerProvider = (logsConfig?.enabled !== false)
    ? createLoggerProvider(collectorConfig, 'openclaw', resourceAgentName)
    : null;
  // Per-session monitor gate. OpenClaw is a long-running daemon — unlike
  // Claude Code / Codex / Hermes, which spawn a fresh process per hook
  // event and can decide "monitored or not" once, before any provider
  // exists, the providers here are created once at plugin registration
  // and shared by every session for the process's lifetime. So the gate
  // has to be re-checked inside each handler, keyed by that event's
  // session id, and only the OTEL-writing part of the handler skipped
  // when unmonitored — never the guard evaluation itself (see
  // before_tool_call below, the one handler where that distinction
  // matters).
  //
  // `writeAuditLog`'s local-JSONL leg must never be gated (Constraint 2:
  // local audit keeps writing regardless of monitor state) — only its
  // OTEL LogRecord leg, which fires exclusively when a loggerProvider is
  // passed in. `auditOptsFor` gives each call site a per-event opts
  // object that suppresses just that leg by omitting the provider,
  // mirroring how hook-cli.ts nulls out a freshly-constructed
  // loggerProvider for an unmonitored session — here the provider is
  // long-lived, so the suppression has to happen per-call instead.
  function auditOptsFor(monitored: boolean): WriteAuditLogOptions {
    return { loggerProvider: monitored ? loggerProvider : null, logsConfig };
  }

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
            externalAnalysers: guard?.external_analyser ?? [],
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
      const monitored = isSessionMonitored(sessionId, cwd, logsConfig);

      // Record pre-tool span data into per-session state. Span is not
      // emitted yet — the post side (after_tool_call OR the block path
      // below) reconstructs it via recordPostToolUse. Gated: an
      // unmonitored session must not accumulate pending-span state in
      // this long-lived process either — nothing downstream would ever
      // drain it.
      if (monitored && tracerProvider) {
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
      if (monitored && meterProvider) {
        recordToolUse(meterProvider, toolName, 'PreToolUse').catch(() => {});
      }

      // Guard evaluation and the block decision below run unconditionally
      // — the monitor gate only controls telemetry, never enforcement.
      // Only the OTEL LogRecord leg of any audit entries evaluateHook
      // writes is suppressed when unmonitored (auditOptsFor); the local
      // JSONL leg always fires.
      const evalStartMs = Date.now();
      const result = await evaluateHook(adapter, event, {
        config,
        nio: getNio(),
      }, auditOptsFor(monitored));
      const evalMs = Date.now() - evalStartMs;

      // Record guard decision metrics
      if (monitored && meterProvider) {
        recordGuardDecision(
          meterProvider,
          result.decision,
          result.riskLevel || 'low',
          result.riskScore ?? 0,
          toolName,
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
      const guardAttrs: Record<string, unknown> = {
        ...nioGuardAttributes(
          decisionTag,
          result.riskLevel || (decisionTag === 'allow' ? 'low' : 'unknown'),
          result.riskScore ?? 0,
          result.riskTags,
          result.phaseStopped,
          result.topFindingRule,
        ),
        'nio.guard.eval_ms': evalMs,
      };
      if (monitored) pendingGuardAttrs.set(fullKey, guardAttrs);

      // Block path: after_tool_call won't fire because the tool didn't
      // run. Flush the orphan post-span here with guard-error status.
      if (isBlock) {
        const reason =
          result.reason || (decisionTag === 'deny' ? 'Blocked by Nio' : 'Requires confirmation (Nio)');
        if (monitored && tracerProvider) {
          const state = sessionState.get(sessionId);
          if (state) {
            const r = await recordPostToolUse(
              tracerProvider, state, spanKey, cwd,
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

  // after_tool_call → collector span close (fire-and-forget; no local
  // audit entry is written from this handler — the audit trail for a
  // tool call lives entirely in before_tool_call's evaluateHook call).
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
      const monitored = isSessionMonitored(sessionId, cwd, logsConfig);

      // pendingGuardAttrs is a (session, span) scratch entry written by
      // before_tool_call — clear it here regardless of monitor state so
      // a value written while armed doesn't outlive this tool call. Must
      // happen before the early return below, not after: an early
      // return that skips this would leave the entry in the module-level
      // map for the rest of the process's lifetime if the session never
      // reaches another cleanup point.
      const guardAttrs = pendingGuardAttrs.get(fullKey) ?? {};
      pendingGuardAttrs.delete(fullKey);
      if (!monitored) return;

      if (tracerProvider) {
        const state = sessionState.get(sessionId);
        if (state) {
          const postAttrs: Record<string, unknown> = {
            ...guardAttrs,
            ...genAiToolCallOutputAttributes({
              result: toolEvent.result,
              error: toolEvent.error ?? null,
              durationMs: toolEvent.durationMs,
            }),
          };
          const r = await recordPostToolUse(
            tracerProvider, state, spanKey, cwd,
            postAttrs,
            toolEvent.error ?? null,
          );
          sessionState.set(sessionId, r.state);
        }
      }
      if (meterProvider) {
        await recordToolUse(meterProvider, toolName, 'PostToolUse');
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
      const sessionId = c.sessionKey || c.sessionId || c.runId || e.runId || 'openclaw';
      const monitored = isSessionMonitored(sessionId, process.cwd(), logsConfig);
      const lifecycleEntry: AuditLifecycleEntry = {
        event: 'lifecycle',
        timestamp: new Date().toISOString(),
        platform: 'openclaw',
        session_id: sessionId,
        lifecycle_type: 'subagent_spawning',
        details: { subagent_id: e.subagentId, run_id: e.runId },
      };
      writeAuditLog(lifecycleEntry, auditOptsFor(monitored));
      const taskId = e.subagentId || e.runId || 'unknown';
      if (monitored && tracerProvider) {
        let state = sessionState.get(sessionId) ?? null;
        state = ensureTurn(state, sessionId);
        state = recordPreTaskToolUse(state, taskId, '');
        sessionState.set(sessionId, state);
      }
      if (monitored && meterProvider) {
        await recordToolUse(meterProvider, 'Task', 'TaskCreated');
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
      const sessionId = c.sessionKey || c.sessionId || c.runId || e.runId || 'openclaw';
      const cwd = process.cwd();
      const monitored = isSessionMonitored(sessionId, cwd, logsConfig);
      const endEntry: AuditLifecycleEntry = {
        event: 'lifecycle',
        timestamp: new Date().toISOString(),
        platform: 'openclaw',
        session_id: sessionId,
        lifecycle_type: 'subagent_ended',
        details: { subagent_id: e.subagentId, run_id: e.runId },
      };
      writeAuditLog(endEntry, auditOptsFor(monitored));
      const taskId = e.subagentId || e.runId || 'unknown';
      if (monitored && tracerProvider) {
        const state = sessionState.get(sessionId);
        if (state) {
          const r = await recordPostTaskToolUse(tracerProvider, state, taskId, cwd);
          sessionState.set(sessionId, r.state);
        }
      }
      if (monitored && meterProvider) {
        await recordToolUse(meterProvider, 'Task', 'TaskCompleted');
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
      if (!isSessionMonitored(sessionId, process.cwd(), logsConfig)) return;
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
      if (!isSessionMonitored(sessionId, process.cwd(), logsConfig)) return;

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
  //
  // Cleanup (clearSessionState) and export (recordPostToolUse / endTurn /
  // forceFlush) are deliberately separate concerns here: an unmonitored
  // session must still have its state cleared — otherwise state
  // accumulated while briefly armed (then disarmed before this boundary
  // fired) would sit in `sessionState` for the rest of the daemon's
  // process lifetime, and worse, get exported later if the session is
  // re-armed and a subsequent boundary event finds that same leftover
  // state still there. Only the export side is conditional on
  // `monitored`.
  async function flushSessionTurn(sessionId: string, monitored: boolean): Promise<void> {
    let state = sessionState.get(sessionId);
    if (!state) return;

    if (!monitored || !tracerProvider) {
      clearSessionState(sessionId);
      return;
    }

    state = recordCacheHitRate(state);

    for (const k of Object.keys(state.pending_spans)) {
      const r = await recordPostToolUse(tracerProvider, state, k, process.cwd(), {}, null);
      state = r.state;
    }
    for (const k of Object.keys(state.pending_task_spans ?? {})) {
      const r = await recordPostTaskToolUse(tracerProvider, state, k, process.cwd());
      state = r.state;
    }

    await endTurn(tracerProvider, state, process.cwd());
    clearSessionState(sessionId);
    await tracerProvider.forceFlush();
  }

  api.on('session_start', async (_event: unknown, ctx: unknown) => {
    try {
      const c = (ctx ?? {}) as { sessionKey?: string; sessionId?: string; runId?: string };
      const sessionId = c.sessionKey || c.sessionId || c.runId || 'openclaw';
      const monitored = isSessionMonitored(sessionId, process.cwd(), logsConfig);
      // In-memory housekeeping, not an OTEL write — must run
      // unconditionally regardless of monitor state (see
      // clearSessionState: a fresh session id must not inherit stale
      // state left over from a same-id session that was armed,
      // accumulated state, and disarmed before it ended).
      clearSessionState(sessionId);
      const entry: AuditLifecycleEntry = {
        event: 'lifecycle',
        timestamp: new Date().toISOString(),
        platform: 'openclaw',
        session_id: sessionId,
        lifecycle_type: 'session_start',
      };
      writeAuditLog(entry, auditOptsFor(monitored));
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
      const monitored = isSessionMonitored(sessionId, process.cwd(), logsConfig);
      const entry: AuditLifecycleEntry = {
        event: 'lifecycle',
        timestamp: new Date().toISOString(),
        platform: 'openclaw',
        session_id: sessionId,
        lifecycle_type: 'session_end',
      };
      writeAuditLog(entry, auditOptsFor(monitored));
      await flushSessionTurn(sessionId, monitored);
      // Drop the session's arm record now instead of leaving it for the
      // 7-day TTL backstop — OpenClaw is a long-running daemon, so a
      // session that ends here won't get another chance to be reaped
      // until the daemon itself restarts or the backstop fires.
      forgetSession(sessionId, logsConfig);
    } catch {
      // Non-critical
    }
  });

  api.on('agent_end', async (_event: unknown, ctx: unknown) => {
    try {
      const c = (ctx ?? {}) as { sessionKey?: string; sessionId?: string; runId?: string };
      const sessionId = c.sessionKey || c.sessionId || c.runId || 'openclaw';
      const monitored = isSessionMonitored(sessionId, process.cwd(), logsConfig);
      const agentEndEntry: AuditLifecycleEntry = {
        event: 'lifecycle',
        timestamp: new Date().toISOString(),
        platform: 'openclaw',
        session_id: sessionId,
        lifecycle_type: 'agent_end',
      };
      writeAuditLog(agentEndEntry, auditOptsFor(monitored));
      await flushSessionTurn(sessionId, monitored);
      if (monitored && meterProvider) {
        await recordTurn(meterProvider);
      }
      if (monitored && loggerProvider) {
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
