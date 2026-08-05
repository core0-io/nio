// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Nio — in-process plugin runtime.
 *
 * Shared by every platform whose integration loads Nio as a JS module
 * inside the agent process (OpenClaw, Pi, opencode) rather than
 * spawning a hook subprocess per event (Claude Code, Codex).
 *
 * This class owns everything that is NOT platform-specific: config,
 * the three OTEL providers, per-session collector state, the
 * guard-decision → span-attribute translation, orphan-span
 * compensation on the block path, and turn flushing. Platform bindings
 * translate their own event shapes into the semantic methods here and
 * hold no telemetry logic of their own.
 */

import type { HookAdapter, NioInstance } from './types.js';
import { loadConfig, writeAuditLog } from './common.js';
import type { WriteAuditLogOptions } from './common.js';
import type { AuditLifecycleEntry } from './audit-types.js';
import { ActionOrchestrator } from '../core/action-orchestrator.js';
import type { ProtectionLevel } from '../core/action-decision.js';
import { SkillScanner } from '../scanner/index.js';
import { loadCollectorConfig } from '../scripts/lib/config-loader.js';
import {
  createTracerProvider,
  endTurn,
  recordCacheHitRate,
  recordPostToolUse,
  recordPostTaskToolUse,
  recordUserPrompt,
  recordAssistantReply,
  accumulateGenAiUsage,
  recordPreTaskToolUse,
  type CollectorState,
} from '../scripts/lib/traces-collector.js';
import { createMeterProvider } from '../scripts/lib/metrics-collector.js';
import { createLoggerProvider } from '../scripts/lib/logs-collector.js';
import { evaluateHook } from './hook-engine.js';
import {
  ensureTurn,
  recordPreToolUse,
  setPendingGuardAttrs,
  takePendingGuardAttrs,
  genAiToolCallInputAttributes,
  genAiToolCallOutputAttributes,
  nioGuardAttributes,
  nioReclaimedSpanAttributes,
} from '../scripts/lib/traces-collector.js';
import { toolSummary } from '../scripts/lib/collector-core.js';
import { recordToolUse, recordGuardDecision, recordTurn } from '../scripts/lib/metrics-collector.js';
import { dispatchNioCommand } from './openclaw-dispatch.js';

export interface PluginRuntimeOptions {
  /** Platform tag — lands on the OTEL Resource and audit entries. */
  platform: string;
  /** Guard adapter for this platform. */
  adapter: HookAdapter;
  /** Protection level override (strict/balanced/permissive). */
  level?: string;
  /**
   * Override `guard.confirm_action` for this runtime instance. Lets a
   * caller (or a test) pick the confirm folding without mutating the
   * on-disk config.
   */
  confirmAction?: 'allow' | 'deny' | 'ask';
  /** Custom Nio engine factory (tests inject a stub). */
  nioFactory?: () => NioInstance;
  /**
   * Override the tracer provider instead of building one from collector
   * config. Tests inject an in-memory tracer (`makeInMemoryTracer()`) so
   * the span wiring — pending-span park/drain, orphan-span emission on
   * the block path — actually runs instead of being skipped because
   * `collector.endpoint` is unset. `undefined` (the default) builds from
   * config as usual; `null` explicitly disables tracing, distinct from
   * "not provided".
   */
  tracerProvider?: ReturnType<typeof createTracerProvider>;
  /**
   * Override the meter provider instead of building one from collector
   * config. Same `undefined` (build from config) vs `null` (explicitly
   * disabled) semantics as `tracerProvider`.
   */
  meterProvider?: ReturnType<typeof createMeterProvider>;
}

export type GuardDecisionTag = 'allow' | 'deny' | 'confirm_allowed' | 'confirm_denied' | 'ask';

export interface PreToolResult {
  /** True when the binding layer must stop the tool from running. */
  block: boolean;
  /** Human-readable denial reason; present whenever `block` is true. */
  reason?: string;
  /** User-visible decision taxonomy carried on spans and metrics. */
  decision: GuardDecisionTag;
}

export class InProcessPluginRuntime {
  readonly platform: string;
  readonly adapter: HookAdapter;
  readonly config: ReturnType<typeof loadConfig>;
  readonly confirmAction: 'allow' | 'deny' | 'ask';
  readonly auditOpts: WriteAuditLogOptions;

  protected readonly tracerProvider: ReturnType<typeof createTracerProvider>;
  protected readonly meterProvider: ReturnType<typeof createMeterProvider>;
  protected readonly loggerProvider: ReturnType<typeof createLoggerProvider>;
  protected readonly sessionState = new Map<string, CollectorState>();

