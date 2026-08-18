// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Nio — Pi extension.
 *
 * Pi loads extensions through jiti from ~/.pi/agent/extensions/ or from
 * an installed pi package. The default export is the factory Pi calls
 * with its ExtensionAPI.
 *
 * Pi's types are declared structurally below rather than imported from
 * @earendil-works/pi-coding-agent, so the shipped bundle has zero
 * external runtime dependencies and keeps working across minor Pi
 * releases. Pi's runtime helpers (isToolCallEventType,
 * createLocalBashOperations) are deliberately not used for the same
 * reason — plain string comparison is enough.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './common.js';
import { PiAdapter } from './pi.js';
import { InProcessPluginRuntime } from './plugin-runtime.js';
import type { NioInstance } from './types.js';
import type { createTracerProvider } from '../scripts/lib/traces-collector.js';
import type { createMeterProvider } from '../scripts/lib/metrics-collector.js';
import type { createLoggerProvider } from '../scripts/lib/logs-collector.js';

// ---------------------------------------------------------------------------
// Structural subset of Pi's extension API
// ---------------------------------------------------------------------------

interface PiUi {
  confirm(title: string, message: string, opts?: { timeout?: number }): Promise<boolean>;
  notify(message: string, level?: 'info' | 'warning' | 'error'): void;
}

interface PiContext {
  hasUI: boolean;
  cwd: string;
  ui: PiUi;
  sessionManager: {
    getSessionId(): string;
    /**
     * Absolute path of the session JSONL under `~/.pi/agent/sessions/`,
     * or null for an ephemeral session that is never persisted. Optional
     * because older Pi releases predate it — an absent method degrades to
     * "no session file", the same as an ephemeral session.
     */
    getSessionFile?(): string | null;
  };
}

export interface PiExtensionApi {
  on(event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown): void;
  registerCommand(
    name: string,
    options: {
      description: string;
      handler: (args: string, ctx: unknown) => Promise<void> | void;
    },
  ): void;
}

export interface PiPluginOptions {
  level?: string;
  /**
   * Override `guard.confirm_action` for this registration. Lets a test
   * reach the `decision === 'ask'` branch without writing a scratch
   * config.yaml.
   */
  confirmAction?: 'allow' | 'deny' | 'ask';
  nioFactory?: () => NioInstance;
  /**
   * Test seam: inject pre-built OTEL providers instead of deriving them
   * from collector config. `undefined` builds from config (production);
   * `null` disables. Mirrors PluginRuntimeOptions / OpenClawPluginOptions
   * so the traced paths (pending-span park/drain, orphan-span emission on
   * the block path, confirm-dialog span resolution) can actually run in
   * a test instead of being skipped because `collector.endpoint` is
   * unset under the test harness.
   *
   * Not part of the original task brief's PiPluginOptions shape — added
   * because this binding constructs its own InProcessPluginRuntime, so
   * without threading these through there would be no way for a test to
   * inject `makeInMemoryTracer()`.
   */
  tracerProvider?: ReturnType<typeof createTracerProvider>;
  meterProvider?: ReturnType<typeof createMeterProvider>;
  /**
   * Same seam for the logs signal. Needed on top of `tracerProvider`
   * because conversation CONTENT (the assistant's words, the tool
   * arguments off a `tool_use` block) rides the logs signal, not the
   * spans — without this a test can see Pi's chat spans but not whether
   * anything was ever said inside them.
   */
  loggerProvider?: ReturnType<typeof createLoggerProvider>;
}

/** How long an interactive confirm dialog waits before auto-cancelling. */
const CONFIRM_TIMEOUT_MS = 60_000;

