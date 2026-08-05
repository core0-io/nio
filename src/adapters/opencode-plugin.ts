// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Nio — opencode plugin.
 *
 * opencode loads plugins from ~/.config/opencode/plugin(s)/*.{ts,js} or
 * from an entry in the `plugin` array of opencode.json.
 *
 * opencode's types are declared structurally below rather than imported
 * from @opencode-ai/plugin, so the shipped bundle has zero external
 * runtime dependencies. opencode's `tool()` helper is an identity
 * function (packages/plugin/src/tool.ts), so returning a plain object
 * with the same shape is equivalent.
 *
 * IMPORTANT: opencode invokes hooks through
 * `Effect.promise(async () => fn(input, output))`
 * (packages/opencode/src/plugin/index.ts:292), which converts any
 * rejection into an Effect *defect* rather than a typed error. Every
 * handler in this file therefore needs total catch coverage. The single
 * intentional exception is NioBlockedError, which must propagate so the
 * tool call is stopped.
 */

import { z } from 'zod';
import { loadConfig } from './common.js';
import { OpenCodeAdapter } from './opencode.js';
import { InProcessPluginRuntime } from './plugin-runtime.js';
import type { NioInstance } from './types.js';
import type { createTracerProvider } from '../scripts/lib/traces-collector.js';
import type { createMeterProvider } from '../scripts/lib/metrics-collector.js';

/** Thrown to stop a tool call. Must escape the before-hook. */
export class NioBlockedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'NioBlockedError';
  }
}

// ---------------------------------------------------------------------------
// Structural subset of opencode's plugin API
// ---------------------------------------------------------------------------

interface OpenCodePluginInput {
  directory: string;
  worktree: string;
}

interface OpenCodeHooks {
  dispose?: () => Promise<void>;
  event?: (input: { event: { type: string; properties?: Record<string, unknown> } }) => Promise<void>;
  tool?: Record<string, {
    description: string;
    args: Record<string, unknown>;
    execute(args: Record<string, unknown>, context: unknown): Promise<string>;
  }>;
  'chat.message'?: (input: unknown, output: unknown) => Promise<void>;
  'permission.ask'?: (
    input: { id: string; type: string; sessionID: string; callID?: string },
    output: { status: 'ask' | 'deny' | 'allow' },
  ) => Promise<void>;
  'tool.execute.before'?: (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: unknown },
  ) => Promise<void>;
  'tool.execute.after'?: (
    input: { tool: string; sessionID: string; callID: string; args: unknown },
    output: { title: string; output: string; metadata: unknown },
  ) => Promise<void>;
}

export type OpenCodePlugin = (input: OpenCodePluginInput) => Promise<OpenCodeHooks>;

export interface OpenCodePluginOptions {
  level?: string;
  nioFactory?: () => NioInstance;
  /**
   * Test seam: inject pre-built OTEL providers instead of deriving them
   * from collector config. `undefined` builds from config (production);
   * `null` disables. Mirrors PiPluginOptions / OpenClawPluginOptions so
   * the traced paths (pending-span park/drain on the block path, the
   * session.idle safety-net reclaim of a span for a tool that threw, the
   * sub-agent task span) can actually run in a test instead of being
   * skipped because `collector.endpoint` is unset under the test
   * harness.
   *
   * Not part of the original task brief's OpenCodePluginOptions shape —
   * added for the same reason PiPluginOptions grew it: this binding
   * constructs its own InProcessPluginRuntime, so without threading
   * these through there would be no way for a test to inject
   * `makeInMemoryTracer()`.
   */
  tracerProvider?: ReturnType<typeof createTracerProvider>;
  meterProvider?: ReturnType<typeof createMeterProvider>;
}

