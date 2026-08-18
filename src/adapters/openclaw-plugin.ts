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
import { loadConfig } from './common.js';
import type { NioInstance } from './types.js';
import { InProcessPluginRuntime } from './plugin-runtime.js';
import { nioToolRunIdAttribute, type createTracerProvider } from '../scripts/lib/traces-collector.js';
import type { createMeterProvider } from '../scripts/lib/metrics-collector.js';

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
  /**
   * Test seam: inject pre-built OTEL providers instead of deriving them
   * from collector config. `undefined` builds from config (production);
   * `null` disables. Mirrors PluginRuntimeOptions so the characterization
   * test keeps working across the refactor.
   */
  tracerProvider?: ReturnType<typeof createTracerProvider>;
  meterProvider?: ReturnType<typeof createMeterProvider>;
}

// ---------------------------------------------------------------------------
// Main Registration
// ---------------------------------------------------------------------------

/**
 * Register Nio hooks with OpenClaw plugin API
 */
export function registerOpenClawPlugin(
  api: OpenClawRegisterApi,
  options: OpenClawPluginOptions = {},
): void {
  const config = loadConfig();
  const adapter = new OpenClawAdapter({
    nativeToolMapping: config.guard?.native_tool_mapping?.openclaw,
  });
  const rt = new InProcessPluginRuntime({
    platform: 'openclaw',
    adapter,
    level: options.level,
    nioFactory: options.nioFactory,
    tracerProvider: options.tracerProvider,
    meterProvider: options.meterProvider,
  });

  /** OpenClaw carries the session id on ctx, with several fallbacks. */
  const sid = (ctx: unknown, event?: { runId?: string }): string => {
    const c = (ctx ?? {}) as { sessionKey?: string; sessionId?: string; runId?: string };
    return c.sessionKey || c.sessionId || c.runId || event?.runId || 'openclaw';
  };

  api.on('before_tool_call', async (event: unknown, ctx: unknown) => {
    try {
      const e = event as {
        toolName?: string; params?: Record<string, unknown>;
        runId?: string; toolCallId?: string;
      };
      const toolName = e.toolName || 'unknown';
      const spanKey = e.toolCallId || toolName;
      const r = await rt.onPreTool(sid(ctx, e), spanKey, toolName, e.params ?? {}, event, {
        toolCallId: e.toolCallId,
        extraPreAttrs: e.runId ? nioToolRunIdAttribute(e.runId) : undefined,
      });
      // OpenClaw has no interactive channel: a provisional 'ask' means
      // confirm_action was 'ask', which folds to allow here.
      if (r.block) return { block: true, blockReason: r.reason };
      return undefined;
    } catch {
      return undefined; // fail open
    }
  });

  api.on('after_tool_call', async (event: unknown, ctx: unknown) => {
    try {
      const e = event as {
        toolName?: string; toolCallId?: string; runId?: string;
        result?: unknown; error?: string; durationMs?: number;
      };
      const toolName = e.toolName || 'unknown';
      await rt.onPostTool(sid(ctx, e), e.toolCallId || toolName, toolName, {
        result: e.result, error: e.error ?? null, durationMs: e.durationMs,
      });
    } catch { /* non-critical */ }
  });

  api.on('subagent_spawning', async (event: unknown, ctx: unknown) => {
    try {
      const e = event as { subagentId?: string; runId?: string };
      await rt.onSubagentStart(sid(ctx, e), e.subagentId || e.runId || 'unknown', {
        subagent_id: e.subagentId, run_id: e.runId,
      });
    } catch { /* non-critical */ }
  });

  api.on('subagent_ended', async (event: unknown, ctx: unknown) => {
    try {
      const e = event as { subagentId?: string; runId?: string };
      await rt.onSubagentEnd(sid(ctx, e), e.subagentId || e.runId || 'unknown', {
        subagent_id: e.subagentId, run_id: e.runId,
      });
    } catch { /* non-critical */ }
  });

  api.on('before_agent_reply', async (event: unknown, ctx: unknown) => {
    try {
      const e = event as { cleanedBody?: string };
      if (e.cleanedBody) rt.onUserPrompt(sid(ctx), e.cleanedBody);
    } catch { /* non-critical */ }
  });

  api.on('llm_output', async (event: unknown, ctx: unknown) => {
    try {
      const e = event as { assistantTexts?: string[]; usage?: Record<string, number> };
      const sessionId = sid(ctx);
      if (e.usage) {
        rt.onLlmUsage(sessionId, {
          input: e.usage['input'], output: e.usage['output'],
          cacheRead: e.usage['cacheRead'], cacheWrite: e.usage['cacheWrite'],
        });
      }
      if (e.assistantTexts?.length) rt.onAssistantReply(sessionId, e.assistantTexts.join('\n'));
    } catch { /* non-critical */ }
  });

  api.on('session_start', async (_e: unknown, ctx: unknown) => {
    try { rt.onSessionStart(sid(ctx)); } catch { /* non-critical */ }
  });

  api.on('session_end', async (_e: unknown, ctx: unknown) => {
    try { await rt.onSessionEnd(sid(ctx)); } catch { /* non-critical */ }
  });

  api.on('agent_end', async (_e: unknown, ctx: unknown) => {
    try {
      const sessionId = sid(ctx);
      await rt.onTurnEnd(sessionId);
      await rt.recordTurnMetric(sessionId);
    } catch { /* non-critical */ }
  });

  if (typeof api.registerTool === 'function') {
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
        return { content: [{ type: 'text', text: await rt.dispatchCommand(params.command ?? '') }] };
      },
    });
  }

  console.log(
    `[Nio] Registered with OpenClaw (protection level: ${config.guard?.protection_level || 'balanced'})`,
  );
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
