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
import { loadCollectorConfig, loadContentLimits } from '../scripts/lib/config-loader.js';
import { createSourceForPlatform, type SourceInput } from '../scripts/lib/conversation/factory.js';
import type { ChatCall } from '../scripts/lib/conversation/types.js';
import {
  createContentSink,
  emitToolInputContent,
  emitToolOutputContent,
} from '../scripts/lib/content/sink.js';
import {
  createTracerProvider,
  endTurn,
  recordCacheHitRate,
  recordPostToolUse,
  deferPostToolUse,
  recordPostTaskToolUse,
  recordUserPrompt,
  recordAssistantReply,
  accumulateGenAiUsage,
  recordPreTaskToolUse,
  type CollectorState,
} from '../scripts/lib/traces-collector.js';
import { createMeterProvider } from '../scripts/lib/metrics-collector.js';
import { createLoggerProvider } from '../scripts/lib/logs-collector.js';
import { isSessionMonitored, forgetSession } from '../scripts/lib/monitor-check.js';
import { dumpPayload } from '../scripts/lib/payload-dump.js';
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
  /**
   * Override the logger provider instead of building one from collector
   * config. Same `undefined` (build from config) vs `null` (explicitly
   * disabled) semantics as `tracerProvider`. Tests inject an in-memory
   * logger so the content pipeline actually runs.
   */
  loggerProvider?: ReturnType<typeof createLoggerProvider>;
  /**
   * Export a finished tool span the moment the post-side event arrives,
   * as a direct child of the turn root, instead of parking it for
   * end-of-turn attribution under the chat call that issued it.
   *
   * Defaults to false (park + attribute), which is what every platform
   * whose `ConversationSource` reconstructs `tool_use` blocks wants —
   * Pi and opencode both do, and both carry non-synthetic timing, so
   * `buildSpanTree` can name the issuing call.
   *
   * OpenClaw sets it to true. There, attribution is impossible in
   * principle: `createOpenClawSource` emits no `tool_use` block and all
   * its calls are `timing: 'synthetic'`, so both of `buildSpanTree`'s
   * channels are unavailable and a parked span would land on the turn
   * root anyway — the exact same tree, bought with a real loss. The
   * in-process family keeps its turn state in memory only (no
   * `traces-state-store-<session>.json`, so no recovery replay), so a
   * span parked until turn close is simply gone if the host dies first.
   * Paying that for no structural gain is the trade OpenClaw declines.
   * See `openclaw-span-hierarchy.test.ts` and
   * `pi-opencode-span-hierarchy.test.ts`.
   */
  eagerToolSpans?: boolean;
}

/**
 * Oldest conversation events are dropped past this many per session.
 * See `recordConversationEvent`.
 *
 * The unit is a SLOT, not a delivered event: a binding that hands over
 * repeated snapshots of the same logical thing gives them all one dedup
 * key and they share one slot. Denominating the cap in raw deliveries
 * was wrong for any streaming platform — see `recordConversationEvent`.
 */