  private readonly opts: PluginRuntimeOptions;
  private nio: NioInstance | null = null;
  private scannerInstance: SkillScanner | null = null;

  constructor(opts: PluginRuntimeOptions) {
    this.opts = opts;
    this.platform = opts.platform;
    this.adapter = opts.adapter;

    this.config = loadConfig();
    const guard = this.config.guard;
    if (opts.level && guard) {
      guard.protection_level = opts.level as typeof guard.protection_level;
    }
    this.confirmAction = opts.confirmAction ?? guard?.confirm_action ?? 'allow';

    const collectorConfig = loadCollectorConfig();
    // Resource-level agent name is only set when the operator configured
    // one — empty / unset means "no gen_ai.agent.name on the resource".
    const agentName =
      this.config.agent_name && this.config.agent_name.length > 0
        ? this.config.agent_name
        : undefined;

    this.tracerProvider = opts.tracerProvider !== undefined
      ? opts.tracerProvider
      : createTracerProvider(collectorConfig, opts.platform, agentName);
    this.meterProvider = opts.meterProvider !== undefined
      ? opts.meterProvider
      : createMeterProvider(collectorConfig, opts.platform, agentName);
    const logsConfig = this.config.collector?.logs;
    this.loggerProvider =
      logsConfig?.enabled !== false
        ? createLoggerProvider(collectorConfig, opts.platform, agentName)
        : null;
    this.auditOpts = { loggerProvider: this.loggerProvider, logsConfig };
  }