export function registerPiExtension(
  pi: PiExtensionApi,
  options: PiPluginOptions = {},
): void {
  const config = loadConfig();
  const adapter = new PiAdapter({
    nativeToolMapping: config.guard?.native_tool_mapping?.pi,
  });
  const rt = new InProcessPluginRuntime({
    platform: 'pi',
    adapter,
    level: options.level,
    confirmAction: options.confirmAction,
    nioFactory: options.nioFactory,
    tracerProvider: options.tracerProvider,
    meterProvider: options.meterProvider,
    loggerProvider: options.loggerProvider,
  });

  /**
   * This event's session id — and, as a side effect, the directory that
   * session is working in.
   *
   * The cwd recording lives here rather than in `session_start` alone
   * because every handler already funnels through this helper, so one
   * line covers the whole binding and no ordering assumption is needed:
   * Pi is free to deliver a tool call before whatever event we might
   * otherwise have chosen to read the directory from. It matters because
   * the runtime serves every Pi session from ONE process, so without it
   * the monitor gate compares a pending arm against the directory `pi`
   * was launched in instead of the one this session is in.
   */
  const sid = (ctx: unknown): string => {
    const c = ctx as PiContext;
    const id = c.sessionManager.getSessionId();
    rt.setSessionCwd(id, c.cwd);
    return id;
  };

  // ---- Guard: tool_call can block -----------------------------------------
  pi.on('tool_call', async (event: unknown, ctx: unknown) => {
    // Set the moment we learn the action must not run — either the guard
    // denied it, or the human declined the confirmation dialog. Declared
    // OUTSIDE the try on purpose: failing open is right for a Nio internal
    // error, but it must never turn a refusal we already hold into a green
    // light. Telemetry work happens after the answer is known, so without
    // this a throw in resolveConfirm would run a tool the user just refused.
    let denial: { block: true; reason?: string } | null = null;
    try {
      const e = event as {
        toolName?: string; toolCallId?: string; input?: Record<string, unknown>;
      };
      const c = ctx as PiContext;
      const toolName = e.toolName || 'unknown';
      const spanKey = e.toolCallId || toolName;
      const sessionId = sid(ctx);
      const params = e.input ?? {};

      const r = await rt.onPreTool(sessionId, spanKey, toolName, params, {
        ...e, sessionId, cwd: c.cwd,
      }, { toolCallId: e.toolCallId });

      if (r.block) {
        denial = { block: true, reason: r.reason };
        return denial;
      }

      // Provisional 'ask' means guard.confirm_action === 'ask'. Pi is the
      // only platform with a real user channel, so actually ask.
      if (r.decision === 'ask') {
        if (!c.hasUI) {
          // Print / json mode: no channel to ask through. Resolve the
          // provisional attrs to confirm_allowed and let it run, matching
          // the two-state fold every other platform uses. resolveConfirm
          // with `true` cannot block, so there is nothing to branch on.
          await rt.resolveConfirm(sessionId, spanKey, 'ask', r.reason, true);
          return undefined;
        }
        const ok = await c.ui.confirm(
          'Nio: confirm this action?',
          r.reason || 'This action was flagged as risky.',
          { timeout: CONFIRM_TIMEOUT_MS },
        );
        // Pi's confirm() returns false on timeout (documented in
        // extensions.md), so an absent human reads as a refusal instead of
        // hanging the agent forever.
        if (!ok) {
          denial = { block: true, reason: r.reason || 'Denied by user (Nio)' };
        }
        const resolved = await rt.resolveConfirm(sessionId, spanKey, 'ask', r.reason, ok);
        if (resolved.block) return { block: true, reason: resolved.reason };
        if (denial) return denial;
      }

      return undefined;
    } catch {
      // Fail open on a Nio failure — but honour a refusal already given.
      return denial ?? undefined;
    }
  });

  // ---- Collector ----------------------------------------------------------
  pi.on('tool_result', async (event: unknown, ctx: unknown) => {
    try {
      const e = event as {
        toolName?: string; toolCallId?: string; content?: unknown; isError?: boolean;
      };
      const toolName = e.toolName || 'unknown';
      await rt.onPostTool(sid(ctx), e.toolCallId || toolName, toolName, {
        result: e.content,
        error: e.isError ? 'tool reported an error' : null,
      });
    } catch { /* non-critical */ }
  });

  pi.on('input', async (event: unknown, ctx: unknown) => {
    try {
      const e = event as { text?: string };
      if (e.text) rt.onUserPrompt(sid(ctx), e.text);
    } catch { /* non-critical */ }
    return { action: 'continue' };
  });

  pi.on('message_end', async (event: unknown, ctx: unknown) => {
    try {
      const e = event as {
        message?: {
          role?: string;
          content?: unknown;
          usage?: {
            input?: number; output?: number;
            cacheRead?: number; cacheWrite?: number;
          };
        };
      };
      if (e.message?.role !== 'assistant') return;
      const sessionId = sid(ctx);
      if (e.message.usage) rt.onLlmUsage(sessionId, e.message.usage);
      if (typeof e.message.content === 'string') {
        rt.onAssistantReply(sessionId, e.message.content);
      }
    } catch { /* non-critical */ }
  });

  pi.on('session_start', async (_event: unknown, ctx: unknown) => {
    try {
      const sessionId = sid(ctx);
      rt.onSessionStart(sessionId);
      // Pi is a replay platform: its conversation lives in the session
      // JSONL, not in events we accumulate. Hand the runtime the path
      // once, here — `onSessionStart` has just cleared any stale one, and
      // every turn in this session replays the same file scoped by its
      // own turn start.
      //
      // An ephemeral session has no file (`getSessionFile()` returns
      // null), and so does a Pi old enough not to expose the method at
      // all. Both land on `setTranscriptPath(id, null)`, so the factory
      // yields no source and the turn degrades to the flat turn -> tool
      // shape — the same graceful degradation any platform without a
      // transcript gets, not a crash and not an empty chat span.
      const c = ctx as PiContext;
      rt.setTranscriptPath(sessionId, c.sessionManager?.getSessionFile?.() ?? null);
    } catch { /* non-critical */ }
  });

  pi.on('session_shutdown', async (_event: unknown, ctx: unknown) => {
    try { await rt.onSessionEnd(sid(ctx)); } catch { /* non-critical */ }
  });

  pi.on('agent_end', async (_event: unknown, ctx: unknown) => {
    try {
      const sessionId = sid(ctx);
      await rt.onTurnEnd(sessionId);
      await rt.recordTurnMetric(sessionId);
    } catch { /* non-critical */ }
  });

  // Audit-only. Nio guards agent actions, not human keystrokes, so a
  // command the user typed themselves is never blocked. Returning
  // undefined leaves Pi's built-in bash backend in charge.
  pi.on('user_bash', async (event: unknown, ctx: unknown) => {
    try {
      const e = event as { command?: string; cwd?: string };
      rt.onUserBash(sid(ctx), e.command || '', e.cwd || '');
    } catch { /* non-critical */ }
    return undefined;
  });

  // Contribute our skill directory so the skills load regardless of how the
  // extension was installed. `pi install` registers them through the package
  // manifest and the CLI-less fallback registers them in settings.json, but
  // this makes the extension self-sufficient either way. Resolved relative to
  // the extension file, so it follows the bundle wherever it lands.
  pi.on('resources_discover', async () => {
    try {
      const here = dirname(fileURLToPath(import.meta.url));
      // Bundle sits at <root>/extensions/nio/index.js; skills at <root>/skills.
      const skills = join(here, '..', '..', 'skills');
      return existsSync(skills) ? { skillPaths: [skills] } : {};
    } catch {
      return {};
    }
  });

  // ---- /nio slash command (bypasses the LLM entirely) ---------------------
  pi.registerCommand('nio', {
    description: 'Nio — scan code, evaluate an action, read the audit report, manage config',
    handler: async (args: string, ctx: unknown) => {
      // `ctx.cwd`, not the process's: `/nio monitor on` keys its arm to
      // this directory and the gate will only hand that arm to a session
      // working in the same one. Pi serves every session from one
      // process, so the process cwd would key the arm to wherever `pi`
      // was started and the request would expire unclaimed.
      const text = await rt.dispatchCommand(args ?? '', {
        cwd: (ctx as PiContext)?.cwd,
      });
      try {
        (ctx as PiContext).ui.notify(text, 'info');
      } catch {
        console.log(text);
      }
    },
  });
}

export default function (pi: PiExtensionApi): void {
  registerPiExtension(pi);
}