export function createNioPlugin(options: OpenCodePluginOptions = {}): OpenCodePlugin {
  return async (input: OpenCodePluginInput): Promise<OpenCodeHooks> => {
    const config = loadConfig();
    const adapter = new OpenCodeAdapter({
      nativeToolMapping: config.guard?.native_tool_mapping?.opencode,
    });
    const rt = new InProcessPluginRuntime({
      platform: 'opencode',
      adapter,
      level: options.level,
      nioFactory: options.nioFactory,
      tracerProvider: options.tracerProvider,
      meterProvider: options.meterProvider,
    });

    /** Guard verdicts parked by callID so permission.ask can reuse them. */
    const verdictByCall = new Map<string, 'allow' | 'ask' | 'deny'>();

    return {
      async 'tool.execute.before'(hookInput, hookOutput) {
        try {
          const args = (hookOutput?.args ?? {}) as Record<string, unknown>;
          const merged = {
            tool: hookInput.tool,
            sessionID: hookInput.sessionID,
            callID: hookInput.callID,
            args,
            cwd: input.directory,
          };
          const r = await rt.onPreTool(
            hookInput.sessionID, hookInput.callID, hookInput.tool, args, merged,
            { toolCallId: hookInput.callID },
          );
          verdictByCall.set(
            hookInput.callID,
            r.block ? 'deny' : r.decision === 'ask' ? 'ask' : 'allow',
          );
          // The decision and the throw are inseparable: nothing awaits
          // between learning `r.block` and raising it, so there is no
          // window in which a block could be computed and then lost to a
          // later failure (unlike Pi's confirm-dialog path, which awaits
          // again after the user has already answered).
          if (r.block) throw new NioBlockedError(r.reason || 'Blocked by Nio');
        } catch (err) {
          // The deliberate block must reach opencode; anything else is a
          // Nio bug and must not break the host agent.
          if (err instanceof NioBlockedError) throw err;
        }
      },

      async 'tool.execute.after'(hookInput, hookOutput) {
        try {
          verdictByCall.delete(hookInput.callID);
          await rt.onPostTool(
            hookInput.sessionID, hookInput.callID, hookInput.tool,
            { result: hookOutput?.output, error: null },
          );
        } catch { /* non-critical */ }
      },

      async 'chat.message'(_hookInput, hookOutput) {
        try {
          const out = hookOutput as {
            message?: { sessionID?: string };
            parts?: Array<{ type?: string; text?: string }>;
          };
          const sessionId = out?.message?.sessionID;
          if (!sessionId) return;
          const text = (out.parts ?? [])
            .filter(p => p.type === 'text' && typeof p.text === 'string')
            .map(p => p.text)
            .join('\n');
          if (text) rt.onUserPrompt(sessionId, text);
        } catch { /* non-critical */ }
      },

      async 'permission.ask'(hookInput, hookOutput) {
        try {
          // Supplementary gate: opencode decided to ask on its own. If
          // Nio already denied this call, harden the answer to deny.
          const verdict = hookInput.callID ? verdictByCall.get(hookInput.callID) : undefined;
          if (verdict === 'deny') hookOutput.status = 'deny';
        } catch { /* non-critical */ }
      },

      async event({ event }) {
        try {
          const props = (event.properties ?? {}) as Record<string, unknown>;
          switch (event.type) {
            case 'session.created': {
              const info = props.info as { id?: string; parentID?: string } | undefined;
              if (!info?.id) return;
              if (info.parentID) {
                await rt.onSubagentStart(info.parentID, info.id);
              } else {
                rt.onSessionStart(info.id);
              }
              return;
            }
            case 'session.idle': {
              const sessionId = props.sessionID as string | undefined;
              if (!sessionId) return;
              // Also the safety net for tools that threw: opencode skips
              // tool.execute.after in that case, so pending spans would
              // otherwise leak. onTurnEnd force-closes them.
              await rt.onTurnEnd(sessionId);
              await rt.recordTurnMetric();
              return;
            }
            case 'message.updated': {
              const info = props.info as {
                sessionID?: string;
                role?: string;
                tokens?: {
                  input?: number; output?: number;
                  cache?: { read?: number; write?: number };
                };
              } | undefined;
              if (info?.role !== 'assistant' || !info.sessionID) return;
              if (info.tokens) {
                rt.onLlmUsage(info.sessionID, {
                  input: info.tokens.input,
                  output: info.tokens.output,
                  cacheRead: info.tokens.cache?.read,
                  cacheWrite: info.tokens.cache?.write,
                });
              }
              return;
            }
            default:
              return;
          }
        } catch { /* non-critical */ }
      },

      tool: {
        nio_command: {
          description:
            'Dispatcher for the /nio command. Forwards raw args to the in-process Nio subcommand router (scan, action, report, doctor, config, external-score).',
          args: {
            command: z.string().describe('Raw args string after /nio, e.g. "scan src/"'),
          },
          async execute(args) {
            try {
              return await rt.dispatchCommand((args.command as string) ?? '');
            } catch (err) {
              const msg = err instanceof Error ? err.stack || err.message : String(err);
              return `[nio_command error] ${msg}`;
            }
          },
        },
      },

      async dispose() {
        try {
          // Last-resort flush for every session still holding state.
          await rt.disposeAllSessions();
        } catch { /* non-critical */ }
      },
    };
  };
}

/** Default plugin export loaded by opencode. */
export const NioPlugin: OpenCodePlugin = createNioPlugin();
