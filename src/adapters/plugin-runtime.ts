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
} from '../scripts/lib/traces-collector.js';
import { toolSummary } from '../scripts/lib/collector-core.js';
import { recordToolUse, recordGuardDecision } from '../scripts/lib/metrics-collector.js';

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

    this.tracerProvider = createTracerProvider(collectorConfig, opts.platform, agentName);
    this.meterProvider = createMeterProvider(collectorConfig, opts.platform, agentName);
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
      const r = await recordPostToolUse(this.tracerProvider, state, k, process.cwd(), {}, null);
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
    extraPreAttrs?: Record<string, unknown>,
  ): Promise<PreToolResult> {
    if (this.tracerProvider) {
      let state = ensureTurn(this.sessionState.get(sessionId) ?? null, sessionId);
      const preAttrs: Record<string, unknown> = {
        ...genAiToolCallInputAttributes(params, spanKey),
        ...(extraPreAttrs ?? {}),
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

    const guardAttrs: Record<string, unknown> = {
      ...nioGuardAttributes(
        decision,
        result.riskLevel || (decision === 'allow' ? 'low' : 'unknown'),
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
      // Flush the orphan span here with guard-error status.
      await this.closeSpan(sessionId, spanKey, guardAttrs, reason);
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
      await this.closeSpan(sessionId, spanKey, merged, why);
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
}
