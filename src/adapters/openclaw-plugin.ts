/**
 * FFWD AgentGuard — OpenClaw Plugin
 *
 * Registers before_tool_call, after_tool_call hooks with the OpenClaw
 * plugin API to evaluate tool safety at runtime and collect telemetry.
 *
 * Usage in OpenClaw plugin config:
 *   export { default } from '@core0-io/ffwd-agent-guard/openclaw';
 *
 * Or register manually:
 *   import { registerOpenClawPlugin } from '@core0-io/ffwd-agent-guard';
 *   registerOpenClawPlugin(api);
 */

import { OpenClawAdapter } from './openclaw.js';
import { evaluateHook } from './engine.js';
import { loadConfig, writeAuditLog } from './common.js';
import type { AgentGuardInstance } from './types.js';
import { RuntimeAnalyser } from '../core/analysers/runtime/index.js';
import type { ProtectionLevel } from '../core/analysers/runtime/decision.js';
import { loadCollectorConfig } from '../scripts/lib/config-loader.js';
import { createTracerProvider, redactAndTruncate } from '../scripts/lib/traces-collector.js';
import { createMeterProvider, recordToolUse, recordTurn } from '../scripts/lib/metrics-collector.js';
import { trace, ROOT_CONTEXT, SpanStatusCode, type Span, type Context } from '@opentelemetry/api';

// ---------------------------------------------------------------------------
// In-memory turn / span tracking (same-process, standard OTEL context).
// OpenClaw runs hooks in the gateway process, so we don't need the file-based
// state machine that Claude Code's cross-process hooks require.
// ---------------------------------------------------------------------------

interface TurnTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface ActiveTurn {
  span: Span;
  ctx: Context;
  turnNumber: number;
  usage: TurnTokenUsage;
}

const turnCounters = new Map<string, number>();
const activeTurns = new Map<string, ActiveTurn>();
const activeToolSpans = new Map<string, Span>();  // key: `${sessionId}:${spanKey}`
const activeTaskSpans = new Map<string, Span>();  // key: `${sessionId}:${taskId}`

