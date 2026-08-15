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
import type { createLoggerProvider } from '../scripts/lib/logs-collector.js';

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
  /**
   * Same seam for the logs signal. Needed on top of `tracerProvider`
   * because conversation CONTENT (the assistant's words, the tool
   * arguments off a `tool_use` block) rides the logs signal, not the
   * spans — without this a test can see opencode's chat spans but not
   * whether anything was ever said inside them.
   */
  loggerProvider?: ReturnType<typeof createLoggerProvider>;
  /**
   * Test seam for the DORMANT deferral path. Production leaves this
   * undefined, which is `true` — every tool span is exported the moment
   * it closes (see `PluginRuntimeOptions.eagerToolSpans`).
   *
   * Passing `false` selects the park-until-turn-close path, which still
   * exists because `deferred_spans` is what the crash-recovery machinery
   * in `traces-state-store.ts` reads and because `MAX_DEFERRED_SPANS`
   * bounds it. `deferred-span-cap.test.ts` uses this to keep that
   * mechanism under test rather than letting it rot unexercised.
   */
  eagerToolSpans?: boolean;
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
      loggerProvider: options.loggerProvider,
      // The project directory this plugin instance serves. opencode
      // builds one plugin per directory and hands it here, so it is the
      // working directory of every session this runtime sees — unlike
      // `process.cwd()`, which is wherever the opencode server was
      // started and is shared by every project it serves. The monitor
      // gate matches a pending arm by directory, so keying sessions on
      // the server's launch directory would let one project's session
      // claim an arm made in another.
      defaultCwd: input.directory,
      ...(options.eagerToolSpans !== undefined
        ? { eagerToolSpans: options.eagerToolSpans }
        : {}),
    });

    /** Guard verdicts parked by callID so permission.ask can reuse them. */
    const verdictByCall = new Map<string, 'allow' | 'ask' | 'deny'>();

    /**
     * Sub-agent child session id → parent session id, recorded when
     * `session.created` carries `Session.parentID`. The task span opened
     * by `onSubagentStart` lives under the PARENT's turn state, but the
     * only signal that the sub-agent itself is done is the CHILD's own
     * `session.idle` — so this map is what lets that event find its way
     * back to the right `onSubagentEnd(parentId, childId)` call.
     */
    const subagentParentByChild = new Map<string, string>();

    /**
     * Last-seen cumulative token totals per assistant message id.
     * `message.updated` is a snapshot event — opencode republishes the
     * same message record (with growing cumulative totals) on every
     * update, unlike Pi's `message_end` which fires once per message.
     * Feeding a snapshot straight into `onLlmUsage` (which accumulates)
     * would compound the totals on every re-publish; this map lets each
     * event contribute only the delta since the last time this message
     * id was seen.
     */
    const lastUsageByMessageId = new Map<string, {
      input: number; output: number; cacheRead: number; cacheWrite: number;
    }>();

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
          // `error: null` is unconditional because opencode does not
          // deliver this hook at all when the tool throws — reaching here
          // IS the success signal. If a future opencode starts firing
          // tool.execute.after on failure too, this line would silently
          // record every failure as a success and must be changed to read
          // the error off the hook payload.
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
          // A 'deny' verdict already threw from tool.execute.before —
          // opencode never runs item.execute for that call, so
          // permission.ask is never reached for it; checking for 'deny'
          // here would be dead code. The reachable verdict is 'ask':
          // Nio flagged this call as needing confirmation but folded it
          // to a provisional allow (no interactive channel of its own),
          // letting the call proceed toward opencode's own permission
          // system. Route that flag onto opencode's real interactive
          // channel — force an actual ask rather than silently trusting
          // whatever opencode's own heuristics decided for `status`.
          //
          // There is no `confirm_action: deny` arm here, and there must
          // not be: reaching this line requires verdict === 'ask', which
          // InProcessPluginRuntime only ever produces when
          // `confirm_action` is itself 'ask'. Under `deny` the runtime
          // folds to 'confirm_denied' and tool.execute.before already
          // threw; under 'allow' it folds to 'confirm_allowed' and the
          // parked verdict is 'allow'. So 'ask' is the only reachable
          // verdict and 'ask' is the only correct status.
          const verdict = hookInput.callID ? verdictByCall.get(hookInput.callID) : undefined;
          if (verdict === 'ask') {
            hookOutput.status = 'ask';
          }
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
                subagentParentByChild.set(info.id, info.parentID);
                await rt.onSubagentStart(info.parentID, info.id);
              } else {
                rt.onSessionStart(info.id);
              }
              return;
            }
            case 'session.idle': {
              const sessionId = props.sessionID as string | undefined;
              if (!sessionId) return;

              // A sub-agent's OWN session going idle means the sub-agent
              // is done — close the task span opened under the parent
              // via onSubagentEnd instead of treating this as a turn end
              // for the child.
              //
              // The child ALSO accumulates turn state of its own: tools
              // run inside a sub-agent arrive at tool.execute.before
              // with hookInput.sessionID set to the CHILD id, so
              // onPreTool creates a CollectorState under that key. Flush
              // it here, at the child's own idle, so the child's tool
              // spans land under a turn root emitted at the right time.
              // Without this they survive until dispose()'s
              // disposeAllSessions() sweep at plugin teardown and land
              // under a late, synthetic turn.
              //
              // Guarded separately from onSubagentEnd so a flush failure
              // cannot cost the parent its task-span close, and no
              // recordTurnMetric(): a sub-agent's internal turn is not a
              // user-facing turn and must not inflate nio.turn.count.
              //
              // flushTurnSpans, not onTurnEnd: the flush is all we want
              // here. onTurnEnd would also write an `agent_end` audit
              // row for the child, which reads as a *user* turn end to
              // anyone querying the log. The sub-agent's own lifecycle
              // is recorded on the parent by onSubagentEnd below.
              const parentId = subagentParentByChild.get(sessionId);
              if (parentId) {
                subagentParentByChild.delete(sessionId);
                try { await rt.flushTurnSpans(sessionId); } catch { /* non-critical */ }
                await rt.onSubagentEnd(parentId, sessionId);
                return;
              }

              // Also the safety net for tools that threw: opencode skips
              // tool.execute.after in that case, so pending spans would
              // otherwise leak. onTurnEnd force-closes them.
              await rt.onTurnEnd(sessionId);
              await rt.recordTurnMetric(sessionId);
              return;
            }
            case 'message.updated': {
              const info = props.info as {
                id?: string;
                sessionID?: string;
                role?: string;
                tokens?: {
                  input?: number; output?: number;
                  cache?: { read?: number; write?: number };
                };
              } | undefined;
              if (info?.role !== 'assistant' || !info.sessionID) return;
              // opencode has no session file a plugin can read back, so
              // the assistant envelope is accumulated here and replayed
              // by createOpenCodeSource at end of turn. It is a snapshot,
              // republished on every change to the same message, so it is
              // handed over under a dedup key: the runtime keeps only the
              // latest snapshot per message id, in the slot the first one
              // claimed. That is the same collapse createOpenCodeSource
              // performs at read time — done at ingest so the runtime's
              // per-session cap counts LLM calls rather than the number
              // of times opencode happened to republish them.
              rt.recordConversationEvent(
                info.sessionID, { kind: 'message', info },
                info.id ? `message:${info.id}` : undefined,
              );
              // message.updated is a cumulative SNAPSHOT, republished on
              // every change to the same message — unlike Pi's
              // message_end, which fires once. Without a message id to
              // key the delta on, there is no safe way to avoid double-
              // counting a re-publish, so skip rather than risk
              // inflating totals.
              if (info.tokens && info.id) {
                const current = {
                  input: info.tokens.input ?? 0,
                  output: info.tokens.output ?? 0,
                  cacheRead: info.tokens.cache?.read ?? 0,
                  cacheWrite: info.tokens.cache?.write ?? 0,
                };
                const prev = lastUsageByMessageId.get(info.id)
                  ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
                lastUsageByMessageId.set(info.id, current);
                rt.onLlmUsage(info.sessionID, {
                  input: Math.max(0, current.input - prev.input),
                  output: Math.max(0, current.output - prev.output),
                  cacheRead: Math.max(0, current.cacheRead - prev.cacheRead),
                  cacheWrite: Math.max(0, current.cacheWrite - prev.cacheWrite),
                });
              }
              return;
            }
            case 'message.part.updated': {
              // The parts ARE the assistant's content — reasoning, text
              // and tool calls. Like the envelope they are snapshots (a
              // streaming text part is re-emitted per chunk carrying the
              // full text so far), so they go over under a `part:<id>`
              // dedup key for the same reason: this is the stream that
              // dominates the event count on a real turn — one delivery
              // per chunk — and letting it consume one cap slot per
              // chunk is what evicted the turn's earliest chat spans.
              // Both the runtime and the source collapse by part id, so
              // the reconstructed blocks are identical either way.
              //
              // Routed by `sessionID` (which runtime session owns it) but
              // grouped by `messageID` inside the source (which call it
              // belongs to) — a part without a session id has nowhere to
              // go and is dropped here.
              const part = props.part as { id?: string; sessionID?: string } | undefined;
              if (!part?.sessionID) return;
              rt.recordConversationEvent(
                part.sessionID, { kind: 'part', part },
                part.id ? `part:${part.id}` : undefined,
              );
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
              // The project directory, not the server's launch
              // directory: `monitor on` keys its arm to this, and the
              // gate hands that arm only to a session working here.
              return await rt.dispatchCommand((args.command as string) ?? '', {
                cwd: input.directory,
              });
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
        // Drop the binding-local maps too. None of them is self-pruning
        // in every case: `verdictByCall` is only deleted in
        // tool.execute.after, which opencode skips both for a call we
        // denied (we threw) and for a tool that threw, so it retains one
        // entry per failed/denied call; `lastUsageByMessageId` is never
        // pruned at all; `subagentParentByChild` leaks an entry whenever
        // a sub-agent session never goes idle. Bounded per process, but
        // there is no reason to hold them past teardown.
        verdictByCall.clear();
        lastUsageByMessageId.clear();
        subagentParentByChild.clear();
      },
    };
  };
}

/** Default plugin export loaded by opencode. */
export const NioPlugin: OpenCodePlugin = createNioPlugin();