  /** Lazily constructed Phase 1–6 engine. */
  get orchestrator(): ActionOrchestrator {
    if (!this.nio) {
      const guard = this.config.guard;
      this.nio = this.opts.nioFactory
        ? this.opts.nioFactory()
        : {
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
    return this.nio.orchestrator;
  }

  /** Lazily constructed scanner, used by `/nio scan`. */
  get scanner(): SkillScanner {
    if (!this.scannerInstance) {
      this.scannerInstance = new SkillScanner({
        fileScanRules: this.config.guard?.file_scan_rules,
      });
    }
    return this.scannerInstance;
  }

  /** Test/diagnostic helper: does in-memory state exist for this session? */
  hasSessionState(sessionId: string): boolean {
    return this.sessionState.has(sessionId);
  }

  /**
   * Seed in-memory session state directly. Test-only seam — lets tests
   * assert that a state-clearing method actually cleared seeded state,
   * rather than asserting a no-op against a runtime that never had any.
   */
  _setSessionStateForTests(sessionId: string, state: CollectorState): void {
    this.sessionState.set(sessionId, state);
  }

  /** Hard session boundary — drop stale turn numbering, write audit row. */
  onSessionStart(sessionId: string): void {
    this.sessionState.delete(sessionId);
    this.writeLifecycle(sessionId, 'session_start');
  }

  /** Last-resort flush before a session is torn down. */
  async onSessionEnd(sessionId: string): Promise<void> {
    this.writeLifecycle(sessionId, 'session_end');
    await this.flushSessionTurn(sessionId);
  }

  /** Per-turn flush. Idempotent: no-op when no state exists. */
  async onTurnEnd(sessionId: string): Promise<void> {
    this.writeLifecycle(sessionId, 'agent_end');
    await this.flushSessionTurn(sessionId);
    if (this.loggerProvider) await this.loggerProvider.forceFlush();
  }

  /** Increment the per-turn counter. Separate from onTurnEnd so
   *  platforms that flush turns and count turns at different events can
   *  call them independently. */
  async recordTurnMetric(): Promise<void> {
    if (this.meterProvider) await recordTurn(this.meterProvider);
  }

  /**
   * Flush every session still holding state. Used by platforms whose
   * shutdown signal is process-wide rather than per-session (opencode's
   * `dispose` hook).
   */
  async disposeAllSessions(): Promise<void> {
    for (const sessionId of [...this.sessionState.keys()]) {
      await this.onSessionEnd(sessionId);
    }
    if (this.loggerProvider) await this.loggerProvider.forceFlush();
  }

  protected writeLifecycle(
    sessionId: string,
    lifecycleType: AuditLifecycleEntry['lifecycle_type'],
    details?: Record<string, unknown>,
  ): void {
    const entry: AuditLifecycleEntry = {
      event: 'lifecycle',
      timestamp: new Date().toISOString(),
      platform: this.platform,
      session_id: sessionId,
      lifecycle_type: lifecycleType,
      ...(details ? { details } : {}),
    };
    writeAuditLog(entry, this.auditOpts);
  }

  /**
   * Compute cache_hit_rate, defensively close any leftover pending
   * tool/task spans, emit the turn root span, drop per-session state.
   * Idempotent: no-op if no state exists.
   */
  protected async flushSessionTurn(sessionId: string): Promise<void> {
    if (!this.tracerProvider) {
      this.sessionState.delete(sessionId);
      return;
    }
    let state = this.sessionState.get(sessionId);
    if (!state) return;

    state = recordCacheHitRate(state);

    for (const k of Object.keys(state.pending_spans)) {
      // Reclaim, not a normal close. Two things have to be right here:
      //
      // 1. Drain the guard attrs parked for this key by `onPreTool`.
      //    Only `onPostTool` / `closeSpan` used to do that, so a span
      //    reclaimed here carried no `nio.guard.*` at all — and on
      //    opencode that is the NORMAL path for every failing tool
      //    call, because `tool.execute.after` never fires when a tool
      //    throws. Same shape as `closeSpan` below.
      // 2. Do not assert an outcome. The post-side event never arrived,
      //    so whether the tool succeeded or threw is unknowable here.
      //    `error` stays null (marking it ERROR would be as wrong as
      //    claiming success), and the span is tagged with explicit
      //    reclaim attrs so a consumer can tell it apart from a span
      //    that was genuinely closed on a successful tool return.
      const { state: drained, attrs } = takePendingGuardAttrs(state, k);
      state = drained;
      const r = await recordPostToolUse(
        this.tracerProvider,
        state,
        k,
        process.cwd(),
        { ...attrs, ...nioReclaimedSpanAttributes() },
        null,
      );
      state = r.state;
    }
    for (const k of Object.keys(state.pending_task_spans ?? {})) {
      const r = await recordPostTaskToolUse(this.tracerProvider, state, k, process.cwd());
      state = r.state;
    }

    await endTurn(this.tracerProvider, state, process.cwd());
    this.sessionState.delete(sessionId);
    await this.tracerProvider.forceFlush();
  }

  /**
   * Evaluate a tool call through Phase 0–6 and record the pre-side span.
   *
   * Returns a decision rather than deciding HOW to block: Pi needs
   * `{ block: true, reason }`, opencode needs a thrown error, OpenClaw
   * needs `{ block: true, blockReason }`. Those shapes stay in the
   * binding layer.
   */
  async onPreTool(
    sessionId: string,
    spanKey: string,
    toolName: string,
    params: Record<string, unknown>,
    rawEvent: unknown,
    opts?: { toolCallId?: string; extraPreAttrs?: Record<string, unknown> },
  ): Promise<PreToolResult> {
    if (this.tracerProvider) {
      let state = ensureTurn(this.sessionState.get(sessionId) ?? null, sessionId);
      // `spanKey` is the internal correlation key (falls back to the tool
      // name when the platform gives no id) — it must never leak onto the
      // span as `gen_ai.tool.call.id`. Only a real platform-supplied id
      // may produce that attribute; otherwise it's omitted entirely.
      const preAttrs: Record<string, unknown> = {
        ...genAiToolCallInputAttributes(params, opts?.toolCallId),
        ...(opts?.extraPreAttrs ?? {}),
      };
      state = recordPreToolUse(state, spanKey, toolName, toolSummary(toolName, params), preAttrs);
      this.sessionState.set(sessionId, state);
    }
    if (this.meterProvider) {
      recordToolUse(this.meterProvider, toolName, 'PreToolUse').catch(() => {});
    }

    const startMs = Date.now();
    const result = await evaluateHook(
      this.adapter,
      rawEvent,
      { config: this.config, nio: { orchestrator: this.orchestrator } },
      this.auditOpts,
    );
    const evalMs = Date.now() - startMs;

    if (this.meterProvider) {
      recordGuardDecision(
        this.meterProvider,
        result.decision,
        result.riskLevel || 'low',
        result.riskScore ?? 0,
        toolName,
      ).catch(() => {});
    }

    const confirmAction = this.confirmAction;
    const decision: GuardDecisionTag =
      result.decision === 'deny'
        ? 'deny'
        : result.decision === 'ask'
          ? confirmAction === 'deny'
            ? 'confirm_denied'
            : confirmAction === 'ask'
              ? 'ask'
              : 'confirm_allowed'
          : 'allow';

    // The span taxonomy documented in traces-collector.ts is
    // {allow, deny, confirm_allowed, confirm_denied} — 'ask' is a
    // caller-facing signal ("prompt the user"), never a span value.
    // resolveConfirm overwrites this with the real outcome once a
    // platform that actually prompts (Pi) resolves it.
    const spanDecision: GuardDecisionTag = decision === 'ask' ? 'confirm_allowed' : decision;

    const guardAttrs: Record<string, unknown> = {
      ...nioGuardAttributes(
        spanDecision,
        result.riskLevel || (spanDecision === 'allow' ? 'low' : 'unknown'),
        result.riskScore ?? 0,
        result.riskTags,
        result.phaseStopped,
        result.topFindingRule,
      ),
      'nio.guard.eval_ms': evalMs,
    };
    this.stashGuardAttrs(sessionId, spanKey, guardAttrs);

    const block = decision === 'deny' || decision === 'confirm_denied';
    const reason =
      result.reason ||
      (decision === 'deny' ? 'Blocked by Nio' : 'Requires confirmation (Nio)');

    if (block) {
      // The post-side event will never fire because the tool did not run.
      // Flush the orphan span here with guard-error status. Use the safe
      // variant: the decision to block is already final at this point, so
      // a telemetry failure while closing the span must not cost the
      // caller its deny — see safeCloseSpan's doc comment.
      await this.safeCloseSpan(sessionId, spanKey, guardAttrs, reason);
      return { block: true, reason, decision };
    }

    return { block: false, decision, ...(decision === 'ask' ? { reason } : {}) };
  }

  /**
   * Apply the outcome of an interactive confirmation dialog. Only
   * platforms with a real user channel (Pi) call this; everyone else
   * gets the folded decision straight from `onPreTool`.
   */
  async resolveConfirm(
    sessionId: string,
    spanKey: string,
    decision: GuardDecisionTag,
    reason: string | undefined,
    confirmed: boolean,
  ): Promise<PreToolResult> {
    if (decision !== 'ask') return { block: false, decision, ...(reason ? { reason } : {}) };

    const resolved: GuardDecisionTag = confirmed ? 'confirm_allowed' : 'confirm_denied';
    const state = this.sessionState.get(sessionId);
    const prior = state ? (state.pending_guard_attrs?.[spanKey] ?? {}) : {};
    const merged = { ...prior, 'nio.guard.decision': resolved };
    this.stashGuardAttrs(sessionId, spanKey, merged);

    if (!confirmed) {
      const why = reason || 'Requires confirmation (Nio)';
      // Same reasoning as onPreTool's block path: the user has already
      // refused, so that refusal must survive a telemetry failure here.
      await this.safeCloseSpan(sessionId, spanKey, merged, why);
      return { block: true, reason: why, decision: resolved };
    }
    return { block: false, decision: resolved };
  }

  /** Close the tool span with the post-side outcome. */
  async onPostTool(
    sessionId: string,
    spanKey: string,
    toolName: string,
    outcome: { result?: unknown; error?: string | null; durationMs?: number },
  ): Promise<void> {
    if (this.tracerProvider) {
      const state = this.sessionState.get(sessionId);
      if (state) {
        const { state: drained, attrs } = takePendingGuardAttrs(state, spanKey);
        const postAttrs: Record<string, unknown> = {
          ...attrs,
          ...genAiToolCallOutputAttributes({
            result: outcome.result,
            error: outcome.error ?? null,
            durationMs: outcome.durationMs,
          }),
        };
        const r = await recordPostToolUse(
          this.tracerProvider,
          drained,
          spanKey,
          process.cwd(),
          postAttrs,
          outcome.error ?? null,
        );
        this.sessionState.set(sessionId, r.state);
      }
    }
    if (this.meterProvider) {
      await recordToolUse(this.meterProvider, toolName, 'PostToolUse');
    }
  }

  /** Capture the user prompt onto turn state; applied at endTurn time. */
  onUserPrompt(sessionId: string, text: string): void {
    if (!this.tracerProvider || !text) return;
    let state = ensureTurn(this.sessionState.get(sessionId) ?? null, sessionId);
    state = recordUserPrompt(state, text);
    this.sessionState.set(sessionId, state);
  }

  /** Capture the assistant reply onto turn state. */
  onAssistantReply(sessionId: string, text: string): void {
    if (!this.tracerProvider || !text) return;
    let state = ensureTurn(this.sessionState.get(sessionId) ?? null, sessionId);
    state = recordAssistantReply(state, text);
    this.sessionState.set(sessionId, state);
  }

  /** Accumulate token usage for the current turn. */
  onLlmUsage(
    sessionId: string,
    usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
  ): void {
    let state = ensureTurn(this.sessionState.get(sessionId) ?? null, sessionId);
    state = accumulateGenAiUsage(state, usage);
    this.sessionState.set(sessionId, state);
  }

  /** Sub-agent / Task span open. */
  async onSubagentStart(
    sessionId: string,
    taskId: string,
    auditDetails?: Record<string, unknown>,
  ): Promise<void> {
    this.writeLifecycle(sessionId, 'subagent_spawning', auditDetails ?? { subagent_id: taskId });
    if (this.tracerProvider) {
      let state = ensureTurn(this.sessionState.get(sessionId) ?? null, sessionId);
      state = recordPreTaskToolUse(state, taskId, '');
      this.sessionState.set(sessionId, state);
    }
    if (this.meterProvider) await recordToolUse(this.meterProvider, 'Task', 'TaskCreated');
  }

  /** Sub-agent / Task span close. */
  async onSubagentEnd(
    sessionId: string,
    taskId: string,
    auditDetails?: Record<string, unknown>,
  ): Promise<void> {
    this.writeLifecycle(sessionId, 'subagent_ended', auditDetails ?? { subagent_id: taskId });
    if (this.tracerProvider) {
      const state = this.sessionState.get(sessionId);
      if (state) {
        const r = await recordPostTaskToolUse(this.tracerProvider, state, taskId, process.cwd());
        this.sessionState.set(sessionId, r.state);
      }
    }
    if (this.meterProvider) await recordToolUse(this.meterProvider, 'Task', 'TaskCompleted');
  }

  /**
   * A shell command the *user* typed directly (Pi's `!` / `!!`).
   * Audit-only: Nio guards agent actions, not human keystrokes, so this
   * never blocks and never runs Phase 0–6.
   */
  onUserBash(sessionId: string, command: string, cwd: string): void {
    this.writeLifecycle(sessionId, 'user_bash', { command, cwd, actor: 'user' });
  }

  /** `/nio ...` sub-command router, shared by every platform. */
  async dispatchCommand(rawArgs: string): Promise<string> {
    try {
      return await dispatchNioCommand(rawArgs ?? '', {
        orchestrator: this.orchestrator,
        scanner: this.scanner,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.stack || err.message : String(err);
      return `[nio error] ${msg}`;
    }
  }

  private stashGuardAttrs(
    sessionId: string,
    spanKey: string,
    attrs: Record<string, unknown>,
  ): void {
    const state = this.sessionState.get(sessionId);
    if (!state) return;
    this.sessionState.set(sessionId, setPendingGuardAttrs(state, spanKey, attrs));
  }

  private async closeSpan(
    sessionId: string,
    spanKey: string,
    attrs: Record<string, unknown>,
    error: string | null,
  ): Promise<void> {
    if (!this.tracerProvider) return;
    const state = this.sessionState.get(sessionId);
    if (!state) return;
    const { state: drained } = takePendingGuardAttrs(state, spanKey);
    const r = await recordPostToolUse(
      this.tracerProvider, drained, spanKey, process.cwd(), attrs, error,
    );
    this.sessionState.set(sessionId, r.state);
  }

  /**
   * Like `closeSpan`, but never throws.
   *
   * Callers use this exclusively on paths where `{ block: true }` is
   * already the final answer — `onPreTool`'s deny path and
   * `resolveConfirm`'s "user said no" path. `closeSpan` awaits
   * `provider.getTracer(...)` / `recordPostToolUse` / `forceFlush`
   * unguarded; if any of that throws (a broken OTEL exporter, a network
   * blip on forceFlush), the `await` here would otherwise reject the
   * whole `onPreTool` / `resolveConfirm` call. Every binding's
   * platform-specific catch treats "not my deliberate block error" as
   * "fail open" (correct for a genuine Nio-internal failure) — but a
   * telemetry failure AFTER the decision is already made is not a Nio
   * failure to evaluate the action, it's a failure to record it. Losing
   * the span is acceptable; losing the deny is not.
   */
  private async safeCloseSpan(
    sessionId: string,
    spanKey: string,
    attrs: Record<string, unknown>,
    error: string | null,
  ): Promise<void> {
    try {
      await this.closeSpan(sessionId, spanKey, attrs, error);
    } catch {
      // The decision this call protects must survive regardless.
    }
  }
}