function getOrStartTurn(sessionId: string, platform = 'openclaw', cwd: string | null = null): ActiveTurn {
  let t = activeTurns.get(sessionId);
  if (t) return t;
  const n = (turnCounters.get(sessionId) ?? 0) + 1;
  turnCounters.set(sessionId, n);
  const tracer = trace.getTracer('agentguard-collector', '1.0.0');
  const span = tracer.startSpan(
    `turn:${n}`,
    {
      attributes: {
        'agentguard.session_id': sessionId,
        'agentguard.turn_number': n,
        'agentguard.platform': platform,
        ...(cwd ? { 'agentguard.cwd': cwd } : {}),
      },
    },
    ROOT_CONTEXT,
  );
  const ctx = trace.setSpan(ROOT_CONTEXT, span);
  t = { span, ctx, turnNumber: n, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  activeTurns.set(sessionId, t);
  return t;
}

function finishTurn(sessionId: string): void {
  const t = activeTurns.get(sessionId);
  if (!t) return;
  // End any still-pending tool/task spans defensively.
  for (const [k, s] of activeToolSpans) {
    if (k.startsWith(`${sessionId}:`)) { s.end(); activeToolSpans.delete(k); }
  }
  for (const [k, s] of activeTaskSpans) {
    if (k.startsWith(`${sessionId}:`)) { s.end(); activeTaskSpans.delete(k); }
  }

  // Attach token usage to turn span
  const u = t.usage;
  t.span.setAttribute('agentguard.turn.input_tokens', u.input);
  t.span.setAttribute('agentguard.turn.output_tokens', u.output);
  t.span.setAttribute('agentguard.turn.cache_creation_input_tokens', u.cacheWrite);
  t.span.setAttribute('agentguard.turn.cache_read_input_tokens', u.cacheRead);
  const totalInput = u.input + u.cacheWrite + u.cacheRead;
  const cacheHitRate = totalInput > 0 ? Math.round((u.cacheRead / totalInput) * 1000) / 1000 : 0;
  t.span.setAttribute('agentguard.turn.cache_hit_rate', cacheHitRate);

  t.span.end();
  activeTurns.delete(sessionId);
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
  /** Custom AgentGuard instance factory */
  ffwdAgentGuardFactory?: () => AgentGuardInstance;
}

// ---------------------------------------------------------------------------
// Main Registration
// ---------------------------------------------------------------------------

/**
 * Register AgentGuard hooks with OpenClaw plugin API
 */
export function registerOpenClawPlugin(
  api: OpenClawRegisterApi,
  options: OpenClawPluginOptions = {}
): void {
  const adapter = new OpenClawAdapter();
  const config = loadConfig();
  if (options.level) config.level = options.level as typeof config.level;

  const collectorConfig = loadCollectorConfig();
  const tracerProvider = createTracerProvider(collectorConfig);
  const meterProvider = createMeterProvider(collectorConfig);

  const logger = (msg: string) => console.log(msg);

  // Lazy-initialize engine instance
  let ffwdAgentGuard: AgentGuardInstance | null = null;

  function getFfwdAgentGuard(): AgentGuardInstance {
    if (!ffwdAgentGuard) {
      if (options.ffwdAgentGuardFactory) {
        ffwdAgentGuard = options.ffwdAgentGuardFactory();
      } else {
        ffwdAgentGuard = {
          runtimeAnalyser: new RuntimeAnalyser({
            level: (config.level || 'balanced') as ProtectionLevel,
            extraAllowlist: config.guard?.extra_allowlist,
            weights: config.guard?.weights,
            llmApiKey: config.llm?.api_key,
            llmModel: config.llm?.model,
            scoringEndpoint: config.guard?.scoring_endpoint,
            scoringApiKey: config.guard?.scoring_api_key,
            scoringTimeout: config.guard?.scoring_timeout,
          }),
        };
      }
    }
    return ffwdAgentGuard!;
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

      // OTEL pre-tool span + metric
      const toolName = toolEvent.toolName || 'unknown';
      const sessionId = c.sessionKey || c.sessionId || c.runId || toolEvent.runId || 'openclaw';
      const spanKey = toolEvent.toolCallId || toolName;
      if (tracerProvider) {
        try {
          const turn = getOrStartTurn(sessionId, 'openclaw', process.cwd());
          const tracer = trace.getTracer('agentguard-collector', '1.0.0');
          const span = tracer.startSpan(
            `tool:${toolName}`,
            {
              attributes: {
                'agentguard.tool_name': toolName,
                'agentguard.platform': 'openclaw',
                'agentguard.session_id': sessionId,
                'agentguard.tool.input': redactAndTruncate(toolEvent.params ?? {}),
                ...(toolEvent.toolCallId ? { 'agentguard.tool.call_id': toolEvent.toolCallId } : {}),
                ...(toolEvent.runId ? { 'agentguard.tool.run_id': toolEvent.runId } : {}),
              },
            },
            turn.ctx,
          );
          activeToolSpans.set(`${sessionId}:${spanKey}`, span);
        } catch { /* non-critical */ }
      }
      if (meterProvider) {
        recordToolUse(meterProvider, toolName, 'PreToolUse', 'openclaw').catch(() => {});
      }

      const result = await evaluateHook(adapter, event, {
        config,
        ffwdAgentGuard: getFfwdAgentGuard(),
      });

      if (result.decision === 'deny') {
        return {
          block: true,
          blockReason: result.reason || 'Blocked by FFWD AgentGuard',
        };
      }

      // OpenClaw has no 'ask' mode — block with explanation in strict/balanced
      if (result.decision === 'ask') {
        return {
          block: true,
          blockReason: result.reason || 'Requires confirmation (FFWD AgentGuard)',
        };
      }

      return undefined; // allow
    } catch {
      // Fail open
      return undefined;
    }
  });

  // after_tool_call → audit log + collector (fire-and-forget)
  api.on('after_tool_call', async (event: unknown, ctx: unknown) => {
    try {
      const input = adapter.parseInput(event);
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
      writeAuditLog(input, null, null, 'openclaw');

      const toolName = toolEvent.toolName || 'unknown';
      const sessionId = c.sessionKey || c.sessionId || c.runId || toolEvent.runId || 'openclaw';
      const spanKey = toolEvent.toolCallId || toolName;
      if (tracerProvider) {
        const span = activeToolSpans.get(`${sessionId}:${spanKey}`);
        if (span) {
          if (toolEvent.result !== undefined) span.setAttribute('agentguard.tool.output', redactAndTruncate(toolEvent.result));
          if (toolEvent.error) span.setAttribute('agentguard.tool.error', redactAndTruncate(toolEvent.error));
          if (typeof toolEvent.durationMs === 'number') span.setAttribute('agentguard.tool.duration_ms', toolEvent.durationMs);
          if (toolEvent.error) {
            span.setStatus({ code: SpanStatusCode.ERROR, message: toolEvent.error });
            span.recordException(toolEvent.error);
          }
          span.end();
          activeToolSpans.delete(`${sessionId}:${spanKey}`);
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
      writeAuditLog(
        { toolName: 'subagent_spawning', toolInput: e as Record<string, unknown>, eventType: 'pre', raw: e },
        { decision: 'allow', risk_level: 'low', risk_tags: [] },
        null,
        'openclaw'
      );
      const taskId = e.subagentId || e.runId || 'unknown';
      const sessionId = c.sessionKey || c.sessionId || c.runId || e.runId || 'openclaw';
      if (tracerProvider) {
        const turn = getOrStartTurn(sessionId, 'openclaw', process.cwd());
        const tracer = trace.getTracer('agentguard-collector', '1.0.0');
        const span = tracer.startSpan(
          'task:execute',
          {
            attributes: {
              'agentguard.task_id': taskId,
              'agentguard.platform': 'openclaw',
              'agentguard.session_id': sessionId,
            },
          },
          turn.ctx,
        );
        activeTaskSpans.set(`${sessionId}:${taskId}`, span);
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
      writeAuditLog(
        { toolName: 'subagent_ended', toolInput: e as Record<string, unknown>, eventType: 'post', raw: e },
        { decision: 'allow', risk_level: 'low', risk_tags: [] },
        null,
        'openclaw'
      );
      const taskId = e.subagentId || e.runId || 'unknown';
      const sessionId = c.sessionKey || c.sessionId || c.runId || e.runId || 'openclaw';
      if (tracerProvider) {
        const span = activeTaskSpans.get(`${sessionId}:${taskId}`);
        if (span) {
          span.end();
          activeTaskSpans.delete(`${sessionId}:${taskId}`);
        }
      }
      if (meterProvider) {
        await recordToolUse(meterProvider, 'Task', 'TaskCompleted', 'openclaw');
      }
    } catch {
      // Non-critical
    }
  });

  // before_agent_reply → capture user prompt onto turn root span
  api.on('before_agent_reply', async (event: unknown, ctx: unknown) => {
    try {
      const e = event as { cleanedBody?: string };
      const c = (ctx ?? {}) as { sessionKey?: string; sessionId?: string; runId?: string };
      const sessionId = c.sessionKey || c.sessionId || c.runId || 'openclaw';
      if (tracerProvider && e.cleanedBody) {
        const turn = getOrStartTurn(sessionId, 'openclaw', process.cwd());
        turn.span.setAttribute('agentguard.turn.user_prompt', redactAndTruncate(e.cleanedBody));
      }
    } catch { /* non-critical */ }
  });

  // llm_output → accumulate token usage + capture assistant reply
  api.on('llm_output', async (event: unknown, ctx: unknown) => {
    try {
      const e = event as { assistantTexts?: string[]; usage?: Record<string, number> };
      const c = (ctx ?? {}) as { sessionKey?: string; sessionId?: string; runId?: string };
      const sessionId = c.sessionKey || c.sessionId || c.runId || 'openclaw';

      // Accumulate token usage
      if (e.usage) {
        const turn = getOrStartTurn(sessionId, 'openclaw', process.cwd());
        turn.usage.input += (e.usage['input'] as number) || 0;
        turn.usage.output += (e.usage['output'] as number) || 0;
        turn.usage.cacheRead += (e.usage['cacheRead'] as number) || 0;
        turn.usage.cacheWrite += (e.usage['cacheWrite'] as number) || 0;
      }

      if (tracerProvider && e.assistantTexts?.length) {
        const turn = activeTurns.get(sessionId);
        if (turn) turn.span.setAttribute('agentguard.turn.assistant_reply', redactAndTruncate(e.assistantTexts.join('\n')));
      }
    } catch { /* non-critical */ }
  });

  // agent_end → end-turn span flush
  api.on('agent_end', async (event: unknown, ctx: unknown) => {
    try {
      const e = event as Record<string, unknown>;
      const c = (ctx ?? {}) as { sessionKey?: string; sessionId?: string; runId?: string };
      writeAuditLog(
        { toolName: 'agent_end', toolInput: e, eventType: 'post', raw: e },
        { decision: 'allow', risk_level: 'low', risk_tags: [] },
        null,
        'openclaw'
      );
      const sessionId = c.sessionKey || c.sessionId || c.runId || 'openclaw';
      if (tracerProvider) {
        finishTurn(sessionId);
        await tracerProvider.forceFlush();
      }
      if (meterProvider) {
        await recordTurn(meterProvider, 'openclaw');
      }
    } catch {
      // Non-critical
    }
  });

  logger(`[AgentGuard] Registered with OpenClaw (protection level: ${config.level || 'balanced'})`);
}

/**
 * Default export — OpenClaw plugin entry object.
 *
 * Usage: export { default } from '@core0-io/ffwd-agent-guard/openclaw'
 */
const pluginEntry: OpenClawPluginEntry = {
  id: 'ffwd-agent-guard',
  name: 'FFWD AgentGuard',
  register(api: OpenClawRegisterApi): void {
    registerOpenClawPlugin(api);
  },
};

export default pluginEntry;