const MAX_CONVERSATION_EVENTS = 200;

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

  /**
   * Per-TURN conversation events. Streaming platforms (OpenClaw,
   * opencode) have no session file to read back, so these events ARE the
   * conversation.
   *
   * Cleared on every exit from `flushSessionTurn` — including the exit
   * taken when the turn produced no state at all — and again at
   * `onSessionStart`, so a recycled session id starts empty. Anything
   * left behind is replayed by the next turn as ITS chat spans; see the
   * try/finally in `flushSessionTurn` for why no timestamp filter can
   * make up for a missed clear.
   */
  private readonly conversationEvents = new Map<string, Map<string, unknown>>();

  /**
   * Source of the synthetic slot keys handed to unkeyed events. Process-
   * wide rather than per-session so no two sessions can ever collide, and
   * monotonic so `Map` insertion order stays the arrival order.
   */
  private conversationSlotSeq = 0;

  /**
   * Per-session transcript path, for the replay platforms in this family
   * (Pi). Unlike `conversationEvents` this is deliberately NOT cleared at
   * the turn boundary: the session file is a property of the SESSION, and
   * every turn after the first replays the same file, scoped by
   * `callsSince(turn_start_ms)`. Dropping it in `flushSessionTurn` would
   * leave turn 2 onwards with no source at all.
   */
  private readonly transcriptPaths = new Map<string, string>();

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
  // totals every second until the process exits — disarming, session_end
  // and forgetSession all stop *new* data being recorded, but none of
  // them can stop that timer. Restarting the host does.
  //
  // `loadCollectorConfig()` is deferred along with them, for the same
  // reason (nothing collector-related should happen before a monitored
  // event) and with the side benefit that an endpoint edited after
  // startup is picked up rather than frozen at registration.
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

  /**
   * Debug-only payload sampling (`NIO_DUMP_PAYLOAD=<dir>`), tagged with
   * this runtime's platform. Deliberately NOT gated by monitor state:
   * it writes to a local directory the operator named themselves and
   * never touches the network — see payload-dump.ts's module doc.
   *
   * The event name and the envelope shape are the binding's to choose
   * (OpenClaw dumps `{ event, ctx }` under its own hook names), so this
   * is a pass-through rather than something the runtime calls itself.
   */
  dumpEvent(eventName: string, payload: unknown): void {
    dumpPayload(this.platform, eventName, payload);
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

  /**
   * Accumulate one platform conversation event.
   *
   * Streaming platforms (OpenClaw, opencode) have no session file to
   * read back and no whole-conversation payload, so the only way to know
   * which LLM call issued which tool call is to keep the events as they
   * arrive. Replay platforms (Pi) leave this untouched and override
   * `conversationInputFor` to supply a transcript path instead.
   *
   * Accumulates regardless of monitor state, deliberately: a session
   * armed mid-turn should still produce a coherent turn rather than half
   * of one. Only the export at turn close is gated — and an unmonitored
   * turn's events are dropped there rather than exported, so nothing
   * accumulated while unarmed can leak later.
   *
   * `dedupKey` collapses SNAPSHOT streams at ingest. opencode publishes
   * one `message.updated` per change to an assistant message and one
   * `message.part.updated` per streamed chunk of every part, each
   * carrying the whole thing so far; its `ConversationSource` already
   * throws all but the last snapshot of each id away when it rebuilds
   * the turn. Keeping them all until then is not just waste — it is what
   * made the cap below count network deliveries instead of LLM calls, so
   * a 10-call turn streaming 100 chunks per call blew a 200-slot budget
   * with ~1030 events and lost 8 of its 10 chat spans, orphaning the
   * tool spans that would have nested under them back onto the turn
   * root. With a key, a snapshot REPLACES its predecessor in the slot it
   * first claimed — same collapse the source performs, moved to where
   * the cap can see it, and `Map.set` on an existing key keeps that
   * first-seen position so block order is unchanged.
   *
   * Omitting the key (OpenClaw, whose `llm_output` is one delivery per
   * LLM call and never re-published) gives every event its own slot,
   * i.e. exactly the previous append-and-cap behaviour.
   */
  recordConversationEvent(sessionId: string, event: unknown, dedupKey?: string): void {
    const slots = this.conversationEvents.get(sessionId) ?? new Map<string, unknown>();
    // Namespaced apart so a binding's key can never collide with a
    // synthetic one, however the binding chooses to spell it.
    const key = dedupKey !== undefined ? `k:${dedupKey}` : `#${this.conversationSlotSeq++}`;
    slots.set(key, event);
    // Hard cap. These are long-running hosts, and an unbounded
    // per-session store is a memory leak with extra steps. A turn with
    // more calls than this loses its earliest chat spans — the tool
    // spans that would have named them fall back to hanging off the turn
    // root, the same degraded shape as having no source at all, which is
    // a better failure than growing without bound.
    if (slots.size > MAX_CONVERSATION_EVENTS) {
      for (const k of slots.keys()) {
        slots.delete(k);
        if (slots.size <= MAX_CONVERSATION_EVENTS) break;
      }
    }
    this.conversationEvents.set(sessionId, slots);
  }

  /**
   * Hand the runtime a session file to replay instead of events.
   *
   * Pi is the replay platform in this family: it has a real session JSONL
   * on disk, so its binding calls this at `session_start` rather than
   * feeding `recordConversationEvent`. A null path (Pi's ephemeral
   * sessions, where `getSessionFile()` returns null) clears any prior
   * entry, so the session degrades to "no source" rather than replaying a
   * stale file from a recycled id.
   */
  setTranscriptPath(sessionId: string, path: string | null): void {
    if (path) this.transcriptPaths.set(sessionId, path);
    else this.transcriptPaths.delete(sessionId);
  }

  /**
   * Where this platform's conversation comes from. A transcript path
   * handed over by a replay binding wins; otherwise the streaming shape.
   */
  protected conversationInputFor(sessionId: string): SourceInput {
    const transcriptPath = this.transcriptPaths.get(sessionId);
    if (transcriptPath) return { transcriptPath };
    // Slot values in first-claimed order — the array shape every
    // streaming `ConversationSource` expects.
    return { events: [...(this.conversationEvents.get(sessionId)?.values() ?? [])] };
  }

  /** Hard session boundary — drop stale turn numbering, write audit row. */
  onSessionStart(sessionId: string): void {
    this.sessionState.delete(sessionId);
    // A recycled session id must not inherit the previous session's
    // calls — they would be replayed as this session's chat spans. Same
    // reasoning for the transcript path: a new session under a reused id
    // must not replay the old session's file until its own
    // setTranscriptPath arrives.
    this.conversationEvents.delete(sessionId);
    this.transcriptPaths.delete(sessionId);
    this.writeLifecycle(sessionId, 'session_start');
  }

  /** Last-resort flush before a session is torn down. */
  async onSessionEnd(sessionId: string): Promise<void> {
    this.writeLifecycle(sessionId, 'session_end');
    await this.flushSessionTurn(sessionId);
    // The session file belongs to the session, so this — not the turn
    // boundary — is where it stops being ours to replay.
    this.transcriptPaths.delete(sessionId);
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
    // The accumulated conversation events belong to the TURN that is
    // ending here, so they are dropped on EVERY exit — including the two
    // early returns and an unexpected throw out of the export path.
    // try/finally rather than a delete per exit: the `!state` early
    // return used to be the one path that kept them, and that path is
    // routinely taken in production. OpenClaw's binding only calls
    // `onLlmUsage` / `onAssistantReply` when the undocumented `usage` /
    // `assistantTexts` fields happen to be present (see
    // openclaw-source.ts's module doc), so a turn made of
    // documented-shape `llm_output` events alone reaches `agent_end`
    // with no turn state at all. Anything left in the map then gets
    // replayed by the NEXT turn as its own chat spans — and the
    // `callsSince` timestamp filter cannot catch it, because
    // `openclaw-source.ts` synthesises `startMs` from `Date.now()` at
    // read time, making the filter unconditionally true.
    //
    // Contrast `transcriptPaths`, which is per-SESSION and deliberately
    // survives the turn boundary — see its field comment.
    try {
      await this.flushSessionTurnInner(sessionId);
    } finally {
      this.conversationEvents.delete(sessionId);
    }
  }

  private async flushSessionTurnInner(sessionId: string): Promise<void> {
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

    // Reconstruct this turn's LLM calls from whatever the platform
    // handed us, so tool spans can nest under the call that issued them
    // and the assistant's own words reach the logs signal. A source that
    // yields nothing (no events seen, malformed events, a platform with
    // no source yet) degrades to the flat `turn → tool` shape rather
    // than failing the flush.
    let calls: ChatCall[] | undefined;
    try {
      const source = createSourceForPlatform(this.platform, this.conversationInputFor(sessionId));
      calls = source?.callsSince(state.turn_start_ms);
    } catch {
      calls = undefined;
    }

    // No provider (logs disabled) → no sink → structure only, no
    // content. The monitor gate is already applied: `monitored` guards
    // every provider resolution in this method.
    const loggerProvider = this.getLoggerProvider();
    const contentSink = loggerProvider
      ? createContentSink(loggerProvider, loadContentLimits())
      : undefined;

    await endTurn(tracerProvider, state, process.cwd(), null, calls, contentSink);
    this.sessionState.delete(sessionId);
    await tracerProvider.forceFlush();
    if (loggerProvider) await loggerProvider.forceFlush();
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
    // Telemetry is gated; the guard evaluation below is NOT. Resolving a
    // provider is what constructs it, so both resolutions sit behind
    // `monitored` — an unarmed session leaves them null and nothing is
    // ever built for it. Pending-span state is gated for the same
    // reason: nothing downstream would ever drain it.
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
      // The tool span id exists from this moment, so the arguments can go
      // out already associated with it. Emitted HERE rather than at the
      // post side (where collector-core's hook path does it) because this
      // is the only moment they are in hand: `onPostTool` receives an
      // outcome, not the params. It also means a call the guard is about
      // to DENY still contributes its arguments — the ones a reviewer
      // most wants — even though its post-side event never fires.
      this.emitToolContent(
        'input',
        monitored,
        state.pending_spans[spanKey]?.span_id,
        state.turn_trace_id,
        params,
        opts?.toolCallId,
      );
    }
    if (meterProvider) {
      recordToolUse(meterProvider, toolName, 'PreToolUse').catch(() => {});
    }

    // Guard evaluation and the block decision below run unconditionally
    // — the monitor gate only controls telemetry, never enforcement.
    // Only the OTEL LogRecord leg of any audit entries evaluateHook
    // writes is suppressed when unmonitored (auditOptsFor); the local
    // JSONL leg always fires.
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
      await this.safeCloseSpan(sessionId, spanKey, guardAttrs, reason, tracerProvider);
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
      await this.safeCloseSpan(
        sessionId, spanKey, merged, why,
        this.isMonitored(sessionId) ? this.getTracerProvider() : null,
      );
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
        // Read the span id BEFORE the call below removes the pending
        // entry, so the result record can name the span the backend is
        // about to receive.
        const pending = drained.pending_spans[spanKey];
        this.emitToolContent(
          'output',
          monitored,
          pending?.span_id,
          drained.turn_trace_id,
          outcome.result,
          pending?.attributes?.['gen_ai.tool.call.id'] as string | undefined,
        );
        // Park by default so `endTurn` can nest this span under the chat
        // call that issued it — nothing at THIS moment knows which call
        // that was. `eagerToolSpans` opts a platform out; see its doc.
        const r = this.opts.eagerToolSpans
          ? await recordPostToolUse(
              tracerProvider,
              drained,
              spanKey,
              process.cwd(),
              postAttrs,
              outcome.error ?? null,
            )
          : deferPostToolUse(
              drained,
              spanKey,
              process.cwd(),
              postAttrs,
              outcome.error ?? null,
            );
        this.sessionState.set(sessionId, r.state);
      }
    }
    if (monitored) {
      const meterProvider = this.getMeterProvider();
      if (meterProvider) await recordToolUse(meterProvider, toolName, 'PostToolUse');
    }
  }

  /** Capture the user prompt onto turn state; applied at endTurn time. */
  onUserPrompt(sessionId: string, text: string): void {
    if (!text || !this.isMonitored(sessionId)) return;
    if (!this.getTracerProvider()) return;
    let state = ensureTurn(this.sessionState.get(sessionId) ?? null, sessionId);
    state = recordUserPrompt(state, text);
    this.sessionState.set(sessionId, state);
  }

  /** Capture the assistant reply onto turn state. */
  onAssistantReply(sessionId: string, text: string): void {
    if (!text || !this.isMonitored(sessionId)) return;
    if (!this.getTracerProvider()) return;
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
    if (monitored) {
      const meterProvider = this.getMeterProvider();
      if (meterProvider) await recordToolUse(meterProvider, 'Task', 'TaskCreated');
    }
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
    if (monitored) {
      const meterProvider = this.getMeterProvider();
      if (meterProvider) await recordToolUse(meterProvider, 'Task', 'TaskCompleted');
    }
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

  /**
   * Put one tool call's arguments or result on the logs signal, against
   * the tool span id minted at PreToolUse.
   *
   * This is the in-process family's half of what `collector-core.ts`
   * does on the hook path (`emitToolInputContent` /
   * `emitToolOutputContent`). Without it, OpenClaw / Pi / opencode put
   * tool arguments on the wire ONLY as the issuing chat call's
   * `tool_use` block — which means not at all for a call the guard
   * denied, or in a session with no usable `ConversationSource` (Pi's
   * ephemeral sessions, an OpenClaw turn whose events never arrived) —
   * and put tool RESULTS on the wire never, since no `ContentBlock`
   * carries a tool result. See `buildToolInputRecord`'s doc for why the
   * overlap with the `tool_use` block is intentional rather than
   * deduplicated.
   *
   * Gated like every other export: `monitored` is computed by the caller
   * for this event, and no provider is resolved (let alone built) for an
   * unarmed session.
   */
  private emitToolContent(
    kind: 'input' | 'output',
    monitored: boolean,
    spanId: string | undefined,
    traceId: string | undefined,
    payload: unknown,
    toolCallId: string | undefined,
  ): void {
    if (!monitored || !spanId || !traceId) return;
    const loggerProvider = this.getLoggerProvider();
    if (!loggerProvider) return;
    // Tool params and results come off live host objects on this family
    // (not off JSON.parse), so a cycle or a BigInt is reachable and
    // `JSON.stringify` throws on both. Losing one content record is
    // acceptable; taking the tool call down with it is not.
    let text: string;
    try {
      if (typeof payload === 'string') text = payload;
      else if (payload === undefined || payload === null) text = '';
      else {
        const json = JSON.stringify(payload);
        // `{}` carries no information and would just cost a record.
        text = json === undefined || json === '{}' ? '' : json;
      }
    } catch {
      return;
    }
    if (!text) return;
    const limits = loadContentLimits();
    const opts = { spanId, traceId, ...(toolCallId ? { toolCallId } : {}) };
    if (kind === 'input') emitToolInputContent(loggerProvider, limits, { input: text, ...opts });
    else emitToolOutputContent(loggerProvider, limits, { result: text, ...opts });
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
    tracerProvider: ReturnType<typeof createTracerProvider>,
  ): Promise<void> {
    // The provider is passed in, already gated, rather than resolved
    // here: every caller has computed `monitored` for this event
    // already, and re-deriving it would mean a second monitor-store read
    // on the block path.
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
    tracerProvider: ReturnType<typeof createTracerProvider>,
  ): Promise<void> {
    try {
      await this.closeSpan(sessionId, spanKey, attrs, error, tracerProvider);
    } catch {
      // The decision this call protects must survive regardless.
    }
  }
}
