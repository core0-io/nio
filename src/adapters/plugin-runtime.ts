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
import { isSessionMonitored, forgetSession } from '../scripts/lib/monitor-check.js';
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
  /**
   * Override the logger provider instead of building one from collector
   * config. Same `undefined` (build from config) vs `null` (explicitly
   * disabled) semantics as `tracerProvider`.
   */
  loggerProvider?: ReturnType<typeof createLoggerProvider>;
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

  protected readonly sessionState = new Map<string, CollectorState>();

  private readonly opts: PluginRuntimeOptions;
  private nio: NioInstance | null = null;
  private scannerInstance: SkillScanner | null = null;

  // ── Lazily-created OTEL providers ──────────────────────────────────
  //
  // Created on first *monitored* use, never at registration. This is not
  // just tidiness: `createMeterProvider` installs a
  // PeriodicExportingMetricReader with exportIntervalMillis: 1000, whose
  // background timer lives as long as the process. Building it eagerly
  // meant every long-running host that loaded this plugin — including
  // one whose user never ran `/nio monitor on` in their life — stood up
  // the full OTLP exporter stack and its timer. Deferring means a
  // never-armed host creates nothing at all.
  //
  // KNOWN RESIDUAL LIMITATION, documented in nio-monitor's SKILL.md:
  // this fixes the never-armed case only. Once *any* session in the
  // process has been armed and recorded a counter, OTel's cumulative
  // metric semantics mean that reader keeps exporting the accumulated
  // totals every second until the process exits.
  //
  // `loadCollectorConfig()` is deferred along with them, for the same
  // reason.
  private tracerProviderCache: ReturnType<typeof createTracerProvider> | undefined;
  private meterProviderCache: ReturnType<typeof createMeterProvider> | undefined;
  private loggerProviderCache: ReturnType<typeof createLoggerProvider> | undefined;
  private collectorConfigCache: ReturnType<typeof loadCollectorConfig> | undefined;

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
  }

  /**
   * Test seam: have any providers been constructed yet? Deliberately
   * ignores injected ones — the question it answers is "did the runtime
   * itself stand up an OTLP client", which is what the monitor gate
   * exists to prevent.
   */
  _providersBuiltForTests(): boolean {
    return this.tracerProviderCache !== undefined
      || this.meterProviderCache !== undefined
      || this.loggerProviderCache !== undefined;
  }

  /**
   * Per-session capture gate. Consulted on every event rather than
   * cached per session: `/nio monitor off` must take effect on the next
   * event, not at the next session boundary.
   *
   * A session id we cannot trust (empty, 'unknown', the platform name)
   * fails closed inside `isSessionMonitored` — see UNTRUSTED_SESSION_IDS.
   *
   * Guard evaluation NEVER consults this. The gate governs telemetry
   * only; a blocked tool call stays blocked whether or not the session
   * is armed.
   */
  protected isMonitored(sessionId: string): boolean {
    return isSessionMonitored(sessionId, process.cwd(), this.config.collector?.logs);
  }

  /**
   * Collector config is read on first monitored use, never at
   * registration — an operator who never armed a session must not have
   * their endpoint read, let alone an exporter stood up.
   */
  private getCollectorConfig(): ReturnType<typeof loadCollectorConfig> {
    if (this.collectorConfigCache === undefined) {
      this.collectorConfigCache = loadCollectorConfig();
    }
    return this.collectorConfigCache;
  }

  /**
   * Resource-level agent name is only set when the operator configured
   * one — empty / unset means "no gen_ai.agent.name on the resource".
   */
  private get agentName(): string | undefined {
    return this.config.agent_name && this.config.agent_name.length > 0
      ? this.config.agent_name
      : undefined;
  }

  protected getTracerProvider(): ReturnType<typeof createTracerProvider> {
    if (this.opts.tracerProvider !== undefined) return this.opts.tracerProvider;
    if (this.tracerProviderCache === undefined) {
      try {
        this.tracerProviderCache = createTracerProvider(
          this.getCollectorConfig(), this.platform, this.agentName,
        );
      } catch {
        this.tracerProviderCache = null;
      }
    }
    return this.tracerProviderCache;
  }

  protected getMeterProvider(): ReturnType<typeof createMeterProvider> {
    if (this.opts.meterProvider !== undefined) return this.opts.meterProvider;
    if (this.meterProviderCache === undefined) {
      try {
        this.meterProviderCache = createMeterProvider(
          this.getCollectorConfig(), this.platform, this.agentName,
        );
      } catch {
        this.meterProviderCache = null;
      }
    }
    return this.meterProviderCache;
  }

  protected getLoggerProvider(): ReturnType<typeof createLoggerProvider> {
    if (this.opts.loggerProvider !== undefined) return this.opts.loggerProvider;
    if (this.config.collector?.logs?.enabled === false) return null;
    if (this.loggerProviderCache === undefined) {
      try {
        this.loggerProviderCache = createLoggerProvider(
          this.getCollectorConfig(), this.platform, this.agentName,
        );
      } catch {
        this.loggerProviderCache = null;
      }
    }
    return this.loggerProviderCache;
  }

  /**
   * The logger provider only if one already exists — never builds one.
   * Used by flush paths that must not be the thing that stands an
   * exporter up.
   */
  private existingLoggerProvider(): ReturnType<typeof createLoggerProvider> {
    if (this.opts.loggerProvider !== undefined) return this.opts.loggerProvider;
    return this.loggerProviderCache ?? null;
  }

  /**
   * Audit options for one event. The local JSONL leg is never gated — it
   * is the user's own record, written to their own disk. Only the OTLP
   * leg (`loggerProvider`) is conditional on monitor state.
   */
  protected auditOptsFor(monitored: boolean): WriteAuditLogOptions {
    return {
      loggerProvider: monitored ? this.getLoggerProvider() : null,
      logsConfig: this.config.collector?.logs,
    };
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
    // Drop the session's arm record now instead of leaving it for the
    // 7-day TTL backstop — these are long-running hosts, so a session
    // that ends here won't get another chance to be reaped until the
    // process restarts or the backstop fires.
    forgetSession(sessionId, this.config.collector?.logs);
  }

  /**
   * Emit a session's accumulated turn state WITHOUT claiming a user turn
   * ended. The public, audit-silent half of `onTurnEnd`.
   *
   * Exists for sub-agent child sessions: a child accumulates its own
   * CollectorState (tools running inside the sub-agent arrive keyed on
   * the child id) and that state must be flushed at the child's own idle
   * so its spans land under a turn root emitted at the right time. But
   * the child's idle is not a user turn end — the sub-agent's lifecycle
   * is already recorded on the parent as `subagent_spawning` /
   * `subagent_ended`, and writing `agent_end` for the child would put a
   * row in the audit log that reads, to anyone querying it directly, as
   * a turn the user ended. `flushSessionTurn` itself is `protected`, so
   * without this the only reachable entry point was `onTurnEnd`.
   */
  async flushTurnSpans(sessionId: string): Promise<void> {
    const monitored = this.isMonitored(sessionId);
    await this.flushSessionTurn(sessionId);
    // Unmonitored: nothing was exported, so there is nothing to flush —
    // and resolving the provider here would be exactly the "build an
    // exporter for a session nobody armed" the gate exists to prevent.
    if (!monitored) return;
    const loggerProvider = this.getLoggerProvider();
    if (loggerProvider) await loggerProvider.forceFlush();
  }

  /** Per-turn flush. Idempotent: no-op when no state exists. */
  async onTurnEnd(sessionId: string): Promise<void> {
    this.writeLifecycle(sessionId, 'agent_end');
    await this.flushTurnSpans(sessionId);
  }

  /** Increment the per-turn counter. Separate from onTurnEnd so
   *  platforms that flush turns and count turns at different events can
   *  call them independently. */
  async recordTurnMetric(sessionId: string): Promise<void> {
    if (!this.isMonitored(sessionId)) return;
    const meterProvider = this.getMeterProvider();
    if (meterProvider) await recordTurn(meterProvider);
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
    // Process-wide teardown has no session id of its own, so it flushes
    // whatever provider already exists rather than resolving (and thus
    // possibly building) one.
    const loggerProvider = this.existingLoggerProvider();
    if (loggerProvider) await loggerProvider.forceFlush();
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
    writeAuditLog(entry, this.auditOptsFor(this.isMonitored(sessionId)));
  }

  /**
   * Compute cache_hit_rate, defensively close any leftover pending
   * tool/task spans, emit the turn root span, drop per-session state.
   * Idempotent: no-op if no state exists.
   */
  protected async flushSessionTurn(sessionId: string): Promise<void> {
    // Cleanup and export are separate concerns: an unmonitored session
    // must still have its state dropped, otherwise state accumulated
    // while briefly armed (then disarmed before this boundary fired)
    // would sit in `sessionState` for the rest of the process's life —
    // and worse, get exported later if the session is re-armed and a
    // subsequent boundary finds that leftover state still there.
    const monitored = this.isMonitored(sessionId);
    const tracerProvider = monitored ? this.getTracerProvider() : null;
    if (!tracerProvider) {
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
        tracerProvider,
        state,
        k,
        process.cwd(),
        { ...attrs, ...nioReclaimedSpanAttributes() },
        null,
      );
      state = r.state;
    }
    for (const k of Object.keys(state.pending_task_spans ?? {})) {
      const r = await recordPostTaskToolUse(tracerProvider, state, k, process.cwd());
      state = r.state;
    }

    await endTurn(tracerProvider, state, process.cwd());
    this.sessionState.delete(sessionId);
    await tracerProvider.forceFlush();
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
    // Guard evaluation below runs regardless — the monitor gate only
    // controls telemetry, never enforcement. An unarmed session leaves
    // both providers null and nothing is recorded.
    const monitored = this.isMonitored(sessionId);
    const tracerProvider = monitored ? this.getTracerProvider() : null;
    const meterProvider = monitored ? this.getMeterProvider() : null;

    if (tracerProvider) {
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
    if (meterProvider) {
      recordToolUse(meterProvider, toolName, 'PreToolUse').catch(() => {});
    }

    const startMs = Date.now();
    const result = await evaluateHook(
      this.adapter,
      rawEvent,
      { config: this.config, nio: { orchestrator: this.orchestrator } },
      this.auditOptsFor(monitored),
    );
    const evalMs = Date.now() - startMs;

    if (meterProvider) {
      recordGuardDecision(
        meterProvider,
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
    const monitored = this.isMonitored(sessionId);
    const state = this.sessionState.get(sessionId);
    if (state) {
      // Drain the guard attrs parked for this key by `onPreTool`
      // REGARDLESS of monitor state, and before the export gate below.
      // A value stashed while armed must not outlive this tool call: if
      // the session is disarmed here and re-armed before the span is
      // finally closed, that stale decision would merge onto a later,
      // legitimate export of the same span.
      const { state: drained, attrs } = takePendingGuardAttrs(state, spanKey);
      this.sessionState.set(sessionId, drained);

      const tracerProvider = monitored ? this.getTracerProvider() : null;
      if (tracerProvider) {
        const postAttrs: Record<string, unknown> = {
          ...attrs,
          ...genAiToolCallOutputAttributes({
            result: outcome.result,
            error: outcome.error ?? null,
            durationMs: outcome.durationMs,
          }),
        };
        const r = await recordPostToolUse(
          tracerProvider,
          drained,
          spanKey,
          process.cwd(),
          postAttrs,
          outcome.error ?? null,
        );
        this.sessionState.set(sessionId, r.state);
      }
    }
    const meterProvider = monitored ? this.getMeterProvider() : null;
    if (meterProvider) {
      await recordToolUse(meterProvider, toolName, 'PostToolUse');
    }
  }

  /** Capture the user prompt onto turn state; applied at endTurn time. */
  onUserPrompt(sessionId: string, text: string): void {
    if (!text || !this.isMonitored(sessionId) || !this.getTracerProvider()) return;
    let state = ensureTurn(this.sessionState.get(sessionId) ?? null, sessionId);
    state = recordUserPrompt(state, text);
    this.sessionState.set(sessionId, state);
  }

  /** Capture the assistant reply onto turn state. */
  onAssistantReply(sessionId: string, text: string): void {
    if (!text || !this.isMonitored(sessionId) || !this.getTracerProvider()) return;
    let state = ensureTurn(this.sessionState.get(sessionId) ?? null, sessionId);
    state = recordAssistantReply(state, text);
    this.sessionState.set(sessionId, state);
  }

  /** Accumulate token usage for the current turn. */
  onLlmUsage(
    sessionId: string,
    usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
  ): void {
    if (!this.isMonitored(sessionId)) return;
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
    const monitored = this.isMonitored(sessionId);
    const tracerProvider = monitored ? this.getTracerProvider() : null;
    if (tracerProvider) {
      let state = ensureTurn(this.sessionState.get(sessionId) ?? null, sessionId);
      state = recordPreTaskToolUse(state, taskId, '');
      this.sessionState.set(sessionId, state);
    }
    const meterProvider = monitored ? this.getMeterProvider() : null;
    if (meterProvider) await recordToolUse(meterProvider, 'Task', 'TaskCreated');
  }

  /** Sub-agent / Task span close. */
  async onSubagentEnd(
    sessionId: string,
    taskId: string,
    auditDetails?: Record<string, unknown>,
  ): Promise<void> {
    this.writeLifecycle(sessionId, 'subagent_ended', auditDetails ?? { subagent_id: taskId });
    const monitored = this.isMonitored(sessionId);
    const tracerProvider = monitored ? this.getTracerProvider() : null;
    if (tracerProvider) {
      const state = this.sessionState.get(sessionId);
      if (state) {
        const r = await recordPostTaskToolUse(tracerProvider, state, taskId, process.cwd());
        this.sessionState.set(sessionId, r.state);
      }
    }
    const meterProvider = monitored ? this.getMeterProvider() : null;
    if (meterProvider) await recordToolUse(meterProvider, 'Task', 'TaskCompleted');
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
    const tracerProvider = this.isMonitored(sessionId) ? this.getTracerProvider() : null;
    if (!tracerProvider) return;
    const state = this.sessionState.get(sessionId);
    if (!state) return;
    const { state: drained } = takePendingGuardAttrs(state, spanKey);
    const r = await recordPostToolUse(
      tracerProvider, drained, spanKey, process.cwd(), attrs, error,
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
