# Pi + opencode Platform Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the full Nio feature set — guard Phase 0–6, OTEL traces/metrics/logs, audit log, `/nio` skill surface, installer, release pipeline — to two new agent platforms, Pi and opencode.

**Architecture:** Pi and opencode are both *in-process plugin* platforms, structurally identical to OpenClaw (the plugin loads as a JS module inside the agent process; state lives in memory). Rather than triplicating `src/adapters/openclaw-plugin.ts`, this plan first extracts its platform-agnostic ~70% into a shared `InProcessPluginRuntime`, then adds two thin binding layers that translate platform events into runtime calls. The guard side reuses the existing `HookAdapter` + `evaluateHook` contract unchanged, so Phase 0–6 is not touched.

**Tech Stack:** TypeScript (strict), `@opentelemetry/sdk-trace-node` / `sdk-metrics` / `sdk-logs`, zod, Node's built-in `node:test` runner. Build: `pnpm run build` (tsc → bun bundle → sync-shared → sync-site-version). Tests run from compiled `dist/`.

**Design spec:** `docs/superpowers/specs/2026-08-05-pi-opencode-support-design.md`

## Global Constraints

- No `Co-Authored-By: Claude` trailer on any git commit (repo rule).
- Do not create new git branches; work on the current branch `pi-and-opencode-support` (repo rule).
- Tests must never read/write real user paths — use `NIO_HOME=$(mktemp -d)` / `mkdtemp` (repo rule). This includes never copying, sed-ing, or moving `~/.nio/config.yaml`, `~/.pi/agent/settings.json`, `~/.config/opencode/opencode.json`, or `~/.hermes/**`.
- Every new `.ts` / `.js` source file must start with the two-line license header, or the husky `check-license-headers` hook fails:
  ```
  // Copyright 2026 core0-io
  // SPDX-License-Identifier: Apache-2.0
  ```
- Source of truth for skill docs is `plugins/shared/skills/**`. Never hand-edit the synced copies under `plugins/{claude-code,codex,openclaw,pi,opencode}/skills/` — run `node scripts/sync-shared.js`.
- Node.js >= 18.
- Platform tag strings are exactly `pi` and `opencode`. `checkToolGate` derives its config key via `platform.replace(/-/g, '_')`, so the config keys are also `pi` and `opencode`.
- Platform and agent identity (`service.name`, `nio.platform`, `gen_ai.agent.name`) live **only** on the OTEL Resource — never duplicated onto spans, log records, or metric labels (`src/scripts/lib/traces-collector.ts:282`).
- Nio must fail open: a Nio failure never breaks the host agent. The single exception is the deliberate block path.
- Full test command: `pnpm run build && pnpm test`. Single file: `pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/<name>.test.js`.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/adapters/plugin-runtime.ts` | Platform-agnostic in-process plugin runtime: config, 3 OTEL providers, per-session `CollectorState`, guard→attrs translation, orphan-span compensation, turn flush, `/nio` dispatch | Create |
| `src/adapters/pi.ts` | `PiAdapter implements HookAdapter` | Create |
| `src/adapters/opencode.ts` | `OpenCodeAdapter implements HookAdapter` | Create |
| `src/adapters/pi-plugin.ts` | Pi extension binding — event translation only | Create |
| `src/adapters/opencode-plugin.ts` | opencode plugin binding — event translation only | Create |
| `src/adapters/openclaw-plugin.ts` | Slimmed to event translation; delegates to runtime | Modify |
| `src/adapters/hook-engine.ts:113` | `parseMcpToolName` gains an `opencode` branch | Modify |
| `src/adapters/mcp-registry.ts` | `MCPSource` gains `'opencode'`; reads opencode config | Modify |
| `src/adapters/index.ts` | Barrel exports for the new symbols | Modify |
| `src/core/shared/detection-data.ts` | Sensitive-path entries for `.pi/` and `.opencode/` | Modify |
| `src/adapters/openclaw-dispatch.ts` → `runDoctor()` | New "Platform Integrations" section with install probes for both platforms | Modify |
| `plugins/pi/**` | Pi package: manifest, bundled extension, skills, setup.sh | Create |
| `plugins/opencode/**` | opencode plugin: bundled plugin, commands, skills, setup.sh | Create |
| `scripts/{build,sync-shared,release,sync-versions}.js` | Pipeline wiring for two new targets | Modify |
| `src/tests/plugin-runtime.test.ts` | Runtime unit tests (highest-value new test) | Create |
| `src/tests/fixtures/{pi,opencode}/*.json` | Real event payload fixtures | Create |

---

## Phase A — Shared runtime

### Task 1: `InProcessPluginRuntime` — construction and session lifecycle

**Files:**
- Create: `src/adapters/plugin-runtime.ts`
- Create: `src/tests/plugin-runtime.test.ts`

**Interfaces:**
- Consumes: `loadConfig()` from `./common.js`; `loadCollectorConfig()` from `../scripts/lib/config-loader.js`; `createTracerProvider(config, platform, agentName)`, `createMeterProvider(...)`, `createLoggerProvider(...)`; `ensureTurn(prev, sessionId)`, `endTurn(provider, state, cwd)`, `recordCacheHitRate(state)`, `recordPostToolUse(provider, state, spanKey, cwd, attrs, error)`, `recordPostTaskToolUse(provider, state, taskId, cwd)`; `writeAuditLog(entry, opts)`; `ActionOrchestrator`; `SkillScanner`.
- Produces: `class InProcessPluginRuntime` with constructor `(opts: PluginRuntimeOptions)` and methods `onSessionStart(sessionId): void`, `onSessionEnd(sessionId): Promise<void>`, `onTurnEnd(sessionId): Promise<void>`, plus the getters `get orchestrator(): ActionOrchestrator` and `get scanner(): SkillScanner`, and the test seam `_setSessionStateForTests(sessionId: string, state: CollectorState): void`. Later tasks add `onPreTool`, `onPostTool`, `onUserPrompt`, `onAssistantReply`, `onLlmUsage`, `onSubagentStart`, `onSubagentEnd`, `onUserBash`, `dispatchCommand`.
- `PluginRuntimeOptions` = `{ platform: string; adapter: HookAdapter; level?: string; nioFactory?: () => NioInstance }`.

- [ ] **Step 1: Write the failing test**

Create `src/tests/plugin-runtime.test.ts`:

```ts
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InProcessPluginRuntime } from '../adapters/plugin-runtime.js';
import { OpenClawAdapter } from '../adapters/openclaw.js';
import { ensureTurn } from '../scripts/lib/traces-collector.js';
import { makeInMemoryTracer } from './helpers/tracer.js';

describe('InProcessPluginRuntime', () => {
  function makeRuntime() {
    return new InProcessPluginRuntime({
      platform: 'test-platform',
      adapter: new OpenClawAdapter(),
    });
  }

  it('exposes the configured platform tag', () => {
    assert.equal(makeRuntime().platform, 'test-platform');
  });

  it('lazily builds one orchestrator and reuses it', () => {
    const rt = makeRuntime();
    assert.equal(rt.orchestrator, rt.orchestrator);
  });

  it('onSessionStart clears state left over from a previous session', () => {
    // The real regression this guards: turn numbering leaking across a
    // session boundary. Seed state first, or the assertion passes against
    // an empty method body.
    const rt = makeRuntime();
    rt._setSessionStateForTests('s1', ensureTurn(null, 's1'));
    assert.equal(rt.hasSessionState('s1'), true);
    rt.onSessionStart('s1');
    assert.equal(rt.hasSessionState('s1'), false);
  });

  it('onSessionEnd flushes and drops the session state', async () => {
    const rt = makeRuntime();
    rt._setSessionStateForTests('s1', ensureTurn(null, 's1'));
    assert.equal(rt.hasSessionState('s1'), true);
    await rt.onSessionEnd('s1');
    assert.equal(rt.hasSessionState('s1'), false);
  });

  it('onSessionEnd is a no-op when no state exists', async () => {
    const rt = makeRuntime();
    await rt.onSessionEnd('never-seen');
    assert.equal(rt.hasSessionState('never-seen'), false);
  });

  it('onTurnEnd drops the state and is idempotent', async () => {
    const rt = makeRuntime();
    rt._setSessionStateForTests('s1', ensureTurn(null, 's1'));
    await rt.onTurnEnd('s1');
    assert.equal(rt.hasSessionState('s1'), false);
    // Second call must not throw on the now-absent state.
    await rt.onTurnEnd('s1');
    assert.equal(rt.hasSessionState('s1'), false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run build`
Expected: FAIL — `tsc` errors with `Cannot find module '../adapters/plugin-runtime.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/adapters/plugin-runtime.ts`:

```ts
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
   * Test seam: inject pre-built OTEL providers instead of deriving them
   * from collector config. `undefined` means "build from config" (the
   * production path); `null` means "explicitly disabled". Needed because
   * the test harness pins NIO_HOME to an empty tmpdir, so
   * `collector.endpoint` is unset and both factories return null — which
   * would leave every span-emitting code path unexercised.
   */
  tracerProvider?: ReturnType<typeof createTracerProvider>;
  meterProvider?: ReturnType<typeof createMeterProvider>;
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
   * Test seam: seed collector state for a session directly.
   *
   * Production code populates state through `onPreTool` / `onLlmUsage`,
   * which arrive in later tasks. Without this, the session-lifecycle
   * tests can only assert that state fails to materialise out of thin
   * air — they would pass against an empty method body. Named after the
   * existing `_setDiagnosticsAuditPathForTests` convention in
   * src/adapters/diagnostics.ts.
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
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/plugin-runtime.test.js`
Expected: PASS — all tests in the file green.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/plugin-runtime.ts src/tests/plugin-runtime.test.ts
git commit -m "feat(adapters): add InProcessPluginRuntime with session lifecycle

Extracts the platform-agnostic construction and session/turn flush
logic shared by every in-process plugin platform. Platform bindings
translate their own events into these semantic methods and hold no
telemetry logic of their own."
```

---

### Task 2: Runtime tool path — `onPreTool` / `onPostTool`

**Files:**
- Modify: `src/adapters/plugin-runtime.ts`
- Modify: `src/tests/plugin-runtime.test.ts`

**Interfaces:**
- Consumes: `evaluateHook(adapter, rawEvent, { config, nio }, auditOpts)` from `./hook-engine.js`; `genAiToolCallInputAttributes(params, toolCallId)`, `genAiToolCallOutputAttributes({ result, error, durationMs })`, `nioGuardAttributes(decision, riskLevel, riskScore, riskTags, phaseStopped, topFindingRule)`, `recordPreToolUse(state, spanKey, toolName, summary, attrs)`, `setPendingGuardAttrs(state, spanKey, attrs)`, `takePendingGuardAttrs(state, spanKey)`, `ensureTurn(prev, sessionId)` from `../scripts/lib/traces-collector.js`; `toolSummary(toolName, params)` from `../scripts/lib/collector-core.js`; `recordToolUse(provider, toolName, event)`, `recordGuardDecision(provider, decision, riskLevel, riskScore, toolName)` from `../scripts/lib/metrics-collector.js`.
- Produces:
  - `type GuardDecisionTag = 'allow' | 'deny' | 'confirm_allowed' | 'confirm_denied' | 'ask'`
  - `interface PreToolResult { block: boolean; reason?: string; decision: GuardDecisionTag }`
  - `onPreTool(sessionId: string, spanKey: string, toolName: string, params: Record<string, unknown>, rawEvent: unknown, opts?: { toolCallId?: string; extraPreAttrs?: Record<string, unknown> }): Promise<PreToolResult>`
    - `spanKey` correlates pre and post and may fall back to the tool name. `opts.toolCallId` is the platform's REAL call id or `undefined` — never a fallback. Keeping them separate matters: `genAiToolCallInputAttributes` omits `gen_ai.tool.call.id` when the id is falsy, and feeding it `spanKey` would fabricate a non-unique id (`"exec"`) on platforms whose events sometimes lack one, silently mis-grouping calls in the backend.
  - `onPostTool(sessionId: string, spanKey: string, toolName: string, outcome: { result?: unknown; error?: string | null; durationMs?: number }): Promise<void>`
  - `resolveConfirm(sessionId: string, spanKey: string, decision: GuardDecisionTag, reason: string | undefined, confirmed: boolean): Promise<PreToolResult>` — used by Pi after an interactive confirm dialog.
  - `PluginRuntimeOptions` gains optional `tracerProvider` / `meterProvider` overrides (see Task 1) so tests can inject `makeInMemoryTracer()` and exercise the span wiring.

**Semantics that later tasks depend on:**
`onPreTool` returns `decision: 'ask'` **only** when the guard said `confirm` *and* `guard.confirm_action === 'ask'`. In that case `block` is `false` and the binding layer is responsible for either prompting (Pi) or treating it as allow (platforms without an interactive channel). When it prompts, it must call `resolveConfirm` with the user's answer so the span attributes and metrics record `confirm_allowed` / `confirm_denied` rather than the provisional `ask`.

- [ ] **Step 1: Write the failing test**

Append to `src/tests/plugin-runtime.test.ts` (and extend the existing imports at the top of the file to include `PreToolResult`):

```ts
describe('InProcessPluginRuntime tool path', () => {
  /** Stub engine whose verdict the test controls. */
  function runtimeWithVerdict(
    verdict: 'allow' | 'deny' | 'confirm',
    confirmAction?: 'allow' | 'deny' | 'ask',
  ) {
    return new InProcessPluginRuntime({
      platform: 'test-platform',
      adapter: new OpenClawAdapter(),
      ...(confirmAction ? { confirmAction } : {}),
      nioFactory: () => ({
        orchestrator: {
          async evaluate() {
            return {
              decision: verdict,
              risk_level: verdict === 'allow' ? 'low' : 'high',
              scores: { final: verdict === 'allow' ? 0 : 0.9 },
              findings: verdict === 'allow' ? [] : [{ rule_id: 'TEST_RULE' }],
              explanation: 'test verdict',
              phase_stopped: 2,
              diagnostics: [],
            };
          },
        },
      }) as never,
    });
  }

  it('allows and reports decision "allow"', async () => {
    const rt = runtimeWithVerdict('allow');
    const r = await rt.onPreTool('s1', 'call-1', 'exec', { command: 'ls' }, {
      toolName: 'exec', params: { command: 'ls' },
    });
    assert.equal(r.block, false);
    assert.equal(r.decision, 'allow');
  });

  it('blocks and reports decision "deny" with a reason', async () => {
    const rt = runtimeWithVerdict('deny');
    const r = await rt.onPreTool('s1', 'call-1', 'exec', { command: 'rm -rf /' }, {
      toolName: 'exec', params: { command: 'rm -rf /' },
    });
    assert.equal(r.block, true);
    assert.equal(r.decision, 'deny');
    assert.ok(r.reason && r.reason.length > 0);
  });

  it('folds confirm to confirm_denied when confirm_action is deny', async () => {
    const rt = runtimeWithVerdict('confirm', 'deny');
    const r = await rt.onPreTool('s1', 'call-1', 'exec', { command: 'curl x' }, {
      toolName: 'exec', params: { command: 'curl x' },
    });
    assert.equal(r.block, true);
    assert.equal(r.decision, 'confirm_denied');
  });

  it('resolveConfirm maps a user "no" to confirm_denied', async () => {
    const rt = runtimeWithVerdict('confirm');
    const r = await rt.resolveConfirm('s1', 'call-1', 'ask', 'needs confirmation', false);
    assert.equal(r.block, true);
    assert.equal(r.decision, 'confirm_denied');
  });

  it('resolveConfirm maps a user "yes" to confirm_allowed', async () => {
    const rt = runtimeWithVerdict('confirm');
    const r = await rt.resolveConfirm('s1', 'call-1', 'ask', 'needs confirmation', true);
    assert.equal(r.block, false);
    assert.equal(r.decision, 'confirm_allowed');
  });

  it('onPostTool is a no-op when no pre-span was recorded', async () => {
    const rt = runtimeWithVerdict('allow');
    await rt.onPostTool('s-unknown', 'call-x', 'exec', { result: 'ok' });
    assert.equal(rt.hasSessionState('s-unknown'), false);
  });
});

// The tests above run with both OTEL providers null (the harness pins
// NIO_HOME to an empty tmpdir, so collector.endpoint is unset). That
// leaves the span wiring — park guard attrs, drain them exactly once,
// emit an orphan span when a call is blocked — completely unexercised.
// These tests inject an in-memory tracer so that wiring can actually
// fail. `makeInMemoryTracer` is the repo's existing helper, already used
// by src/tests/traces-collector.test.ts.
describe('InProcessPluginRuntime span wiring', () => {
  function runtimeWithTracer(
    verdict: 'allow' | 'deny' | 'confirm',
    tracer: ReturnType<typeof makeInMemoryTracer>,
    confirmAction?: 'allow' | 'deny' | 'ask',
  ) {
    return new InProcessPluginRuntime({
      platform: 'test-platform',
      adapter: new OpenClawAdapter(),
      tracerProvider: tracer.provider,
      meterProvider: null,
      ...(confirmAction ? { confirmAction } : {}),
      nioFactory: () => ({
        orchestrator: {
          async evaluate() {
            return {
              decision: verdict,
              risk_level: verdict === 'allow' ? 'low' : 'high',
              scores: { final: verdict === 'allow' ? 0 : 0.9 },
              findings: verdict === 'allow' ? [] : [{ rule_id: 'TEST_RULE' }],
              explanation: 'test verdict',
              phase_stopped: 2,
              diagnostics: [],
            };
          },
        },
      }) as never,
    });
  }

  const preEvent = (command: string) => ({
    toolName: 'exec', params: { command },
  });

  it('allow path emits one tool span carrying the guard attrs', async () => {
    const tracer = makeInMemoryTracer();
    try {
      const rt = runtimeWithTracer('allow', tracer);
      await rt.onPreTool('s1', 'call-1', 'exec', { command: 'ls' }, preEvent('ls'));
      assert.equal(tracer.finished().length, 0, 'no span before the post side');

      await rt.onPostTool('s1', 'call-1', 'exec', { result: 'ok' });
      const spans = tracer.finished();
      assert.equal(spans.length, 1);
      assert.equal(spans[0]!.attributes['nio.guard.decision'], 'allow');
      assert.equal(typeof spans[0]!.attributes['nio.guard.eval_ms'], 'number');
    } finally {
      await tracer.shutdown();
    }
  });

  it('deny path emits the orphan span immediately and drains attrs once', async () => {
    const tracer = makeInMemoryTracer();
    try {
      const rt = runtimeWithTracer('deny', tracer);
      const r = await rt.onPreTool(
        's1', 'call-1', 'exec', { command: 'rm -rf /' }, preEvent('rm -rf /'),
      );
      assert.equal(r.block, true);

      // The platform's post-side event never fires for a blocked call, so
      // onPreTool must have emitted the span itself.
      const afterBlock = tracer.finished();
      assert.equal(afterBlock.length, 1, 'orphan span emitted on the block path');
      assert.equal(afterBlock[0]!.attributes['nio.guard.decision'], 'deny');

      // A defensive post call must not emit a second span for the same key.
      await rt.onPostTool('s1', 'call-1', 'exec', { result: 'never ran' });
      assert.equal(tracer.finished().length, 1, 'guard attrs drained exactly once');
    } finally {
      await tracer.shutdown();
    }
  });

  it('resolveConfirm("no") closes the span and keeps the earlier guard attrs', async () => {
    const tracer = makeInMemoryTracer();
    try {
      const rt = runtimeWithTracer('confirm', tracer, 'ask');
      const r = await rt.onPreTool(
        's1', 'call-1', 'exec', { command: 'curl x' }, preEvent('curl x'),
      );
      assert.equal(r.decision, 'ask');
      assert.equal(r.block, false);
      assert.equal(tracer.finished().length, 0, 'nothing emitted while awaiting the user');

      const resolved = await rt.resolveConfirm('s1', 'call-1', 'ask', r.reason, false);
      assert.equal(resolved.block, true);

      const spans = tracer.finished();
      assert.equal(spans.length, 1);
      assert.equal(spans[0]!.attributes['nio.guard.decision'], 'confirm_denied');
      // The merge must preserve what onPreTool parked, not replace it.
      assert.equal(typeof spans[0]!.attributes['nio.guard.eval_ms'], 'number');
    } finally {
      await tracer.shutdown();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run build`
Expected: FAIL — `tsc` errors: `Property 'onPreTool' does not exist on type 'InProcessPluginRuntime'`.

- [ ] **Step 3: Write minimal implementation**

Add to the imports in `src/adapters/plugin-runtime.ts`:

```ts
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
```

Add the exported types above the class:

```ts
export type GuardDecisionTag = 'allow' | 'deny' | 'confirm_allowed' | 'confirm_denied' | 'ask';

export interface PreToolResult {
  /** True when the binding layer must stop the tool from running. */
  block: boolean;
  /** Human-readable denial reason; present whenever `block` is true. */
  reason?: string;
  /** User-visible decision taxonomy carried on spans and metrics. */
  decision: GuardDecisionTag;
}
```

Add these members to the class:

```ts
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
      const preAttrs: Record<string, unknown> = {
        // Pass the REAL call id, never spanKey — see the note on the
        // signature. A falsy id makes the builder omit the attribute,
        // which is the honest outcome.
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

    // `ask` is a provisional state for the caller, never a final span
    // tag: the documented taxonomy is {allow, deny, confirm_allowed,
    // confirm_denied}. A platform with an interactive channel overwrites
    // this via resolveConfirm; one without simply lets the tool run,
    // which is exactly `confirm_allowed`.
    const spanDecision: GuardDecisionTag =
      decision === 'ask' ? 'confirm_allowed' : decision;

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
      // The post-side event will never fire because the tool did not run,
      // so flush the orphan span here with guard-error status.
      //
      // NEVER let this throw. A deny is already decided at this point;
      // if the span flush rejected, `onPreTool` would reject, the
      // binding's fail-open catch would swallow it, and the blocked tool
      // would RUN. Telemetry must never veto a guard verdict.
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
      // Same rule as onPreTool: the user already refused, so a telemetry
      // failure must not turn that into an allow.
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

  private stashGuardAttrs(
    sessionId: string,
    spanKey: string,
    attrs: Record<string, unknown>,
  ): void {
    const state = this.sessionState.get(sessionId);
    if (!state) return;
    this.sessionState.set(sessionId, setPendingGuardAttrs(state, spanKey, attrs));
  }

  /**
   * `closeSpan` that cannot reject. Used on every path where a block or a
   * refusal has ALREADY been decided — the span is best-effort, the
   * verdict is not. Swallowing here is what keeps a failing OTEL exporter
   * from silently disabling the guard.
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
      // Best-effort telemetry; the caller's decision stands.
    }
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/plugin-runtime.test.js`
Expected: PASS — the six new tool-path tests plus the five from Task 1.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/plugin-runtime.ts src/tests/plugin-runtime.test.ts
git commit -m "feat(adapters): add runtime tool path with guard decision translation

onPreTool returns a decision instead of deciding how to block, so each
platform binding can use its own blocking shape. Guard attrs are parked
in CollectorState via setPendingGuardAttrs rather than a module-level
side map, and the block path flushes an orphan span because the
post-side event never fires for a blocked call."
```

---

### Task 3: Runtime remaining signals and `/nio` dispatch

**Files:**
- Modify: `src/adapters/plugin-runtime.ts`
- Modify: `src/tests/plugin-runtime.test.ts`

**Interfaces:**
- Consumes: `recordUserPrompt(state, prompt)`, `recordAssistantReply(state, reply)`, `accumulateGenAiUsage(state, delta)`, `recordPreTaskToolUse(state, taskId, summary)`, `recordPostTaskToolUse(provider, state, taskId, cwd)` from `../scripts/lib/traces-collector.js`; `recordTurn(provider)` from `../scripts/lib/metrics-collector.js`; `dispatchNioCommand(raw, { orchestrator, scanner })` from `./openclaw-dispatch.js`.
- Produces: `onUserPrompt(sessionId, text): void`, `onAssistantReply(sessionId, text): void`, `onLlmUsage(sessionId, usage): void`, `onSubagentStart(sessionId, taskId, auditDetails?): Promise<void>`, `onSubagentEnd(sessionId, taskId, auditDetails?): Promise<void>`, `onUserBash(sessionId, command, cwd): void`, `dispatchCommand(rawArgs: string): Promise<string>`.

- [ ] **Step 1: Write the failing test**

Append to `src/tests/plugin-runtime.test.ts`:

```ts
describe('InProcessPluginRuntime auxiliary signals', () => {
  // Tracing explicitly OFF. Do not rely on the harness's empty NIO_HOME
  // producing a null provider — state that implicitly is how Task 2's
  // span wiring went uncovered.
  function makeRuntime() {
    return new InProcessPluginRuntime({
      platform: 'test-platform',
      adapter: new OpenClawAdapter(),
      tracerProvider: null,
      meterProvider: null,
    });
  }

  it('onUserPrompt does not create state when tracing is off', () => {
    // Prompt capture is a tracing-only concern and must short-circuit.
    const rt = makeRuntime();
    rt.onUserPrompt('s2', 'hello');
    assert.equal(rt.hasSessionState('s2'), false);
  });

  it('onLlmUsage always accumulates, even with tracing off', () => {
    // Unlike prompt capture, usage accumulation feeds metrics as well as
    // spans, so it creates turn state unconditionally.
    const rt = makeRuntime();
    rt.onLlmUsage('s2', { input: 10 });
    assert.equal(rt.hasSessionState('s2'), true);
  });

  it('onLlmUsage tolerates an empty usage object', () => {
    const rt = makeRuntime();
    rt.onLlmUsage('s2', {});
    assert.equal(rt.hasSessionState('s2'), true);
  });

  it('onUserBash writes an audit row without throwing', () => {
    const rt = makeRuntime();
    rt.onUserBash('s2', 'ls -la', '/tmp');
  });

  it('onSubagentStart/End are safe when no state exists', async () => {
    const rt = makeRuntime();
    await rt.onSubagentStart('s3', 'task-1');
    await rt.onSubagentEnd('s3', 'task-1');
  });

  it('dispatchCommand routes an empty arg string to the config handler', async () => {
    const rt = makeRuntime();
    const out = await rt.dispatchCommand('');
    assert.equal(typeof out, 'string');
    assert.ok(out.length > 0);
  });
});

// Same lesson as Task 2: with a null provider none of the turn-state
// plumbing runs. These drive a real in-memory tracer so the prompt /
// reply / usage attributes and the sub-agent span can actually fail.
describe('InProcessPluginRuntime auxiliary signals — span wiring', () => {
  function tracedRuntime(tracer: ReturnType<typeof makeInMemoryTracer>) {
    return new InProcessPluginRuntime({
      platform: 'test-platform',
      adapter: new OpenClawAdapter(),
      tracerProvider: tracer.provider,
      meterProvider: null,
    });
  }

  it('carries prompt, reply, and token usage onto the turn root span', async () => {
    const tracer = makeInMemoryTracer();
    try {
      const rt = tracedRuntime(tracer);
      rt.onUserPrompt('s1', 'why is the build red?');
      rt.onAssistantReply('s1', 'a lint rule changed');
      rt.onLlmUsage('s1', { input: 120, output: 45, cacheRead: 30, cacheWrite: 10 });
      rt.onLlmUsage('s1', { input: 80 });   // must accumulate, not overwrite

      await rt.onTurnEnd('s1');

      const spans = tracer.finished();
      assert.equal(spans.length, 1, 'exactly one turn root span');
      const attrs = spans[0]!.attributes;
      assert.equal(attrs['nio.turn.user_prompt'], 'why is the build red?');
      assert.equal(attrs['nio.turn.assistant_reply'], 'a lint rule changed');
      assert.equal(attrs['gen_ai.usage.input_tokens'], 200);   // 120 + 80
      assert.equal(attrs['gen_ai.usage.output_tokens'], 45);
      assert.equal(attrs['gen_ai.usage.cache_read.input_tokens'], 30);
      assert.equal(attrs['gen_ai.usage.cache_creation.input_tokens'], 10);
      assert.equal(rt.hasSessionState('s1'), false, 'state dropped after the flush');
    } finally {
      await tracer.shutdown();
    }
  });

  it('emits a sub-agent span between onSubagentStart and onSubagentEnd', async () => {
    const tracer = makeInMemoryTracer();
    try {
      const rt = tracedRuntime(tracer);
      await rt.onSubagentStart('s1', 'task-1');
      assert.equal(tracer.finished().length, 0, 'nothing emitted while the sub-agent runs');

      await rt.onSubagentEnd('s1', 'task-1');
      assert.equal(tracer.finished().length, 1, 'sub-agent span emitted on end');
    } finally {
      await tracer.shutdown();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run build`
Expected: FAIL — `tsc` errors: `Property 'onUserPrompt' does not exist on type 'InProcessPluginRuntime'`.

- [ ] **Step 3: Write minimal implementation**

Extend the traces-collector import in `src/adapters/plugin-runtime.ts` with `recordUserPrompt`, `recordAssistantReply`, `accumulateGenAiUsage`, `recordPreTaskToolUse`; extend the metrics import with `recordTurn`; and add:

```ts
import { dispatchNioCommand } from './openclaw-dispatch.js';
```

Add these methods to the class:

```ts
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

  /**
   * Sub-agent / Task span open.
   *
   * `auditDetails` lets the binding preserve its platform's own audit
   * payload verbatim (OpenClaw records both `subagent_id` and `run_id`);
   * omit it and the taskId is recorded on its own.
   */
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

  /** Sub-agent / Task span close. See `onSubagentStart` for `auditDetails`. */
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
```

- [ ] **Step 4: Extend the lifecycle union**

`onUserBash` uses a lifecycle type that does not exist yet. In `src/adapters/audit-types.ts`, add `'user_bash'` to the `lifecycle_type` union of `AuditLifecycleEntry`, keeping the existing members intact.

Run: `pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/plugin-runtime.test.js`
Expected: PASS — all tests in the file green.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/plugin-runtime.ts src/adapters/audit-types.ts src/tests/plugin-runtime.test.ts
git commit -m "feat(adapters): add auxiliary runtime signals and /nio dispatch

Adds prompt/reply capture, token usage accumulation, sub-agent spans,
audit-only user_bash recording, and the shared /nio sub-command router."
```

---

### Task 4: Port OpenClaw onto the runtime (regression gate)

**Files:**
- Modify: `src/adapters/openclaw-plugin.ts`
- Modify: `src/adapters/index.ts`
- Create: `src/tests/openclaw-plugin.test.ts` (characterization test — written and green BEFORE the refactor)

**Interfaces:**
- Consumes: everything produced by Tasks 1–3.
- Produces: unchanged public surface — `registerOpenClawPlugin(api, options?)` and the default plugin entry object `{ id: 'nio', name: 'Nio', register(api) }`. `OpenClawPluginOptions` keeps its `{ level?, nioFactory? }` shape.

**This task must be behaviour-neutral.** It is the principal risk of the shared-runtime approach.

- [ ] **Step 1: Capture the pre-refactor baseline**

```bash
pnpm run build && pnpm test 2>&1 | tee /tmp/nio-baseline-before.txt
grep -cE "^# (pass|fail)" /tmp/nio-baseline-before.txt
```

Record the pass/fail counts. Do not proceed if the tree is not already green.

**This baseline is nearly worthless on its own, and you must understand why
before continuing:** `registerOpenClawPlugin` has *zero* unit-test coverage
today. Every existing test that mentions OpenClaw targets `OpenClawAdapter`
or the `/nio` dispatcher, never the plugin registration. A refactor could
rename the block-reason key, drop a span, or swap an event name and the
whole suite would stay green. Steps 1a-1c fix that BEFORE you touch the
implementation.

- [ ] **Step 1a: Make the CURRENT plugin injectable (minimal edit)**

In `src/adapters/openclaw-plugin.ts`, extend the options type and use the
values — nothing else changes yet:

```ts
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
```

and at the provider construction site:

```ts
  const tracerProvider = options.tracerProvider !== undefined
    ? options.tracerProvider
    : createTracerProvider(collectorConfig, 'openclaw', resourceAgentName);
  const meterProvider = options.meterProvider !== undefined
    ? options.meterProvider
    : createMeterProvider(collectorConfig, 'openclaw', resourceAgentName);
```

- [ ] **Step 1b: Write the characterization test against the CURRENT code**

Create `src/tests/openclaw-plugin.test.ts`. This test pins the behaviour the
refactor must preserve. Write it now, against the un-refactored plugin, and
get it green — that is what makes it a characterization test rather than a
restatement of the new code.

```ts
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerOpenClawPlugin } from '../adapters/openclaw-plugin.js';
import { makeInMemoryTracer } from './helpers/tracer.js';

/** Minimal stand-in for OpenClaw's plugin register API. */
function fakeApi() {
  const handlers = new Map<string, (e: unknown, ctx: unknown) => Promise<unknown>>();
  const tools: Array<{ name: string }> = [];
  return {
    handlers,
    tools,
    on(name: string, fn: (e: unknown, ctx: unknown) => Promise<unknown>) {
      handlers.set(name, fn);
    },
    registerTool(def: { name: string }) { tools.push(def); },
  };
}

function stubNio(verdict: 'allow' | 'deny') {
  return () => ({
    orchestrator: {
      async evaluate() {
        return {
          decision: verdict,
          risk_level: verdict === 'allow' ? 'low' : 'high',
          scores: { final: verdict === 'allow' ? 0 : 0.9 },
          findings: verdict === 'allow' ? [] : [{ rule_id: 'TEST_RULE' }],
          explanation: 'characterization verdict',
          phase_stopped: 2,
          diagnostics: [],
        };
      },
    },
  }) as never;
}

const CTX = { sessionKey: 'oc-session-1' };

describe('OpenClaw plugin — characterization', () => {
  it('subscribes to every event the integration relies on', () => {
    const api = fakeApi();
    registerOpenClawPlugin(api as never, {
      nioFactory: stubNio('allow'), tracerProvider: null, meterProvider: null,
    });
    for (const name of [
      'before_tool_call', 'after_tool_call', 'subagent_spawning', 'subagent_ended',
      'before_agent_reply', 'llm_output', 'session_start', 'session_end', 'agent_end',
    ]) {
      assert.ok(api.handlers.has(name), `missing handler: ${name}`);
    }
    assert.deepEqual(api.tools.map(t => t.name), ['nio_command']);
  });

  it('allows a benign call and returns undefined', async () => {
    const api = fakeApi();
    registerOpenClawPlugin(api as never, {
      nioFactory: stubNio('allow'), tracerProvider: null, meterProvider: null,
    });
    const out = await api.handlers.get('before_tool_call')!(
      { toolName: 'exec', params: { command: 'ls' }, toolCallId: 'c1' }, CTX,
    );
    assert.equal(out, undefined);
  });

  it('blocks with { block, blockReason } — NOT { reason }', async () => {
    // OpenClaw reads `blockReason`. Renaming this key silently disables
    // blocking on the whole platform, so pin it explicitly.
    const api = fakeApi();
    registerOpenClawPlugin(api as never, {
      nioFactory: stubNio('deny'), tracerProvider: null, meterProvider: null,
    });
    const out = await api.handlers.get('before_tool_call')!(
      { toolName: 'exec', params: { command: 'rm -rf /' }, toolCallId: 'c1' }, CTX,
    ) as { block?: boolean; blockReason?: string; reason?: string };

    assert.equal(out.block, true);
    assert.equal(typeof out.blockReason, 'string');
    assert.ok(out.blockReason!.length > 0);
    assert.equal(out.reason, undefined, 'must not switch to the Pi-style `reason` key');
  });

  it('fails open: a malformed event never blocks', async () => {
    const api = fakeApi();
    registerOpenClawPlugin(api as never, {
      nioFactory: stubNio('deny'), tracerProvider: null, meterProvider: null,
    });
    const out = await api.handlers.get('before_tool_call')!(null, null);
    assert.equal(out, undefined);
  });

  it('emits one tool span carrying the guard decision', async () => {
    const tracer = makeInMemoryTracer();
    try {
      const api = fakeApi();
      registerOpenClawPlugin(api as never, {
        nioFactory: stubNio('allow'),
        tracerProvider: tracer.provider,
        meterProvider: null,
      });
      await api.handlers.get('before_tool_call')!(
        { toolName: 'exec', params: { command: 'ls' }, toolCallId: 'c1' }, CTX,
      );
      assert.equal(tracer.finished().length, 0);

      await api.handlers.get('after_tool_call')!(
        { toolName: 'exec', toolCallId: 'c1', result: 'ok' }, CTX,
      );
      const spans = tracer.finished();
      assert.equal(spans.length, 1);
      assert.equal(spans[0]!.attributes['nio.guard.decision'], 'allow');
    } finally {
      await tracer.shutdown();
    }
  });

  it('emits the orphan span when a call is blocked', async () => {
    const tracer = makeInMemoryTracer();
    try {
      const api = fakeApi();
      registerOpenClawPlugin(api as never, {
        nioFactory: stubNio('deny'),
        tracerProvider: tracer.provider,
        meterProvider: null,
      });
      await api.handlers.get('before_tool_call')!(
        { toolName: 'exec', params: { command: 'rm -rf /' }, toolCallId: 'c1' }, CTX,
      );
      const spans = tracer.finished();
      assert.equal(spans.length, 1, 'after_tool_call never fires for a blocked call');
      assert.equal(spans[0]!.attributes['nio.guard.decision'], 'deny');
    } finally {
      await tracer.shutdown();
    }
  });

  it('agent_end emits the turn root span with prompt and usage', async () => {
    const tracer = makeInMemoryTracer();
    try {
      const api = fakeApi();
      registerOpenClawPlugin(api as never, {
        nioFactory: stubNio('allow'),
        tracerProvider: tracer.provider,
        meterProvider: null,
      });
      await api.handlers.get('before_agent_reply')!({ cleanedBody: 'hello there' }, CTX);
      await api.handlers.get('llm_output')!(
        { assistantTexts: ['hi'], usage: { input: 10, output: 5 } }, CTX,
      );
      await api.handlers.get('agent_end')!({}, CTX);

      const spans = tracer.finished();
      assert.equal(spans.length, 1);
      assert.equal(spans[0]!.attributes['nio.turn.user_prompt'], 'hello there');
      assert.equal(spans[0]!.attributes['gen_ai.usage.input_tokens'], 10);
    } finally {
      await tracer.shutdown();
    }
  });

  it('subagent_spawning + subagent_ended emit one task span', async () => {
    const tracer = makeInMemoryTracer();
    try {
      const api = fakeApi();
      registerOpenClawPlugin(api as never, {
        nioFactory: stubNio('allow'),
        tracerProvider: tracer.provider,
        meterProvider: null,
      });
      await api.handlers.get('subagent_spawning')!({ subagentId: 'sub-1' }, CTX);
      assert.equal(tracer.finished().length, 0);
      await api.handlers.get('subagent_ended')!({ subagentId: 'sub-1' }, CTX);
      assert.equal(tracer.finished().length, 1);
    } finally {
      await tracer.shutdown();
    }
  });

  it('the nio_command tool returns dispatcher text', async () => {
    const api = fakeApi();
    registerOpenClawPlugin(api as never, {
      nioFactory: stubNio('allow'), tracerProvider: null, meterProvider: null,
    });
    const tool = api.tools[0] as unknown as {
      execute(id: string, p: Record<string, string>): Promise<{ content: Array<{ text: string }> }>;
    };
    const out = await tool.execute('id-1', {
      command: '', commandName: 'nio', skillName: 'nio',
    });
    assert.equal(typeof out.content[0]!.text, 'string');
    assert.ok(out.content[0]!.text.length > 0);
  });
});
```

- [ ] **Step 1c: Prove the characterization test is green BEFORE the refactor**

Run: `pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/openclaw-plugin.test.js`
Expected: PASS against the un-refactored plugin. If any test fails here, the
test encodes an assumption the current code does not hold — fix the TEST,
not the plugin. Commit this step separately:

```bash
git add src/adapters/openclaw-plugin.ts src/tests/openclaw-plugin.test.ts
git commit -m "test(openclaw): characterize plugin behaviour before the runtime port

registerOpenClawPlugin had no unit coverage, so the upcoming refactor had
nothing to regress against. Pins the event subscriptions, the
{ block, blockReason } contract, fail-open on malformed events, the tool
and turn span shapes, sub-agent span pairing, and the nio_command tool.

Also adds tracerProvider/meterProvider injection to OpenClawPluginOptions,
mirroring PluginRuntimeOptions, so the same test keeps working after the
port."
```

- [ ] **Step 2: Rewrite `openclaw-plugin.ts` to delegate**

Replace the body of `registerOpenClawPlugin` so it constructs one runtime and translates events. Delete the module-level `sessionState` and `pendingGuardAttrs` maps and the stale comment block above them (the "no mid-flight span mutation primitive" claim is wrong — `setPendingGuardAttrs` / `takePendingGuardAttrs` exist). Keep the OpenClaw type declarations (`OpenClawRegisterApi`, `OpenClawToolDefinition`, `OpenClawPluginEntry`) as they are.

```ts
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
      await rt.onTurnEnd(sid(ctx));
      await rt.recordTurnMetric();
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
```

Update the imports at the top of the file to `loadConfig`, `OpenClawAdapter`, `InProcessPluginRuntime`, and `nioToolRunIdAttribute`; remove every import that is now unused (the collector functions, `writeAuditLog`, `ActionOrchestrator`, `SkillScanner`, `dispatchNioCommand`, `evaluateHook`, config-loader, provider factories).

- [ ] **Step 3: Add the missing runtime helper**

`recordTurnMetric()` does not exist yet. Add it to `InProcessPluginRuntime` in `src/adapters/plugin-runtime.ts`:

```ts
  /** Increment the per-turn counter. Separate from onTurnEnd so
   *  platforms that flush turns and count turns at different events can
   *  call them independently. */
  async recordTurnMetric(): Promise<void> {
    if (this.meterProvider) await recordTurn(this.meterProvider);
  }
```

- [ ] **Step 4: Export the runtime from the barrel**

In `src/adapters/index.ts`, add:

```ts
export {
  InProcessPluginRuntime,
  type PluginRuntimeOptions,
  type PreToolResult,
  type GuardDecisionTag,
} from './plugin-runtime.js';
```

- [ ] **Step 5: Verify behaviour is unchanged**

The characterization test from Step 1b is the real gate. It must pass
**without a single edit** — if you find yourself changing an assertion to
make it green, you have changed OpenClaw's behaviour and must fix the
implementation instead.

```bash
pnpm run build
node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/openclaw-plugin.test.js
git diff --stat HEAD -- src/tests/openclaw-plugin.test.ts   # must be empty
pnpm test 2>&1 | tee /tmp/nio-baseline-after.txt
diff <(grep -E "^# (pass|fail|tests)" /tmp/nio-baseline-before.txt) \
     <(grep -E "^# (pass|fail|tests)" /tmp/nio-baseline-after.txt)
pnpm typecheck
```

Expected: characterization test green and untouched, the pass/fail counts
differing only by the tests you added, and `pnpm typecheck` clean.

- [ ] **Step 6: Manual e2e regression (human-run, not automatable here)**

`e2e-test/openclaw-trace-e2e-task.md` needs a live OpenClaw gateway and a
reachable OTLP collector, neither of which exists in this environment. Do
NOT fake it and do NOT mark it done.

Instead: confirm the characterization test covers the span-shape claims
that document makes (turn root span with tool spans beneath it,
`nio.guard.*` present on both allow and deny spans), and state plainly in
your report that the live-gateway run remains outstanding and who has to
run it. The coordinator surfaces it to the human partner.

- [ ] **Step 7: Commit**

```bash
git add src/adapters/openclaw-plugin.ts src/adapters/plugin-runtime.ts src/adapters/index.ts
git commit -m "refactor(openclaw): port plugin onto InProcessPluginRuntime

Behaviour-neutral: the plugin now only translates OpenClaw event shapes
into runtime calls. Drops the module-level pendingGuardAttrs side map in
favour of setPendingGuardAttrs/takePendingGuardAttrs on CollectorState,
which have existed in traces-collector all along."
```

---

## Phase B — Pi

### Task 5: `PiAdapter`

**Files:**
- Create: `src/adapters/pi.ts`
- Create: `src/tests/fixtures/pi/tool-call-bash.json`
- Create: `src/tests/fixtures/pi/tool-call-write.json`
- Create: `src/tests/fixtures/pi/tool-call-edit.json`
- Create: `src/tests/fixtures/pi/tool-result-bash.json`
- Create: `src/tests/fixtures/pi/README.md`
- Modify: `src/tests/adapter.test.ts`
- Modify: `src/tests/integration.test.ts`
- Modify: `src/adapters/index.ts`
- Modify: `src/core/shared/detection-data.ts`
- Modify: `plugins/shared/config.default.yaml`
- Modify: `plugins/shared/config.schema.json`

**Interfaces:**
- Consumes: `HookAdapter`, `HookInput` from `./types.js`; `ActionEnvelope` and friends from `../types/action.js`.
- Produces: `export class PiAdapter implements HookAdapter` with `readonly name = 'pi'`, and `export interface PiAdapterOptions { nativeToolMapping?: Record<string, string> }`.

**Pi event shape** (from `packages/coding-agent/docs/extensions.md`): a `tool_call` event is `{ toolName: string, toolCallId: string, input: Record<string, unknown> }`. Note the parameter field is `input`, **not** `params` — this is the main difference from OpenClaw.

- [ ] **Step 1: Write the fixtures**

`src/tests/fixtures/pi/tool-call-bash.json`:

```json
{
  "toolName": "bash",
  "toolCallId": "call_01H8XKQ",
  "input": { "command": "ls /etc | head -5" }
}
```

`src/tests/fixtures/pi/tool-call-write.json`:

```json
{
  "toolName": "write",
  "toolCallId": "call_01H8XKR",
  "input": { "path": "/tmp/demo.txt", "content": "hello" }
}
```

`src/tests/fixtures/pi/tool-call-edit.json`:

```json
{
  "toolName": "edit",
  "toolCallId": "call_01H8XKS",
  "input": { "path": "/tmp/demo.txt", "oldText": "hello", "newText": "goodbye" }
}
```

`src/tests/fixtures/pi/tool-result-bash.json` (consumed by the Pi binding task, not by this task's tests):

```json
{
  "toolName": "bash",
  "toolCallId": "call_01H8XKQ",
  "input": { "command": "ls /etc | head -5" },
  "content": [{ "type": "text", "text": "afpovertcp.cfg\naliases\n" }],
  "isError": false
}
```

`src/tests/fixtures/pi/README.md`:

```markdown
# Pi fixtures

Event payloads matching the shapes documented in
`earendil-works/pi` → `packages/coding-agent/docs/extensions.md`
("Tool Events"). Pi passes tool parameters as `input`, not `params`.
```

- [ ] **Step 2: Write the failing test**

Add to `src/tests/adapter.test.ts` — first extend the import block with `import { PiAdapter } from '../adapters/pi.js';`, then append:

```ts
// ─────────────────────────────────────────────────────────────────────────────
// PiAdapter
// ─────────────────────────────────────────────────────────────────────────────

describe('PiAdapter', () => {
  const adapter = new PiAdapter();
  const piFixture = (name: string) =>
    JSON.parse(readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pi', name), 'utf-8',
    ));

  it('should have name "pi"', () => {
    assert.equal(adapter.name, 'pi');
  });

  describe('parseInput', () => {
    it('reads tool parameters from `input`, not `params`', () => {
      const parsed = adapter.parseInput(piFixture('tool-call-bash.json'));
      assert.equal(parsed.toolName, 'bash');
      assert.equal(parsed.eventType, 'pre');
      assert.deepEqual(parsed.toolInput, { command: 'ls /etc | head -5' });
    });

    it('handles missing fields gracefully', () => {
      const parsed = adapter.parseInput({});
      assert.equal(parsed.toolName, '');
      assert.deepEqual(parsed.toolInput, {});
      assert.equal(parsed.eventType, 'pre');
    });
  });

  describe('mapToolToActionType', () => {
    it('maps Pi built-in tools', () => {
      assert.equal(adapter.mapToolToActionType('bash'), 'exec_command');
      assert.equal(adapter.mapToolToActionType('write'), 'write_file');
      assert.equal(adapter.mapToolToActionType('edit'), 'write_file');
      assert.equal(adapter.mapToolToActionType('read'), 'read_file');
    });

    it('returns null for Pi tools with no action mapping', () => {
      // Pi core ships bash/read/write/edit/ls/find/grep and no network tool.
      assert.equal(adapter.mapToolToActionType('ls'), null);
      assert.equal(adapter.mapToolToActionType('find'), null);
      assert.equal(adapter.mapToolToActionType('grep'), null);
      assert.equal(adapter.mapToolToActionType('webfetch'), null);
    });
  });

  describe('buildEnvelope', () => {
    it('builds an exec_command envelope from a bash call', () => {
      const env = adapter.buildEnvelope(adapter.parseInput(piFixture('tool-call-bash.json')));
      assert.ok(env);
      assert.equal(env.action.type, 'exec_command');
      assert.equal((env.action.data as { command: string }).command, 'ls /etc | head -5');
    });

    it('builds a write_file envelope carrying a content preview', () => {
      const env = adapter.buildEnvelope(adapter.parseInput(piFixture('tool-call-write.json')));
      assert.ok(env);
      assert.equal(env.action.type, 'write_file');
      assert.equal((env.action.data as { path: string }).path, '/tmp/demo.txt');
      assert.equal((env.action.data as { content_preview: string }).content_preview, 'hello');
    });

    it('reads the edit tool body from newText, not content', () => {
      // Pi's write tool uses `content`; its edit tool uses `newText`.
      // Without this the edit branch silently produces an empty preview
      // and Phase 3 scans nothing.
      const env = adapter.buildEnvelope(adapter.parseInput(piFixture('tool-call-edit.json')));
      assert.ok(env);
      assert.equal(env.action.type, 'write_file');
      assert.equal((env.action.data as { path: string }).path, '/tmp/demo.txt');
      assert.equal((env.action.data as { content_preview: string }).content_preview, 'goodbye');
    });

    it('builds a read_file envelope carrying the path', () => {
      const env = adapter.buildEnvelope(
        adapter.parseInput({ toolName: 'read', input: { path: '/etc/passwd' } }),
      );
      assert.ok(env);
      assert.equal(env.action.type, 'read_file');
      assert.equal((env.action.data as { path: string }).path, '/etc/passwd');
    });

    it('returns null for an unmapped tool', () => {
      assert.equal(adapter.buildEnvelope(adapter.parseInput({ toolName: 'ls', input: {} })), null);
    });
  });

  describe('custom native_tool_mapping', () => {
    it('honours a config-provided mapping', () => {
      const custom = new PiAdapter({ nativeToolMapping: { my_fetch: 'network_request' } });
      assert.equal(custom.mapToolToActionType('my_fetch'), 'network_request');
      assert.equal(custom.mapToolToActionType('bash'), null);
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm run build`
Expected: FAIL — `Cannot find module '../adapters/pi.js'`.

- [ ] **Step 4: Write the implementation**

Create `src/adapters/pi.ts`:

```ts
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import type {
  ActionEnvelope, ActionData, ActionType,
  ExecCommandData, FileOperationData, NetworkRequestData,
} from '../types/action.js';
import type { HookAdapter, HookInput } from './types.js';

/**
 * Default native-tool → action-type mapping for Pi.
 *
 * Pi core ships exactly seven built-in tools — bash, read, write, edit,
 * ls, find, grep (see packages/coding-agent/src/core/tools/*.ts) — and
 * has NO network tool. Network access happens through `bash` and is
 * covered by the Phase 1-6 command analysis. `ls` / `find` / `grep` are
 * deliberately unmapped: they are directory metadata reads, not file
 * content reads, and mapping them would flood the audit log without
 * adding signal.
 */
const DEFAULT_NATIVE_TOOL_MAPPING: Record<string, ActionType> = {
  bash: 'exec_command',
  write: 'write_file',
  edit: 'write_file',
  read: 'read_file',
};

export interface PiAdapterOptions {
  /** Config-driven tool → action type mapping, overrides the built-in default. */
  nativeToolMapping?: Record<string, string>;
}

/**
 * Pi extension adapter.
 *
 * Bridges Pi's `tool_call` / `tool_result` extension events to the
 * common Nio decision engine. Pi passes tool parameters as `input`
 * (mutable in place) rather than OpenClaw's `params`.
 *
 * Blocking is done by returning `{ block: true, reason }` from the
 * `tool_call` handler — see src/adapters/pi-plugin.ts.
 */
export class PiAdapter implements HookAdapter {
  readonly name = 'pi';
  private nativeToolMapping: Record<string, ActionType>;

  constructor(opts?: PiAdapterOptions) {
    this.nativeToolMapping =
      (opts?.nativeToolMapping as Record<string, ActionType>) ?? DEFAULT_NATIVE_TOOL_MAPPING;
  }

  parseInput(raw: unknown): HookInput {
    const event = (raw ?? {}) as Record<string, unknown>;
    return {
      toolName: (event.toolName as string) || '',
      toolInput: (event.input as Record<string, unknown>) || {},
      eventType: 'pre',
      sessionId: event.sessionId as string | undefined,
      cwd: event.cwd as string | undefined,
      raw: event,
    };
  }

  mapToolToActionType(toolName: string): string | null {
    return this.nativeToolMapping[toolName] || null;
  }

  buildEnvelope(input: HookInput, initiatingSkill?: string | null): ActionEnvelope | null {
    const actionType = this.mapToolToActionType(input.toolName) as ActionType | null;
    if (!actionType) return null;

    const actor = {
      skill: {
        id: initiatingSkill || 'pi-session',
        source: initiatingSkill || 'pi',
        version_ref: '0.0.0',
        artifact_hash: '',
      },
    };

    const context = {
      session_id: input.sessionId || `pi-${Date.now()}`,
      user_present: true,
      env: 'prod' as const,
      time: new Date().toISOString(),
      initiating_skill: initiatingSkill || undefined,
    };

    let actionData: ActionData;

    switch (actionType) {
      case 'exec_command': {
        const data: ExecCommandData = {
          command: (input.toolInput.command as string) || '',
          args: [],
          cwd: input.cwd,
        };
        actionData = data;
        break;
      }

      case 'write_file': {
        // Pi's write tool uses `content`; its edit tool uses
        // `newText` for the replacement body.
        const content =
          (input.toolInput.content as string) ||
          (input.toolInput.newText as string) || '';
        const data: FileOperationData = {
          path: (input.toolInput.path as string) || '',
          content_preview: content.slice(0, 10_000),
        };
        actionData = data;
        break;
      }

      case 'read_file': {
        const data: FileOperationData = {
          path: (input.toolInput.path as string) || '',
        };
        actionData = data;
        break;
      }

      case 'network_request': {
        const data: NetworkRequestData = {
          method: (input.toolInput.method as string) || 'GET',
          url: (input.toolInput.url as string) || '',
          body_preview: input.toolInput.body as string | undefined,
        };
        actionData = data;
        break;
      }

      default:
        return null;
    }

    return { actor, action: { type: actionType, data: actionData }, context };
  }

  /**
   * Pi exposes skills as `/skill:name` commands and does not surface the
   * initiating skill on tool events. Returning null keeps the audit row
   * honest rather than guessing.
   */
  async inferInitiatingSkill(_input: HookInput): Promise<string | null> {
    return null;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/adapter.test.js`
Expected: PASS.

- [ ] **Step 6: Wire config defaults, barrel export, and sensitive paths**

In `src/adapters/index.ts` add:

```ts
export { PiAdapter, type PiAdapterOptions } from './pi.js';
```

In `plugins/shared/config.default.yaml`, inside `guard.native_tool_mapping`, after the `hermes:` block, add:

```yaml
    pi:
      bash: exec_command
      write: write_file
      edit: write_file
      read: read_file
```

`permitted_tools` and `blocked_tools` enumerate their platform keys explicitly (`config.default.yaml:265-277`), so add a `pi: []` row to **both** lists, after the `codex: []` row and before `mcp: []`:

```yaml
  permitted_tools:
    claude_code: []
    openclaw: []
    hermes: []
    codex: []
    pi: []
    mcp: []
  blocked_tools:
    claude_code: []
    openclaw: []
    hermes: []
    codex: []
    pi: []
    mcp: []
```

Mirror the `native_tool_mapping` addition into the example/description in `plugins/shared/config.schema.json`.

In `src/core/shared/detection-data.ts`, add these entries alongside the existing `.hermes/` and `.openclaw/` sensitive paths, so an agent cannot rewrite its own guard configuration (these control which extensions load and which skills are trusted — Pi has no MCP, so do not describe them as MCP config):

```ts
  '.pi/settings.json',
  '.pi/agent/settings.json',
  '.pi/',
```

**These entries need a regression test, or nothing catches a future change to
path matching that silently stops protecting them.** `src/tests/integration.test.ts`
already has the right pattern — a data-driven loop in
`describe('Integration: MCP config & persistence write protection (groups X, Y)')`
that asserts a `Write` to each path is denied. Add Pi's settings path to that
array:

```ts
  for (const path of [
    '/Users/test/.claude.json',
    '/Users/test/.claude/mcp.json',
    '/Users/test/Library/Application Support/Claude/claude_desktop_config.json',
    '/Users/test/.hermes/config.yaml',
    '/Users/test/.openclaw/openclaw.json',
    '/Users/test/.pi/agent/settings.json',
  ]) {
```

The surrounding `it(...)` body and assertions are already written — you are only
extending the array. Note the loop's test name derives from the path, so the new
case names itself.

- [ ] **Step 7: Sync and verify**

Run: `node scripts/sync-shared.js && pnpm run build && pnpm test`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/adapters/pi.ts src/adapters/index.ts src/tests/fixtures/pi \
        src/tests/adapter.test.ts src/core/shared/detection-data.ts \
        plugins/shared/config.default.yaml plugins/shared/config.schema.json plugins/
git commit -m "feat(pi): add PiAdapter with verified built-in tool mapping

Pi core ships bash/read/write/edit/ls/find/grep and no network tool, so
the default mapping covers exec/write/read only; network access flows
through bash and is caught by Phase 1-6 command analysis. Pi passes tool
parameters as \`input\`, not \`params\`."
```

---

### Task 6: Pi extension binding

**Files:**
- Create: `src/adapters/pi-plugin.ts`
- Modify: `src/adapters/index.ts`
- Modify: `src/tests/plugin-runtime.test.ts`

**Interfaces:**
- Consumes: `InProcessPluginRuntime`, `PiAdapter`, `loadConfig`.
- Produces: `export function registerPiExtension(pi: PiExtensionApi, options?: PiPluginOptions): void` and a default export `export default function (pi: PiExtensionApi) { registerPiExtension(pi); }` — the shape Pi's loader expects.
- `PiPluginOptions` = `{ level?: string; nioFactory?: () => NioInstance }`.

**Type strategy:** Pi's own packages are declared as local structural interfaces rather than imported, so the bundle carries zero external runtime dependencies. Pi's runtime helpers (`isToolCallEventType`, `createLocalBashOperations`) are deliberately not used.

- [ ] **Step 1: Write the failing test**

Append to `src/tests/plugin-runtime.test.ts`:

```ts
describe('registerPiExtension', () => {
  /** Minimal stand-in for Pi's ExtensionAPI. */
  function fakePi() {
    const handlers = new Map<string, (e: unknown, ctx: unknown) => Promise<unknown>>();
    const commands: string[] = [];
    return {
      handlers,
      commands,
      on(name: string, fn: (e: unknown, ctx: unknown) => Promise<unknown>) {
        handlers.set(name, fn);
      },
      registerCommand(name: string) { commands.push(name); },
      registerTool() { /* unused */ },
    };
  }

  function fakeCtx(hasUI: boolean, confirmAnswer = true) {
    return {
      hasUI,
      cwd: '/tmp',
      ui: {
        async confirm() { return confirmAnswer; },
        notify() { /* no-op */ },
      },
      sessionManager: { getSessionId: () => 'pi-session-1' },
    };
  }

  it('subscribes to every event Nio needs', async () => {
    const { registerPiExtension } = await import('../adapters/pi-plugin.js');
    const pi = fakePi();
    registerPiExtension(pi as never);
    for (const name of [
      'tool_call', 'tool_result', 'input', 'session_start', 'session_shutdown',
      'agent_end', 'message_end', 'user_bash', 'resources_discover',
    ]) {
      assert.ok(pi.handlers.has(name), `missing handler: ${name}`);
    }
  });

  it('registers the /nio command', async () => {
    const { registerPiExtension } = await import('../adapters/pi-plugin.js');
    const pi = fakePi();
    registerPiExtension(pi as never);
    assert.ok(pi.commands.includes('nio'));
  });

  it('tool_call fails open when the handler throws internally', async () => {
    const { registerPiExtension } = await import('../adapters/pi-plugin.js');
    const pi = fakePi();
    registerPiExtension(pi as never);
    const handler = pi.handlers.get('tool_call')!;
    // A ctx with no sessionManager makes the internal session-id lookup throw.
    const out = await handler({ toolName: 'bash', input: { command: 'ls' } }, null);
    assert.equal(out, undefined);
  });

  it('user_bash never blocks AND never consults the guard', async () => {
    // Asserting only "returns undefined" would pass for a binding that ran
    // Phase 0-6 and threw the verdict away. Prove the orchestrator was
    // never consulted.
    const { registerPiExtension } = await import('../adapters/pi-plugin.js');
    let evaluated = false;
    const pi = fakePi();
    registerPiExtension(pi as never, {
      tracerProvider: null,
      meterProvider: null,
      nioFactory: () => ({
        orchestrator: {
          async evaluate() {
            evaluated = true;
            return {
              decision: 'deny', risk_level: 'high', scores: { final: 1 },
              findings: [], explanation: 'x', phase_stopped: 1, diagnostics: [],
            };
          },
        },
      }) as never,
    });
    const out = await pi.handlers.get('user_bash')!(
      { command: 'rm -rf /', cwd: '/tmp' }, fakeCtx(true),
    );
    assert.equal(out, undefined);
    assert.equal(evaluated, false, 'user_bash must not run Phase 0-6');
  });

  it('a refusal survives a telemetry failure', async () => {
    // The blanket catch must not convert a human "no" into an allow. Inject
    // a tracer provider whose getTracer throws, so resolveConfirm blows up
    // AFTER the user has already declined.
    const { registerPiExtension } = await import('../adapters/pi-plugin.js');
    const explodingProvider = {
      getTracer() { throw new Error('boom'); },
      async forceFlush() {},
      async shutdown() {},
    };
    const pi = fakePi();
    registerPiExtension(pi as never, {
      confirmAction: 'ask',
      tracerProvider: explodingProvider as never,
      meterProvider: null,
      nioFactory: () => ({
        orchestrator: {
          async evaluate() {
            return {
              decision: 'confirm', risk_level: 'high', scores: { final: 0.9 },
              findings: [{ rule_id: 'TEST_RULE' }], explanation: 'risky',
              phase_stopped: 2, diagnostics: [],
            };
          },
        },
      }) as never,
    });
    const out = await pi.handlers.get('tool_call')!(
      { toolName: 'bash', toolCallId: 'c1', input: { command: 'rm -rf /' } },
      fakeCtx(true, false),   // hasUI true, user answers "no"
    ) as { block?: boolean };
    assert.equal(out?.block, true, 'a refused action must stay blocked');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run build`
Expected: FAIL — `Cannot find module '../adapters/pi-plugin.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/adapters/pi-plugin.ts`:

```ts
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
  sessionManager: { getSessionId(): string };
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
  confirmAction?: 'allow' | 'deny' | 'ask';
  nioFactory?: () => NioInstance;
  /**
   * Test seam mirroring OpenClawPluginOptions: inject pre-built OTEL
   * providers instead of deriving them from collector config.
   * `undefined` builds from config (production); `null` disables.
   */
  tracerProvider?: ReturnType<typeof createTracerProvider>;
  meterProvider?: ReturnType<typeof createMeterProvider>;
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
    nioFactory: options.nioFactory,
  });

  const sid = (ctx: unknown): string =>
    (ctx as PiContext).sessionManager.getSessionId();

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
    try { rt.onSessionStart(sid(ctx)); } catch { /* non-critical */ }
  });

  pi.on('session_shutdown', async (_event: unknown, ctx: unknown) => {
    try { await rt.onSessionEnd(sid(ctx)); } catch { /* non-critical */ }
  });

  pi.on('agent_end', async (_event: unknown, ctx: unknown) => {
    try {
      const sessionId = sid(ctx);
      await rt.onTurnEnd(sessionId);
      await rt.recordTurnMetric();
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
      const text = await rt.dispatchCommand(args ?? '');
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/plugin-runtime.test.js`
Expected: PASS.

- [ ] **Step 5: Export from the barrel**

In `src/adapters/index.ts` add:

```ts
export { registerPiExtension, type PiPluginOptions, type PiExtensionApi } from './pi-plugin.js';
```

- [ ] **Step 6: Commit**

```bash
git add src/adapters/pi-plugin.ts src/adapters/index.ts src/tests/plugin-runtime.test.ts
git commit -m "feat(pi): add Pi extension binding

Subscribes tool_call (blocking), tool_result, input, session_start,
session_shutdown, agent_end, message_end, and user_bash; registers /nio
as a real slash command that bypasses the LLM. Pi is the only platform
with a user channel, so guard 'confirm' opens a real ctx.ui.confirm
dialog with a timeout so the agent can never hang."
```

---

### Task 7: Pi packaging, installer, and pipeline

**Files:**
- Create: `plugins/pi/package.json`
- Create: `plugins/pi/setup.sh`
- Modify: `scripts/build.js`
- Modify: `scripts/sync-shared.js`
- Modify: `scripts/release.js`
- Modify: `scripts/sync-versions.js`
- Modify: `package.json`
- Modify: `src/adapters/openclaw-dispatch.ts`

**Interfaces:**
- Consumes: the bundled output of `src/adapters/pi-plugin.ts`.
- Produces: `plugins/pi/extensions/nio/index.js` (generated bundle), `plugins/pi/skills/**` (generated by sync-shared), and a `pnpm release:pi` target producing `releases/nio-pi-v<version>.zip`.

- [ ] **Step 1: Write the pi package manifest**

Create `plugins/pi/package.json`:

```json
{
  "name": "nio-pi",
  "version": "2.5.1",
  "description": "Execution assurance and observability for autonomous AI agents — real-time evaluation of every agent action before it executes, with full OpenTelemetry telemetry capture.",
  "license": "Apache-2.0",
  "type": "module",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions/nio/index.js"],
    "skills": ["./skills"]
  }
}
```

The `version` is kept in sync by `scripts/sync-versions.js` (Step 5).

- [ ] **Step 2: Add the bundle target**

In `scripts/build.js`, after the OpenClaw build block, add:

```js
// Pi extension bundle. Single non-split bundle so a Pi-only release zip
// is a self-contained pi package with no shared-chunk dependencies.
// NOTE: no writeEsmSentinel() for plugins/pi/ — that dir has a real
// package.json (the pi package manifest, which already declares
// "type": "module") that sync-versions.js maintains.
const PI_EXT_DIR = join(ROOT, 'plugins/pi/extensions/nio');
const pi = await Bun.build({
  ...shared,
  entrypoints: [join(ROOT, 'dist/adapters/pi-plugin.js')],
  outdir: PI_EXT_DIR,
  naming: { entry: 'index.js' },
  splitting: false,
});

if (!pi.success) {
  console.error(pi.logs);
  process.exit(1);
}
```

Add `${pi.outputs.length} Pi output(s)` to the final `console.log` summary line.

- [ ] **Step 3: Add Pi to the skill sync**

In `scripts/sync-shared.js`, add `join(ROOT, 'plugins', 'pi')` to **both** `SKILL_PLUGIN_DIRS` and `FOCUSED_SKILL_PLUGIN_DIRS`, and update the comment above `FOCUSED_SKILL_PLUGIN_DIRS` to read:

```js
// Focused per-capability skills (nio-scan, nio-action, nio-report, nio-config,
// nio-doctor, nio-external-score) live under plugins/shared/skills/<name>/ and
// are synced to every platform that implements the Agent Skills standard with
// natural-language discovery: Claude Code, Codex, Pi, and opencode. OpenClaw
// (tool-dispatch via the single nio_command tool) and Hermes (nio-cli.js) keep
// using the unified /nio, so we deliberately do NOT sync the focused skills there.
```

- [ ] **Step 4: Add the release target**

In `scripts/release.js`:
- Add `'pi'` to the `includes([...])` validation array and to the usage string.
- Add `'pi'` to the `target === 'all'` target list.
- Add the case:

```js
    case 'pi':
      zipFromDir(name, 'plugins/pi');
      break;
```

- Add a line to the header comment block: `  pi.zip          → package.json, extensions/, skills/, setup.sh, ...`

In root `package.json` `scripts`, add:

```json
    "release:pi": "node scripts/release.js pi",
```

- [ ] **Step 5: Add the manifest to version sync**

In `scripts/sync-versions.js`, add `plugins/pi/package.json` to the list of manifests whose `version` field tracks the root `package.json`.

- [ ] **Step 6: Write the installer**

Create `plugins/pi/setup.sh` (mode 0755). It mirrors the Claude Code / Codex pattern: idempotent, prefers the platform's native registration, falls back to direct writes, supports `--uninstall` / `--config` / `--reset-to-defaults`.

```bash
#!/usr/bin/env bash
set -euo pipefail

# Nio — Pi extension setup
# Installs the Nio extension + skills for the Pi coding agent.
#
# Preferred path: `pi install "$SCRIPT_DIR"` — the release zip IS a valid
# pi package (package.json carries the `pi` manifest key and the
# pi-package keyword), so Pi records it in ~/.pi/agent/settings.json and
# can manage it with `pi update` / `pi remove`.
#
# Fallback path (no `pi` CLI on PATH): copy the bundle into
# ~/.pi/agent/extensions/nio/ and append its absolute path to the
# `extensions` array in settings.json. The documented settings form
# accepts an explicit file or directory path, which avoids depending on
# `index.js` auto-discovery (the documented auto-discovery table only
# names *.ts and */index.ts).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NIO_DIR="${NIO_HOME:-$HOME/.nio}"
MIN_NODE_VERSION=18

UNINSTALL=0
RESET_CONFIG=0
PI_HOME_ARG=""
CONFIG_FILE_ARG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall|uninstall) UNINSTALL=1; shift ;;
    --reset-to-defaults)   RESET_CONFIG=1; shift ;;
    --pi-home)             PI_HOME_ARG="${2:-}"; shift 2 ;;
    --pi-home=*)           PI_HOME_ARG="${1#*=}"; shift ;;
    --config)              CONFIG_FILE_ARG="${2:-}"; shift 2 ;;
    --config=*)            CONFIG_FILE_ARG="${1#*=}"; shift ;;
    -h|--help)
      echo "Usage: $(basename "$0") [--pi-home <path>] [--config <path>] [--reset-to-defaults] [--uninstall]"
      echo ""
      echo "  --pi-home <path>      Path to the pi agent dir. Exported as"
      echo "                        PI_CODING_AGENT_DIR so the pi CLI honours it."
      echo "                        Defaults to \$PI_CODING_AGENT_DIR, then \$HOME/.pi/agent."
      echo "  --config <path>       Apply an operator-provided ~/.nio/config.yaml."
      echo "                        Runs /nio doctor against the file and aborts the"
      echo "                        install if any probe fails."
      echo "  --reset-to-defaults   Overwrite existing nio config with bundled defaults."
      echo "  --uninstall           Remove the extension, skills, and config."
      exit 0 ;;
    *) echo "  ERROR: Unknown option: $1"; echo "  Run with --help for usage."; exit 1 ;;
  esac
done

NIO_CONFIG="${CONFIG_FILE_ARG:-${NIO_CONFIG:-}}"
if [ -n "$NIO_CONFIG" ]; then
  if [ ! -f "$NIO_CONFIG" ]; then
    echo "  ERROR: --config file not found: $NIO_CONFIG" >&2; exit 1
  fi
  NIO_CONFIG="$(cd "$(dirname "$NIO_CONFIG")" && pwd)/$(basename "$NIO_CONFIG")"
fi
if [ "$RESET_CONFIG" -eq 1 ] && [ -n "$NIO_CONFIG" ]; then
  echo "  ERROR: --config and --reset-to-defaults are mutually exclusive." >&2; exit 1
fi
if [ "$UNINSTALL" -eq 1 ] && [ -n "$NIO_CONFIG" ]; then
  echo "  ERROR: --config and --uninstall are mutually exclusive." >&2; exit 1
fi

# Resolution order mirrors plugins/openclaw/setup.sh:
#   --pi-home > $PI_CODING_AGENT_DIR > $HOME/.pi/agent
# PI_CODING_AGENT_DIR is Pi's own documented override for its config
# directory (docs/environment-variables.md).
if [ -n "$PI_HOME_ARG" ]; then
  PI_HOME="$PI_HOME_ARG"
elif [ -n "${PI_CODING_AGENT_DIR:-}" ]; then
  PI_HOME="$PI_CODING_AGENT_DIR"
else
  PI_HOME="$HOME/.pi/agent"
fi

# CRITICAL: export it so the `pi` CLI we shell out to below writes into the
# home we resolved, not the user's real one. Without this, `pi install`
# silently ignores --pi-home and edits ~/.pi/agent/settings.json — that is
# not hypothetical, it happened during development. Same shape as
# OpenClaw's `export OPENCLAW_STATE_DIR`.
export PI_CODING_AGENT_DIR="$PI_HOME"

SETTINGS="$PI_HOME/settings.json"
EXT_DIR="$PI_HOME/extensions/nio"
SKILLS_DIR="$PI_HOME/skills"

echo ""
echo "  Nio — Pi Extension Setup"
echo "  ============================================="
echo "  Pi home: $PI_HOME"
echo ""

if ! command -v node &>/dev/null; then
  echo "  ERROR: Node.js is not installed. Nio requires Node.js >= $MIN_NODE_VERSION."
  exit 1
fi
NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt "$MIN_NODE_VERSION" ]; then
  echo "  ERROR: Node.js v$(node -v) is too old. Nio requires >= $MIN_NODE_VERSION."
  exit 1
fi

# Idempotent settings.json editing. Removes our entries first, then
# re-adds them, so re-running never duplicates.
settings_edit() {
  local mode="$1" ext_path="$2"
  node -e '
    const fs = require("fs"), path = require("path");
    const [file, mode, extPath] = process.argv.slice(1);
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    const strip = (arr) => (Array.isArray(arr) ? arr : [])
      .filter((e) => {
        const s = typeof e === "string" ? e : e && e.source;
        return typeof s !== "string" || !s.includes("/nio");
      });
    cfg.extensions = strip(cfg.extensions);
    cfg.skills = strip(cfg.skills);
    if (mode === "install") {
      cfg.extensions.push(extPath);
      cfg.skills.push(path.join(path.dirname(path.dirname(extPath)), "skills"));
    }
    if (cfg.extensions.length === 0) delete cfg.extensions;
    if (cfg.skills.length === 0) delete cfg.skills;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  ' "$SETTINGS" "$mode" "$ext_path"
}

if [ "$UNINSTALL" -eq 1 ]; then
  echo "  Uninstalling Nio (Pi)..."
  if command -v pi >/dev/null 2>&1; then
    pi remove "$SCRIPT_DIR" >/dev/null 2>&1 && echo "  Removed pi package" || true
  fi
  [ -f "$SETTINGS" ] && settings_edit uninstall "" && echo "  Cleaned settings.json" || true
  rm -rf "$EXT_DIR" 2>/dev/null && echo "  Removed extension" || true
  rm -rf "$SKILLS_DIR/nio" 2>/dev/null && echo "  Removed skill" || true
  for s in nio-scan nio-action nio-report nio-config nio-doctor nio-external-score; do
    rm -rf "${SKILLS_DIR:?}/$s" 2>/dev/null || true
  done
  rm -rf "$NIO_DIR" 2>/dev/null && echo "  Removed config" || true
  echo ""
  echo "  Nio has been uninstalled."
  echo ""
  exit 0
fi

echo "[1/3] Registering extension..."
if command -v pi >/dev/null 2>&1; then
  pi install "$SCRIPT_DIR"
  echo "  OK: Registered as a pi package"
else
  echo "  WARN: 'pi' CLI not found — falling back to a direct install."
  rm -rf "$EXT_DIR"
  mkdir -p "$EXT_DIR"
  cp "$SCRIPT_DIR/extensions/nio/index.js" "$EXT_DIR/index.js"
  mkdir -p "$SKILLS_DIR"
  for s in nio nio-scan nio-action nio-report nio-config nio-doctor nio-external-score; do
    if [ -d "$SCRIPT_DIR/skills/$s" ]; then
      rm -rf "${SKILLS_DIR:?}/$s"
      cp -r "$SCRIPT_DIR/skills/$s" "$SKILLS_DIR/$s"
    fi
  done
  settings_edit install "$EXT_DIR/index.js"
  echo "  OK: Extension installed to $EXT_DIR"
fi

echo "[2/3] Verifying skills..."
if command -v pi >/dev/null 2>&1; then
  echo "  OK: Skills load from the registered package"
else
  echo "  OK: Skills installed to $SKILLS_DIR"
fi

echo "[3/3] Setting up configuration..."
mkdir -p "$NIO_DIR"
if [ -n "$NIO_CONFIG" ]; then
  echo "  Applying operator config: $NIO_CONFIG"
  if ! node "$SCRIPT_DIR/skills/nio/scripts/config-cli.js" import "$NIO_CONFIG"; then
    echo "  FAIL: config import rejected by /nio doctor — install aborted." >&2
    exit 1
  fi
  echo "  OK: Operator config applied"
elif [ "$RESET_CONFIG" -eq 1 ] || [ ! -f "$NIO_DIR/config.yaml" ]; then
  [ -f "$SCRIPT_DIR/config.default.yaml" ] && cp "$SCRIPT_DIR/config.default.yaml" "$NIO_DIR/config.yaml"
  [ "$RESET_CONFIG" -eq 1 ] && echo "  OK: Config reset to defaults" || echo "  OK: Default config written"
else
  echo "  OK: Existing config kept"
fi

echo ""
echo "  Nio (Pi) is installed!"
echo ""
echo "  Start pi and run:"
echo ""
echo "    /nio scan <path>"
echo ""
echo "  To uninstall: $(basename "$0") --uninstall"
echo ""
```

Make it executable: `chmod +x plugins/pi/setup.sh`

- [ ] **Step 7: Verify the generated artefacts are ignored**

The repo keeps every build/sync artefact in the **root** `.gitignore` (see the
`plugins/openclaw/plugin/plugin.js` and per-plugin `config.default.yaml`
entries). Those entries for Pi are already in place:

```
plugins/pi/extensions/nio/index.js
plugins/pi/config.default.yaml
plugins/pi/config.schema.json
plugins/pi/README.md
```

Do **not** create `plugins/pi/.gitignore` — that would diverge from the
established pattern. `plugins/pi/package.json` (the pi manifest) IS tracked,
mirroring the tracked `plugins/openclaw/plugin/package.json`.

Confirm with:

```bash
git check-ignore -v plugins/pi/extensions/nio/index.js plugins/pi/config.default.yaml
git status --short plugins/pi
```

Expected: both paths report as ignored, and `git status` lists only
`package.json`, `setup.sh`, and the synced `skills/` tree.

- [ ] **Step 8: Add the doctor probe**

Doctor probes live in `runDoctor()` in `src/adapters/openclaw-dispatch.ts:522` — it builds a markdown report by pushing lines onto `out` and calling `markFail()` for failures. There is no platform-integration section yet, so add one. Insert this immediately before the `return { ok, report: out.join('\n') };` line:

```ts
  // ─── Platform Integrations ──────────────────────────────────────────
  out.push('', '### Platform Integrations');

  const home = process.env.HOME || process.env.USERPROFILE || '';

  // Pi — installed either as a pi package (settings.json `extensions`
  // entry) or by the CLI-less fallback (a bundle under extensions/nio/).
  const piAgent = join(home, '.pi', 'agent');
  const piBundle = join(piAgent, 'extensions', 'nio', 'index.js');
  let piRegistered = existsSync(piBundle);
  if (!piRegistered && existsSync(join(piAgent, 'settings.json'))) {
    try {
      const s = JSON.parse(readFileSync(join(piAgent, 'settings.json'), 'utf-8')) as {
        extensions?: unknown[]; packages?: unknown[];
      };
      const mentionsNio = (arr: unknown[] | undefined): boolean =>
        (arr ?? []).some((e) => {
          const v = typeof e === 'string' ? e : (e as { source?: string })?.source;
          return typeof v === 'string' && v.includes('nio');
        });
      piRegistered = mentionsNio(s.extensions) || mentionsNio(s.packages);
    } catch { /* unreadable settings — treat as not registered */ }
  }
  out.push(piRegistered
    ? '- ✓ pi: extension registered'
    : '- · pi: not installed (run plugins/pi/setup.sh to enable)');
  out.push('    note: Pi has no MCP support — the Phase 0 MCP gate is inactive there.');
```

Add `existsSync` / `readFileSync` to the `node:fs` import and `join` to the `node:path` import at the top of the file if they are not already present.

> This is an informational probe, not a failure: a user running `/nio doctor` on Claude Code has no reason to have Pi installed, so it must never call `markFail`.

- [ ] **Step 9: Build and verify end to end**

```bash
pnpm run build && pnpm test && pnpm typecheck
test -f plugins/pi/extensions/nio/index.js && echo "bundle OK"
test -f plugins/pi/skills/nio/SKILL.md && echo "umbrella skill OK"
test -f plugins/pi/skills/nio-scan/SKILL.md && echo "focused skill OK"
pnpm release:pi && ls -la releases/
```

Expected: all green; `releases/nio-pi-v<version>.zip` exists.

- [ ] **Step 10: Sandbox install smoke test**

```bash
TMP_PI=$(mktemp -d)
NIO_HOME=$(mktemp -d) bash plugins/pi/setup.sh --pi-home "$TMP_PI"
cat "$TMP_PI/settings.json"
NIO_HOME=$(mktemp -d) bash plugins/pi/setup.sh --pi-home "$TMP_PI"   # idempotency
cat "$TMP_PI/settings.json"                                          # must not duplicate
```

Expected: `extensions` and `skills` each contain exactly one nio entry after two runs.

- [ ] **Step 11: Commit**

```bash
git add plugins/pi scripts/build.js scripts/sync-shared.js scripts/release.js \
        scripts/sync-versions.js package.json src/adapters/openclaw-dispatch.ts
git commit -m "feat(pi): add pi package, installer, and release pipeline

The release zip is itself a valid pi package, so setup.sh prefers
'pi install' and falls back to copying the bundle plus an explicit
settings.json path entry when the pi CLI is absent."
```

---

## Phase C — opencode

### Task 8: `OpenCodeAdapter`

**Files:**
- Create: `src/adapters/opencode.ts`
- Create: `src/tests/fixtures/opencode/tool-execute-before-bash.json`
- Create: `src/tests/fixtures/opencode/tool-execute-before-write.json`
- Create: `src/tests/fixtures/opencode/tool-execute-before-edit.json`
- Create: `src/tests/fixtures/opencode/tool-execute-before-apply-patch.json`
- Create: `src/tests/fixtures/opencode/tool-execute-after-bash.json`
- Create: `src/tests/fixtures/opencode/README.md`
- Modify: `src/tests/adapter.test.ts`
- Modify: `src/tests/integration.test.ts`
- Modify: `src/adapters/index.ts`
- Modify: `src/core/shared/detection-data.ts`
- Modify: `plugins/shared/config.default.yaml`
- Modify: `plugins/shared/config.schema.json`

**Interfaces:**
- Consumes: `HookAdapter`, `HookInput`.
- Produces: `export class OpenCodeAdapter implements HookAdapter` with `readonly name = 'opencode'`, and `/**
 * Pull the first file target out of an apply_patch payload. opencode
 * marks each file in the patch body with `*** Add File: <path>`,
 * `*** Update File: <path>` or `*** Delete File: <path>`
 * (packages/opencode/src/patch.ts:76-87). Returns null when the payload
 * carries no marker, so the caller can fall back to an empty path
 * rather than inventing one.
 */
function firstPatchTarget(patchText: string | undefined): string | null {
  if (!patchText) return null;
  for (const line of patchText.split('\n')) {
    const m = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/.exec(line.trim());
    if (m) return m[1]!.trim();
  }
  return null;
}

/**
 * opencode's complete built-in tool set (permission-key table in
 * docs/agents.mdx + the imports in src/tool/registry.ts).
 *
 * `parseMcpToolName` needs this. opencode's MCP naming is
 * `<sanitized-server>_<sanitized-tool>` with no delimiter, so its
 * anonymous-MCP fallback tier would swallow any underscored built-in the
 * moment a single MCP server is configured. `apply_patch` is the only
 * built-in that contains an underscore — and it maps to write_file, so
 * misclassifying it would route core file edits through the
 * permitted_tools.mcp allowlist instead of permitted_tools.opencode.
 */
export const OPENCODE_BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  'read', 'write', 'edit', 'apply_patch', 'glob', 'grep', 'list', 'bash',
  'task', 'todowrite', 'todoread', 'webfetch', 'websearch', 'lsp', 'skill',
  'question',
]);

export interface OpenCodeAdapterOptions { nativeToolMapping?: Record<string, string> }`.

**opencode event shape** (from `packages/plugin/src/index.ts`): the binding layer receives `input = { tool, sessionID, callID }` and `output = { args }` as two separate objects. The adapter is fed a **merged** object of the shape `{ tool, sessionID, callID, args, cwd? }` so it matches the single-payload `parseInput` contract.

- [ ] **Step 1: Write the fixtures**

`src/tests/fixtures/opencode/tool-execute-before-bash.json`:

```json
{
  "tool": "bash",
  "sessionID": "ses_7c1f2a9b",
  "callID": "call_4d2e",
  "args": { "command": "ls /etc | head -5", "description": "list etc" }
}
```

`src/tests/fixtures/opencode/tool-execute-before-write.json`:

```json
{
  "tool": "write",
  "sessionID": "ses_7c1f2a9b",
  "callID": "call_4d2f",
  "args": { "filePath": "/tmp/demo.txt", "content": "hello" }
}
```

`src/tests/fixtures/opencode/tool-execute-before-edit.json`:

```json
{
  "tool": "edit",
  "sessionID": "ses_7c1f2a9b",
  "callID": "call_4d30",
  "args": { "filePath": "/tmp/demo.txt", "oldString": "hello", "newString": "goodbye" }
}
```

`src/tests/fixtures/opencode/tool-execute-before-apply-patch.json` — note there is
no `filePath`; the target lives in the marker line:

```json
{
  "tool": "apply_patch",
  "sessionID": "ses_7c1f2a9b",
  "callID": "call_4d31",
  "args": {
    "patchText": "*** Begin Patch\n*** Update File: src/server.ts\n@@\n-const port = 3000\n+const port = 8080\n*** End Patch"
  }
}
```

`src/tests/fixtures/opencode/tool-execute-after-bash.json`:

```json
{
  "tool": "bash",
  "sessionID": "ses_7c1f2a9b",
  "callID": "call_4d2e",
  "args": { "command": "ls /etc | head -5" },
  "title": "ls /etc | head -5",
  "output": "afpovertcp.cfg\naliases\n",
  "metadata": { "exit": 0 }
}
```

`src/tests/fixtures/opencode/README.md`:

```markdown
# opencode fixtures

Merged `input` + `output` payloads for the `tool.execute.before` and
`tool.execute.after` hooks, whose signatures are defined in
`sst/opencode` → `packages/plugin/src/index.ts` (the `Hooks` interface).
The binding layer merges the two hook arguments into one object before
handing it to `OpenCodeAdapter.parseInput`.

opencode's write/edit tools use `filePath` (camelCase), unlike Claude
Code's `file_path`.
```

- [ ] **Step 2: Write the failing test**

Add to `src/tests/adapter.test.ts` — extend the imports with `import { OpenCodeAdapter } from '../adapters/opencode.js';`, then append:

```ts
// ─────────────────────────────────────────────────────────────────────────────
// OpenCodeAdapter
// ─────────────────────────────────────────────────────────────────────────────

describe('OpenCodeAdapter', () => {
  const adapter = new OpenCodeAdapter();
  const ocFixture = (name: string) =>
    JSON.parse(readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'opencode', name), 'utf-8',
    ));

  it('should have name "opencode"', () => {
    assert.equal(adapter.name, 'opencode');
  });

  describe('parseInput', () => {
    it('reads tool name from `tool` and parameters from `args`', () => {
      const parsed = adapter.parseInput(ocFixture('tool-execute-before-bash.json'));
      assert.equal(parsed.toolName, 'bash');
      assert.equal(parsed.sessionId, 'ses_7c1f2a9b');
      assert.equal(parsed.eventType, 'pre');
      assert.equal(
        (parsed.toolInput as { command: string }).command, 'ls /etc | head -5',
      );
    });

    it('marks a payload carrying `output` as a post event', () => {
      const parsed = adapter.parseInput(ocFixture('tool-execute-after-bash.json'));
      assert.equal(parsed.eventType, 'post');
    });

    it('handles missing fields gracefully', () => {
      const parsed = adapter.parseInput({});
      assert.equal(parsed.toolName, '');
      assert.deepEqual(parsed.toolInput, {});
      assert.equal(parsed.eventType, 'pre');
    });
  });

  describe('mapToolToActionType', () => {
    it('maps opencode built-in tools', () => {
      assert.equal(adapter.mapToolToActionType('bash'), 'exec_command');
      assert.equal(adapter.mapToolToActionType('write'), 'write_file');
      assert.equal(adapter.mapToolToActionType('edit'), 'write_file');
      assert.equal(adapter.mapToolToActionType('apply_patch'), 'write_file');
      assert.equal(adapter.mapToolToActionType('read'), 'read_file');
      assert.equal(adapter.mapToolToActionType('webfetch'), 'network_request');
      assert.equal(adapter.mapToolToActionType('websearch'), 'network_request');
    });

    it('returns null for navigation-only tools', () => {
      assert.equal(adapter.mapToolToActionType('glob'), null);
      assert.equal(adapter.mapToolToActionType('grep'), null);
      assert.equal(adapter.mapToolToActionType('list'), null);
      assert.equal(adapter.mapToolToActionType('todowrite'), null);
    });
  });

  describe('buildEnvelope', () => {
    it('builds an exec_command envelope from a bash call', () => {
      const env = adapter.buildEnvelope(
        adapter.parseInput(ocFixture('tool-execute-before-bash.json')),
      );
      assert.ok(env);
      assert.equal(env.action.type, 'exec_command');
      assert.equal((env.action.data as { command: string }).command, 'ls /etc | head -5');
    });

    it('reads the write path from `filePath` (camelCase)', () => {
      const env = adapter.buildEnvelope(
        adapter.parseInput(ocFixture('tool-execute-before-write.json')),
      );
      assert.ok(env);
      assert.equal(env.action.type, 'write_file');
      assert.equal((env.action.data as { path: string }).path, '/tmp/demo.txt');
      assert.equal((env.action.data as { content_preview: string }).content_preview, 'hello');
    });

    it('reads the edit tool body from newString', () => {
      const env = adapter.buildEnvelope(
        adapter.parseInput(ocFixture('tool-execute-before-edit.json')),
      );
      assert.ok(env);
      assert.equal(env.action.type, 'write_file');
      assert.equal((env.action.data as { path: string }).path, '/tmp/demo.txt');
      assert.equal((env.action.data as { content_preview: string }).content_preview, 'goodbye');
    });

    it('extracts the apply_patch target from the patch marker line', () => {
      // apply_patch has no filePath field at all — the target is a
      // `*** Update File:` marker inside patchText. Without extraction
      // both path and content_preview would be empty.
      const env = adapter.buildEnvelope(
        adapter.parseInput(ocFixture('tool-execute-before-apply-patch.json')),
      );
      assert.ok(env);
      assert.equal(env.action.type, 'write_file');
      assert.equal((env.action.data as { path: string }).path, 'src/server.ts');
      assert.match(
        (env.action.data as { content_preview: string }).content_preview,
        /port = 8080/,
      );
    });

    it('builds a read_file envelope from filePath', () => {
      const env = adapter.buildEnvelope(
        adapter.parseInput({ tool: 'read', args: { filePath: '/etc/passwd' } }),
      );
      assert.ok(env);
      assert.equal(env.action.type, 'read_file');
      assert.equal((env.action.data as { path: string }).path, '/etc/passwd');
    });

    it('builds network_request envelopes for webfetch (url) and websearch (query)', () => {
      const fetched = adapter.buildEnvelope(
        adapter.parseInput({ tool: 'webfetch', args: { url: 'https://example.test/x' } }),
      );
      assert.ok(fetched);
      assert.equal(fetched.action.type, 'network_request');
      assert.equal((fetched.action.data as { url: string }).url, 'https://example.test/x');

      const searched = adapter.buildEnvelope(
        adapter.parseInput({ tool: 'websearch', args: { query: 'how to exfiltrate' } }),
      );
      assert.ok(searched);
      assert.equal((searched.action.data as { url: string }).url, 'how to exfiltrate');
    });

    it('returns null for an unmapped tool', () => {
      assert.equal(adapter.buildEnvelope(adapter.parseInput({ tool: 'glob', args: {} })), null);
    });

    it('honours a config-provided native_tool_mapping', () => {
      const custom = new OpenCodeAdapter({ nativeToolMapping: { question: 'network_request' } });
      assert.equal(custom.mapToolToActionType('question'), 'network_request');
      assert.equal(custom.mapToolToActionType('bash'), null);
    });

    it('carries the opencode session id into the envelope context', () => {
      const env = adapter.buildEnvelope(
        adapter.parseInput(ocFixture('tool-execute-before-bash.json')),
      );
      assert.ok(env);
      assert.equal(env.context.session_id, 'ses_7c1f2a9b');
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm run build`
Expected: FAIL — `Cannot find module '../adapters/opencode.js'`.

- [ ] **Step 4: Write the implementation**

Create `src/adapters/opencode.ts`:

```ts
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import type {
  ActionEnvelope, ActionData, ActionType,
  ExecCommandData, FileOperationData, NetworkRequestData,
} from '../types/action.js';
import type { HookAdapter, HookInput } from './types.js';

/**
 * Default native-tool → action-type mapping for opencode.
 *
 * The full built-in set is read, write, edit, apply_patch, glob, grep,
 * list, bash, task, todowrite, todoread, webfetch, websearch, lsp,
 * skill, question (see the permission-key table in opencode's
 * docs/agents.mdx and the imports in src/tool/registry.ts).
 *
 * glob / grep / list / todo* / lsp / skill / question are deliberately
 * unmapped: they are navigation and bookkeeping, not effects on the
 * outside world, and mapping them would flood the audit log without
 * adding signal. `task` is handled as a sub-agent span, not an action.
 */
const DEFAULT_NATIVE_TOOL_MAPPING: Record<string, ActionType> = {
  bash: 'exec_command',
  write: 'write_file',
  edit: 'write_file',
  apply_patch: 'write_file',
  read: 'read_file',
  webfetch: 'network_request',
  websearch: 'network_request',
};

export interface OpenCodeAdapterOptions {
  /** Config-driven tool → action type mapping, overrides the built-in default. */
  nativeToolMapping?: Record<string, string>;
}

/**
 * opencode plugin adapter.
 *
 * Bridges opencode's `tool.execute.before` / `tool.execute.after` hooks
 * to the common Nio decision engine. Those hooks take two arguments
 * (`input` and `output`); the binding layer merges them into a single
 * object of the shape `{ tool, sessionID, callID, args, output? }`
 * before calling `parseInput`, so the single-payload HookAdapter
 * contract still holds.
 *
 * Blocking is done by throwing from the before-hook — opencode's
 * session/tools.ts triggers the hook ahead of `item.execute`, so a
 * throw prevents execution entirely.
 */
export class OpenCodeAdapter implements HookAdapter {
  readonly name = 'opencode';
  private nativeToolMapping: Record<string, ActionType>;

  constructor(opts?: OpenCodeAdapterOptions) {
    this.nativeToolMapping =
      (opts?.nativeToolMapping as Record<string, ActionType>) ?? DEFAULT_NATIVE_TOOL_MAPPING;
  }

  parseInput(raw: unknown): HookInput {
    const event = (raw ?? {}) as Record<string, unknown>;
    return {
      toolName: (event.tool as string) || '',
      toolInput: (event.args as Record<string, unknown>) || {},
      // The after-hook payload carries `output`; the before-hook does not.
      eventType: 'output' in event ? 'post' : 'pre',
      sessionId: event.sessionID as string | undefined,
      cwd: event.cwd as string | undefined,
      raw: event,
    };
  }

  mapToolToActionType(toolName: string): string | null {
    return this.nativeToolMapping[toolName] || null;
  }

  buildEnvelope(input: HookInput, initiatingSkill?: string | null): ActionEnvelope | null {
    const actionType = this.mapToolToActionType(input.toolName) as ActionType | null;
    if (!actionType) return null;

    const actor = {
      skill: {
        id: initiatingSkill || 'opencode-session',
        source: initiatingSkill || 'opencode',
        version_ref: '0.0.0',
        artifact_hash: '',
      },
    };

    const context = {
      session_id: input.sessionId || `opencode-${Date.now()}`,
      user_present: true,
      env: 'prod' as const,
      time: new Date().toISOString(),
      initiating_skill: initiatingSkill || undefined,
    };

    let actionData: ActionData;

    switch (actionType) {
      case 'exec_command': {
        const data: ExecCommandData = {
          command: (input.toolInput.command as string) || '',
          args: [],
          cwd: input.cwd,
        };
        actionData = data;
        break;
      }

      case 'write_file': {
        // opencode uses camelCase `filePath`. The three writers differ:
        //   write       → { filePath, content }
        //   edit        → { filePath, newString }
        //   apply_patch → { patchText }   ← NO filePath at all
        // apply_patch's targets are marker lines inside the patch text
        // (packages/opencode/src/tool/apply_patch.ts declares a single
        // `patchText` field; packages/opencode/src/patch.ts parses the
        // `*** Add|Update|Delete File:` markers). Without extracting
        // them, every apply_patch call would reach the audit log with an
        // empty path and give Phase 3 nothing to scan.
        const patchText = input.toolInput.patchText as string | undefined;
        const content =
          (input.toolInput.content as string) ||
          (input.toolInput.newString as string) ||
          patchText || '';
        const data: FileOperationData = {
          path: (input.toolInput.filePath as string) || firstPatchTarget(patchText) || '',
          content_preview: content.slice(0, 10_000),
        };
        actionData = data;
        break;
      }

      case 'read_file': {
        const data: FileOperationData = {
          path: (input.toolInput.filePath as string) || '',
        };
        actionData = data;
        break;
      }

      case 'network_request': {
        const data: NetworkRequestData = {
          method: 'GET',
          url:
            (input.toolInput.url as string) ||
            (input.toolInput.query as string) || '',
        };
        actionData = data;
        break;
      }

      default:
        return null;
    }

    return { actor, action: { type: actionType, data: actionData }, context };
  }

  /**
   * opencode loads skills through its native `skill` tool rather than
   * annotating downstream tool calls, so the initiating skill is not
   * recoverable from a tool event. Returning null keeps the audit row
   * honest rather than guessing.
   */
  async inferInitiatingSkill(_input: HookInput): Promise<string | null> {
    return null;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/adapter.test.js`
Expected: PASS.

- [ ] **Step 6: Wire config defaults, barrel export, and sensitive paths**

In `src/adapters/index.ts`:

```ts
export { OpenCodeAdapter, type OpenCodeAdapterOptions } from './opencode.js';
```

In `plugins/shared/config.default.yaml`, inside `guard.native_tool_mapping`, after the `pi:` block:

```yaml
    opencode:
      bash: exec_command
      write: write_file
      edit: write_file
      apply_patch: write_file
      read: read_file
      webfetch: network_request
      websearch: network_request
```

Add an `opencode: []` row to **both** `permitted_tools` and `blocked_tools`, after the `pi: []` row added in Task 5 and before `mcp: []`. Mirror the `native_tool_mapping` addition into `plugins/shared/config.schema.json`.

In `src/core/shared/detection-data.ts`, alongside the `.pi/` entries added in Task 5:

```ts
  '.opencode/opencode.json',
  '.config/opencode/opencode.json',
  '.opencode/',
```

- [ ] **Step 7: Sync and verify**

Run: `node scripts/sync-shared.js && pnpm run build && pnpm test`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/adapters/opencode.ts src/adapters/index.ts src/tests/fixtures/opencode \
        src/tests/adapter.test.ts src/core/shared/detection-data.ts \
        plugins/shared/config.default.yaml plugins/shared/config.schema.json plugins/
git commit -m "feat(opencode): add OpenCodeAdapter with verified built-in tool mapping

opencode uses camelCase parameter names (filePath, newString) and passes
the tool name as \`tool\`. Navigation-only tools (glob/grep/list/todo*)
stay unmapped so the audit log carries signal rather than noise."
```

---

### Task 9: opencode MCP support

**Files:**
- Modify: `src/adapters/hook-engine.ts` (`parseMcpToolName`)
- Modify: `src/adapters/mcp-registry.ts`
- Modify: `src/tests/mcp-registry.test.ts`
- Create: `src/tests/opencode-mcp.test.ts`

**Interfaces:**
- Consumes: `ParsedMcpToolName` and `parseMcpToolName(toolName, platform)` from `./hook-engine.js`; `MCPRegistry` from `./mcp-registry.js`.
- Produces: `parseMcpToolName` accepts an optional third parameter `knownServers?: readonly string[]`; `MCPSource` gains the `'opencode'` member.

**Naming convention** (`packages/opencode/src/mcp/catalog.ts:117-119`):

```ts
const sanitize = (value) => value.replace(/[^a-zA-Z0-9_-]/g, "_")
const toolName = (clientName, name) => sanitize(clientName) + "_" + sanitize(name)
```

There is no fixed delimiter, so a bare split is impossible. The existing Hermes branch already establishes the fallback convention for exactly this situation: keep the full tool name as `local` and leave `server` unset.

- [ ] **Step 1: Write the failing test**

Create `src/tests/opencode-mcp.test.ts`:

```ts
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMcpToolName } from '../adapters/hook-engine.js';

describe('parseMcpToolName — opencode', () => {
  it('attributes a tool to a known server', () => {
    const r = parseMcpToolName('github_create_issue', 'opencode', ['github', 'jira']);
    assert.equal(r.isMcp, true);
    assert.equal(r.server, 'github');
    assert.equal(r.local, 'create_issue');
  });

  it('prefers the longest matching server prefix', () => {
    const r = parseMcpToolName('my_server_search', 'opencode', ['my', 'my_server']);
    assert.equal(r.isMcp, true);
    assert.equal(r.server, 'my_server');
    assert.equal(r.local, 'search');
  });

  it('handles a sanitized server name containing underscores', () => {
    // opencode sanitizes "my-server.io" to "my-server_io"
    const r = parseMcpToolName('my-server_io_list', 'opencode', ['my-server_io']);
    assert.equal(r.isMcp, true);
    assert.equal(r.server, 'my-server_io');
    assert.equal(r.local, 'list');
  });

  it('falls back to the full name when no server matches', () => {
    const r = parseMcpToolName('unknown_tool', 'opencode', ['github']);
    assert.equal(r.isMcp, true);
    assert.equal(r.server, undefined);
    assert.equal(r.local, 'unknown_tool');
  });

  it('reports non-MCP when no servers are configured', () => {
    assert.equal(parseMcpToolName('bash', 'opencode', []).isMcp, false);
    assert.equal(parseMcpToolName('bash', 'opencode').isMcp, false);
  });

  it('never treats a built-in tool name as MCP when servers exist', () => {
    // "bash" has no underscore, so it cannot be a <server>_<tool> form.
    assert.equal(parseMcpToolName('bash', 'opencode', ['github']).isMcp, false);
  });

  it('never misclassifies apply_patch, the one underscored built-in', () => {
    // Regression guard: without the built-in check this falls into the
    // anonymous-MCP tier, and a permitted_tools.mcp allowlist would then
    // gate (and deny) opencode's core file-editing tool.
    const r = parseMcpToolName('apply_patch', 'opencode', ['github']);
    assert.equal(r.isMcp, false);
    // Also true when a server name happens to prefix it.
    assert.equal(parseMcpToolName('apply_patch', 'opencode', ['apply']).isMcp, false);
  });

  it('leaves other platforms untouched', () => {
    const r = parseMcpToolName('mcp__github__create_issue', 'claude-code');
    assert.equal(r.isMcp, true);
    assert.equal(r.server, 'github');
    assert.equal(r.local, 'create_issue');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run build`
Expected: FAIL — `tsc`: `Expected 2 arguments, but got 3`.

- [ ] **Step 3: Implement the parser branch**

In `src/adapters/hook-engine.ts`, change the signature and add the branch before the final `return { isMcp: false };`:

```ts
export function parseMcpToolName(
  toolName: string,
  platform: string,
  knownServers?: readonly string[],
): ParsedMcpToolName {
  const name = toolName ?? '';

  // ... existing claude-code / codex / openclaw / hermes branches unchanged ...

  // opencode flattens MCP tools as `<sanitize(server)>_<sanitize(tool)>`
  // (packages/opencode/src/mcp/catalog.ts:119), where
  // sanitize = s.replace(/[^a-zA-Z0-9_-]/g, "_"). There is no fixed
  // delimiter, so a bare split is impossible. Two tiers:
  //   1. Attribution — longest matching server prefix from the registry.
  //   2. Fallback — keep the FULL tool name as `local` with `server`
  //      unset, exactly like the Hermes single-underscore branch, so
  //      users can allow/deny by the name they actually see.
  // With no servers configured, nothing is MCP and native tools are
  // untouched.
  if (platform === 'opencode') {
    if (!knownServers || knownServers.length === 0) return { isMcp: false };
    if (!name.includes('_')) return { isMcp: false };
    // A built-in is never an MCP call, however it is spelled. Without
    // this, `apply_patch` — the one underscored built-in — reaches the
    // anonymous-MCP fallback below as soon as any server is configured,
    // and a permitted_tools.mcp allowlist would then deny core file edits.
    if (OPENCODE_BUILTIN_TOOLS.has(name)) return { isMcp: false };

    const matches = knownServers
      .filter(s => name.startsWith(`${s}_`) && name.length > s.length + 1)
      .sort((a, b) => b.length - a.length);

    if (matches.length > 0) {
      const server = matches[0]!;
      return { isMcp: true, server, local: name.slice(server.length + 1) };
    }
    return { isMcp: true, local: name };
  }

  return { isMcp: false };
}
```

- [ ] **Step 4: Thread the server list through `checkToolGate`**

`MCPRegistry` exposes `entries: ReadonlyArray<MCPServerEntry>` (each with a `serverName`) — there is no server map, so the server list is derived from `entries`.

In `checkToolGate` (`src/adapters/hook-engine.ts:235`), the registry is currently loaded *after* `parseMcpToolName` is called. Move the load above the parse and pass the names:

```ts
  const registry = injectedRegistry ?? loadMCPRegistry();
  const knownServers = registry.entries.map(e => e.serverName);

  const parsed = parseMcpToolName(toolName, platform, knownServers);
  const nameMcpCandidates = parsed.isMcp && parsed.local
    ? (parsed.server
        ? [parsed.local, `${parsed.server}__${parsed.local}`]
        : [parsed.local])
    : [];
```

Then delete the now-duplicated `const registry = injectedRegistry ?? loadMCPRegistry();` line that sat below `nameMcpCandidates`.

In `evaluateHook`'s MCP-fallback block (`src/adapters/hook-engine.ts`, the `if (!envelope && input.toolName)` branch), make the same change:

```ts
  if (!envelope && input.toolName) {
    const registry = options.mcpRegistry ?? loadMCPRegistry();
    const parsed = parseMcpToolName(
      input.toolName, adapter.name, registry.entries.map(e => e.serverName),
    );
    if (parsed.isMcp && parsed.local) {
      envelope = buildMcpEnvelope(input, parsed, initiatingSkill, adapter.name);
    }
  }
```

- [ ] **Step 5: Add the opencode registry source**

Three changes in `src/adapters/mcp-registry.ts`.

**(a) Extend the source union** (line 26):

```ts
export type MCPSource =
  'claude' | 'claude_desktop' | 'hermes' | 'openclaw' | 'opencode' | 'manual';
```

**(b) Register the source** — in `discoverSources()`, after the OpenClaw entry:

```ts
  const ocRoot = process.env.XDG_CONFIG_HOME || join(home, '.config');
  sources.push({
    path: join(ocRoot, 'opencode', 'opencode.json'),
    source: 'opencode',
    format: 'json',
    parse: (data) => extractFromMcpServers(data, ['mcp']),
  });
```

**(c) Teach `parseServerBlock` opencode's block shape.** opencode writes
`{ type: "local", command: ["npx", "-y", "mcp-fs"], enabled?: boolean }` or
`{ type: "remote", url: "...", enabled?: boolean }`. Two differences from
every existing source: `command` is an **array** (the others use a string
plus a separate `args` array), and there is an `enabled` flag.

Change the return type to `MCPServerEntry | null` and add an early return
plus array-command normalisation:

```ts
function parseServerBlock(
  serverName: string,
  block: unknown,
  source: MCPSource,
): MCPServerEntry | null {
  const entry: MCPServerEntry = {
    serverName, urls: [], sockets: [], binaries: [], cliPackages: [], source,
  };

  if (!block || typeof block !== 'object') return entry;
  const b = block as Record<string, unknown>;

  // opencode marks servers it should not start with `enabled: false`.
  // A disabled server contributes no reachable handles.
  if (b['enabled'] === false) return null;

  // ... existing url / endpoint / socket handling unchanged ...

  // command → binaries / cliPackages depending on whether it's a runner.
  // opencode passes the whole argv as an array; every other source passes
  // a command string plus a separate `args` array. Normalise both to
  // (command, args).
  const rawCmd = b['command'];
  const cmd = Array.isArray(rawCmd) ? rawCmd[0] : rawCmd;
  const args = Array.isArray(rawCmd) ? rawCmd.slice(1) : b['args'];
  if (typeof cmd === 'string' && cmd.length > 0) {
    const cmdBase = basename(cmd);
    entry.binaries.push(cmdBase);
    if (PACKAGE_RUNNERS.has(cmdBase) && Array.isArray(args)) {
      const pkg = firstPackageArg(args as unknown[]);
      if (pkg) entry.cliPackages.push(pkg);
    }
  }

  return entry;
}
```

**(d) Skip nulls at the single call site** in `loadFromSource()` (line ~250):

```ts
  const entries: MCPServerEntry[] = [];
  for (const [name, block] of Object.entries(servers)) {
    if (!name) continue;
    const entry = parseServerBlock(name, block, desc.source);
    if (entry) entries.push(entry);
  }
```

- [ ] **Step 6: Add a registry test**

`loadMCPRegistry` already accepts `{ home, configLoader }` for exactly this
purpose (`LoadMCPRegistryOptions`, line 401), so the test stays entirely off
real user paths. Append to `src/tests/mcp-registry.test.ts`:

```ts
describe('loadMCPRegistry — opencode source', () => {
  it('parses local and remote opencode MCP servers and skips disabled ones', async () => {
    const home = await mkdtemp(join(tmpdir(), 'nio-oc-'));
    await mkdir(join(home, '.config', 'opencode'), { recursive: true });
    await writeFile(
      join(home, '.config', 'opencode', 'opencode.json'),
      JSON.stringify({
        mcp: {
          github: { type: 'remote', url: 'https://mcp.github.test/sse', enabled: true },
          fs: { type: 'local', command: ['npx', '-y', 'mcp-fs'], enabled: true },
          off: { type: 'local', command: ['npx', 'nope'], enabled: false },
        },
      }),
    );

    clearMCPRegistryCache();
    const registry = loadMCPRegistry({ home, configLoader: () => ({}) });
    const byName = (n: string) => registry.entries.find(e => e.serverName === n);

    assert.equal(byName('github')?.urls[0], 'https://mcp.github.test/sse');
    assert.equal(byName('github')?.source, 'opencode');
    // Array-form command: argv[0] is the binary, the rest are args, and
    // npx is a package runner so the package name lands in cliPackages.
    assert.deepEqual(byName('fs')?.binaries, ['npx']);
    assert.deepEqual(byName('fs')?.cliPackages, ['mcp-fs']);
    assert.equal(byName('off'), undefined);
  });
});
```

> `XDG_CONFIG_HOME` takes precedence over `<home>/.config` in the source
> descriptor, so if the test environment sets it, unset it for this test
> (`delete process.env.XDG_CONFIG_HOME`) or the temp home is ignored.
> Match the import style already used at the top of this test file — it
> imports `loadMCPRegistry` and `clearMCPRegistryCache` from
> `../adapters/mcp-registry.js` and the `node:fs/promises` / `node:os`
> helpers used above.

- [ ] **Step 7: Run tests**

Run: `pnpm run build && pnpm test`
Expected: all green, including the seven new `opencode-mcp` cases.

- [ ] **Step 8: Commit**

```bash
git add src/adapters/hook-engine.ts src/adapters/mcp-registry.ts \
        src/tests/opencode-mcp.test.ts src/tests/mcp-registry.test.ts
git commit -m "feat(opencode): identify MCP tools and read opencode MCP config

opencode flattens MCP tools as <sanitize(server)>_<sanitize(tool)> with
no fixed delimiter, so parseMcpToolName gains a two-tier opencode
branch: longest-prefix attribution against registry server names, then
the existing Hermes fallback of keeping the full name as \`local\`."
```

---

### Task 10: opencode plugin binding

**Files:**
- Create: `src/adapters/opencode-plugin.ts`
- Modify: `src/adapters/index.ts`
- Modify: `src/tests/plugin-runtime.test.ts`

**Interfaces:**
- Consumes: `InProcessPluginRuntime`, `OpenCodeAdapter`, `loadConfig`, `z` from `zod`.
- Produces: `export class NioBlockedError extends Error`, `export function createNioPlugin(options?: OpenCodePluginOptions): OpenCodePlugin`, and `export const NioPlugin` (the default plugin export opencode loads).
- `OpenCodePluginOptions` = `{ level?: string; nioFactory?: () => NioInstance }`.

**Critical constraint** (design spec §4.4): opencode wraps hooks in `Effect.promise`, which turns any rejection into a defect. Every handler needs total catch coverage. The **only** exception is the deliberate `NioBlockedError`, which must propagate.

- [ ] **Step 1: Write the failing test**

Append to `src/tests/plugin-runtime.test.ts`:

```ts
describe('createNioPlugin (opencode)', () => {
  const pluginInput = {
    client: {}, project: {}, directory: '/tmp', worktree: '/tmp',
    $: (() => {}) as never, serverUrl: new URL('http://127.0.0.1:1'),
  };

  it('exposes every hook Nio needs', async () => {
    const { createNioPlugin } = await import('../adapters/opencode-plugin.js');
    const hooks = await createNioPlugin()(pluginInput as never);
    for (const name of [
      'tool.execute.before', 'tool.execute.after', 'chat.message',
      'permission.ask', 'event', 'dispose',
    ]) {
      assert.ok(name in hooks, `missing hook: ${name}`);
    }
    assert.ok(hooks.tool && 'nio_command' in hooks.tool);
  });

  it('tool.execute.before swallows internal errors instead of leaking a defect', async () => {
    const { createNioPlugin } = await import('../adapters/opencode-plugin.js');
    const hooks = await createNioPlugin()(pluginInput as never);
    // A malformed output object would throw inside the handler; the
    // handler must absorb it so opencode never sees a defect.
    await hooks['tool.execute.before']!(
      { tool: 'bash', sessionID: 's1', callID: 'c1' } as never,
      null as never,
    );
  });

  it('NioBlockedError carries the denial reason', async () => {
    const { NioBlockedError } = await import('../adapters/opencode-plugin.js');
    const err = new NioBlockedError('nope');
    assert.equal(err.message, 'nope');
    assert.equal(err.name, 'NioBlockedError');
    assert.ok(err instanceof Error);
  });

  it('the nio_command tool returns dispatcher text', async () => {
    const { createNioPlugin } = await import('../adapters/opencode-plugin.js');
    const hooks = await createNioPlugin()(pluginInput as never);
    const out = await hooks.tool!['nio_command']!.execute(
      { command: '' } as never, {} as never,
    );
    assert.equal(typeof out, 'string');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run build`
Expected: FAIL — `Cannot find module '../adapters/opencode-plugin.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/adapters/opencode-plugin.ts`:

```ts
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
              // otherwise leak. flushSessionTurn force-closes them.
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
```

- [ ] **Step 4: Add the missing runtime helper**

`disposeAllSessions()` does not exist. Add it to `InProcessPluginRuntime` in `src/adapters/plugin-runtime.ts`:

```ts
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm run build && node --import ./dist/tests/helpers/isolate-nio-home.js --test dist/tests/plugin-runtime.test.js`
Expected: PASS.

- [ ] **Step 6: Export from the barrel**

In `src/adapters/index.ts`:

```ts
export {
  createNioPlugin,
  NioPlugin,
  NioBlockedError,
  type OpenCodePlugin,
  type OpenCodePluginOptions,
} from './opencode-plugin.js';
```

- [ ] **Step 7: Audit catch coverage**

Read the finished `src/adapters/opencode-plugin.ts` top to bottom and confirm that **every** `async` handler body is fully inside a `try`, and that `NioBlockedError` is the only value that escapes. This is the review gate from design spec §4.4 — do not skip it.

- [ ] **Step 8: Commit**

```bash
git add src/adapters/opencode-plugin.ts src/adapters/plugin-runtime.ts \
        src/adapters/index.ts src/tests/plugin-runtime.test.ts
git commit -m "feat(opencode): add opencode plugin binding

Blocks by throwing NioBlockedError from tool.execute.before, which
opencode triggers ahead of item.execute. Every other handler has total
catch coverage because opencode wraps hooks in Effect.promise, where a
rejection becomes a defect. session.idle doubles as the safety net for
tools that throw and therefore skip tool.execute.after."
```

---

### Task 11: opencode packaging, installer, and pipeline

**Files:**
- Create: `plugins/opencode/commands/nio.md`
- Create: `plugins/opencode/setup.sh`
- Modify: `scripts/build.js`
- Modify: `scripts/sync-shared.js`
- Modify: `scripts/release.js`
- Modify: `package.json`
- Modify: `src/adapters/openclaw-dispatch.ts`

**Interfaces:**
- Consumes: the bundled output of `src/adapters/opencode-plugin.ts`.
- Produces: `plugins/opencode/plugins/nio.js` (generated bundle), `plugins/opencode/skills/**` (generated by sync-shared), and a `pnpm release:opencode` target producing `releases/nio-opencode-v<version>.zip`.

- [ ] **Step 1: Write the slash command**

Create `plugins/opencode/commands/nio.md`:

```markdown
---
description: Nio — scan code, evaluate an action, read the audit report, manage config
---

Call the `nio_command` tool with `command` set to exactly this text, verbatim and unmodified:

$ARGUMENTS

Then show the tool's output to the user as-is. Do not summarise, reformat, or interpret it — it is already formatted for display. If the text above is empty, call `nio_command` with `command` set to an empty string.
```

- [ ] **Step 2: Add the bundle target**

In `scripts/build.js`, after the Pi build block:

```js
// opencode plugin bundle. Single non-split bundle so an opencode-only
// release zip is self-contained.
const OC_PLUGIN_DIR = join(ROOT, 'plugins/opencode/plugins');
const opencode = await Bun.build({
  ...shared,
  entrypoints: [join(ROOT, 'dist/adapters/opencode-plugin.js')],
  outdir: OC_PLUGIN_DIR,
  naming: { entry: 'nio.js' },
  splitting: false,
});

if (!opencode.success) {
  console.error(opencode.logs);
  process.exit(1);
}
writeEsmSentinel(OC_PLUGIN_DIR);
```

Add `${opencode.outputs.length} opencode output(s)` to the summary line.

> `writeEsmSentinel` is required here (unlike `plugins/pi/`) because
> `plugins/opencode/plugins/` has no package.json of its own, and the
> installed copy at `~/.config/opencode/plugins/` has no ESM-declaring
> ancestor either.

- [ ] **Step 3: Add opencode to the skill sync**

In `scripts/sync-shared.js`, add `join(ROOT, 'plugins', 'opencode')` to both `SKILL_PLUGIN_DIRS` and `FOCUSED_SKILL_PLUGIN_DIRS`.

- [ ] **Step 4: Add the release target**

In `scripts/release.js`: add `'opencode'` to the validation array, the usage string, and the `all` list; add the case:

```js
    case 'opencode':
      zipFromDir(name, 'plugins/opencode');
      break;
```

Add to the header comment: `  opencode.zip    → plugins/, commands/, skills/, setup.sh, ...`

In root `package.json` `scripts`:

```json
    "release:opencode": "node scripts/release.js opencode",
```

- [ ] **Step 5: Write the installer**

Create `plugins/opencode/setup.sh` (mode 0755). opencode has no plugin-install CLI, so this is the Codex-style nuke + copy.

```bash
#!/usr/bin/env bash
set -euo pipefail

# Nio — opencode plugin setup
#
# opencode has no plugin-install CLI, so this performs a full idempotent
# nuke + copy into the opencode config dir:
#   plugins/nio.js       — the bundled Nio plugin
#   commands/nio.md      — the /nio slash command template
#   skills/nio + nio-*   — the unified umbrella skill and the six
#                          focused per-capability skills
#
# Plugin discovery is confirmed by opencode's config/plugin.ts, which
# globs "{plugin,plugins}/*.{ts,js}" — both spellings work; we use the
# documented plural form.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NIO_DIR="${NIO_HOME:-$HOME/.nio}"
MIN_NODE_VERSION=18

UNINSTALL=0
RESET_CONFIG=0
OC_HOME_ARG=""
CONFIG_FILE_ARG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall|uninstall)  UNINSTALL=1; shift ;;
    --reset-to-defaults)    RESET_CONFIG=1; shift ;;
    --opencode-home)        OC_HOME_ARG="${2:-}"; shift 2 ;;
    --opencode-home=*)      OC_HOME_ARG="${1#*=}"; shift ;;
    --config)               CONFIG_FILE_ARG="${2:-}"; shift 2 ;;
    --config=*)             CONFIG_FILE_ARG="${1#*=}"; shift ;;
    -h|--help)
      echo "Usage: $(basename "$0") [--opencode-home <path>] [--config <path>] [--reset-to-defaults] [--uninstall]"
      echo ""
      echo "  --opencode-home <path>  Path to the opencode config dir."
      echo "                          Defaults to \$XDG_CONFIG_HOME/opencode,"
      echo "                          then \$HOME/.config/opencode."
      echo "  --config <path>         Apply an operator-provided ~/.nio/config.yaml."
      echo "  --reset-to-defaults     Overwrite existing nio config with bundled defaults."
      echo "  --uninstall             Remove the plugin, command, skills, and config."
      exit 0 ;;
    *) echo "  ERROR: Unknown option: $1"; echo "  Run with --help for usage."; exit 1 ;;
  esac
done

NIO_CONFIG="${CONFIG_FILE_ARG:-${NIO_CONFIG:-}}"
if [ -n "$NIO_CONFIG" ]; then
  if [ ! -f "$NIO_CONFIG" ]; then
    echo "  ERROR: --config file not found: $NIO_CONFIG" >&2; exit 1
  fi
  NIO_CONFIG="$(cd "$(dirname "$NIO_CONFIG")" && pwd)/$(basename "$NIO_CONFIG")"
fi
if [ "$RESET_CONFIG" -eq 1 ] && [ -n "$NIO_CONFIG" ]; then
  echo "  ERROR: --config and --reset-to-defaults are mutually exclusive." >&2; exit 1
fi
if [ "$UNINSTALL" -eq 1 ] && [ -n "$NIO_CONFIG" ]; then
  echo "  ERROR: --config and --uninstall are mutually exclusive." >&2; exit 1
fi

if [ -n "$OC_HOME_ARG" ]; then
  OC_HOME="$OC_HOME_ARG"
elif [ -n "${XDG_CONFIG_HOME:-}" ]; then
  OC_HOME="$XDG_CONFIG_HOME/opencode"
else
  OC_HOME="$HOME/.config/opencode"
fi

FOCUSED_SKILLS="nio-scan nio-action nio-report nio-config nio-doctor nio-external-score"

echo ""
echo "  Nio — opencode Plugin Setup"
echo "  ============================================="
echo "  opencode home: $OC_HOME"
echo ""

if ! command -v node &>/dev/null; then
  echo "  ERROR: Node.js is not installed. Nio requires Node.js >= $MIN_NODE_VERSION."
  exit 1
fi
NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt "$MIN_NODE_VERSION" ]; then
  echo "  ERROR: Node.js v$(node -v) is too old. Nio requires >= $MIN_NODE_VERSION."
  exit 1
fi

if [ "$UNINSTALL" -eq 1 ]; then
  echo "  Uninstalling Nio (opencode)..."
  rm -f  "$OC_HOME/plugins/nio.js"  2>/dev/null && echo "  Removed plugin"  || true
  # Only remove the ESM sentinel if WE wrote it (marker present).
  if [ -f "$OC_HOME/plugins/.nio-esm-sentinel" ]; then
    rm -f "$OC_HOME/plugins/package.json" "$OC_HOME/plugins/.nio-esm-sentinel" 2>/dev/null \
      && echo "  Removed ESM sentinel" || true
  fi
  rm -f  "$OC_HOME/commands/nio.md" 2>/dev/null && echo "  Removed command" || true
  rm -rf "$OC_HOME/skills/nio"      2>/dev/null && echo "  Removed skill"   || true
  for s in $FOCUSED_SKILLS; do
    rm -rf "${OC_HOME:?}/skills/$s" 2>/dev/null || true
  done
  rm -rf "$NIO_DIR" 2>/dev/null && echo "  Removed config" || true
  echo ""
  echo "  Nio has been uninstalled."
  echo ""
  exit 0
fi

echo "[1/4] Installing plugin..."
mkdir -p "$OC_HOME/plugins"
rm -f "$OC_HOME/plugins/nio.js"
cp "$SCRIPT_DIR/plugins/nio.js" "$OC_HOME/plugins/nio.js"
# ESM sentinel: opencode imports the bundle directly, and the install dir
# has no ESM-declaring ancestor package.json.
#
# AMENDED (Task 11 review, human ruling): $OC_HOME/plugins/ is opencode's
# SHARED plugin directory, not Nio-exclusive. Writing {"type":"module"}
# there flips any sibling CJS plugin that has no package.json of its own,
# and the breakage would outlive uninstalling Nio. So: only write the
# sentinel when we are the only plugin in the directory, mark that we own
# it, and remove it on uninstall. When siblings exist, skip and warn.
OC_SENTINEL="$OC_HOME/plugins/package.json"
OC_SENTINEL_MARKER="$OC_HOME/plugins/.nio-esm-sentinel"
if [ -f "$SCRIPT_DIR/plugins/package.json" ] && [ ! -f "$OC_SENTINEL" ]; then
  # Any *.js / *.ts in the dir other than our own bundle is a sibling plugin.
  OC_SIBLINGS=$(find "$OC_HOME/plugins" -maxdepth 1 \
    \( -name '*.js' -o -name '*.ts' \) ! -name 'nio.js' 2>/dev/null | head -n 1)
  if [ -z "$OC_SIBLINGS" ]; then
    cp "$SCRIPT_DIR/plugins/package.json" "$OC_SENTINEL"
    : > "$OC_SENTINEL_MARKER"
  else
    echo "  WARN: other plugins present in $OC_HOME/plugins — skipping the"
    echo "        ESM sentinel so their module format is left untouched."
    echo "        If opencode fails to load nio.js, add a package.json"
    echo "        containing {\"type\": \"module\"} to that directory."
  fi
fi
echo "  OK: $OC_HOME/plugins/nio.js"

echo "[2/4] Installing /nio command..."
mkdir -p "$OC_HOME/commands"
cp "$SCRIPT_DIR/commands/nio.md" "$OC_HOME/commands/nio.md"
echo "  OK: $OC_HOME/commands/nio.md"

echo "[3/4] Installing skills..."
mkdir -p "$OC_HOME/skills"
for s in nio $FOCUSED_SKILLS; do
  if [ -d "$SCRIPT_DIR/skills/$s" ]; then
    rm -rf "${OC_HOME:?}/skills/$s"
    cp -r "$SCRIPT_DIR/skills/$s" "$OC_HOME/skills/$s"
  fi
done
echo "  OK: skills installed to $OC_HOME/skills"

echo "[4/4] Setting up configuration..."
mkdir -p "$NIO_DIR"
if [ -n "$NIO_CONFIG" ]; then
  echo "  Applying operator config: $NIO_CONFIG"
  if ! node "$SCRIPT_DIR/skills/nio/scripts/config-cli.js" import "$NIO_CONFIG"; then
    echo "  FAIL: config import rejected by /nio doctor — install aborted." >&2
    exit 1
  fi
  echo "  OK: Operator config applied"
elif [ "$RESET_CONFIG" -eq 1 ] || [ ! -f "$NIO_DIR/config.yaml" ]; then
  [ -f "$SCRIPT_DIR/config.default.yaml" ] && cp "$SCRIPT_DIR/config.default.yaml" "$NIO_DIR/config.yaml"
  [ "$RESET_CONFIG" -eq 1 ] && echo "  OK: Config reset to defaults" || echo "  OK: Default config written"
else
  echo "  OK: Existing config kept"
fi

echo ""
echo "  Nio (opencode) is installed!"
echo ""
echo "  Restart opencode, then run:"
echo ""
echo "    /nio scan <path>"
echo ""
echo "  To uninstall: $(basename "$0") --uninstall"
echo ""
```

Make it executable: `chmod +x plugins/opencode/setup.sh`

- [ ] **Step 6: Verify the generated artefacts are ignored**

As with Pi, the root `.gitignore` already carries these entries:

```
plugins/opencode/plugins/nio.js
plugins/opencode/config.default.yaml
plugins/opencode/config.schema.json
plugins/opencode/README.md
```

Do **not** create `plugins/opencode/.gitignore`. Note that the ESM sentinel
`plugins/opencode/plugins/package.json` written by `writeEsmSentinel` **is**
tracked — matching the tracked `plugins/hermes/scripts/package.json`.

Confirm with:

```bash
git check-ignore -v plugins/opencode/plugins/nio.js plugins/opencode/config.default.yaml
git status --short plugins/opencode
```

Expected: both paths ignored; `git status` lists `setup.sh`, `commands/nio.md`,
`plugins/package.json`, and the synced `skills/` tree.

- [ ] **Step 7: Add the doctor probe**

Extend the "Platform Integrations" section added to `runDoctor()` in Task 7 Step 8. Append after the Pi lines, still before the `return`:

```ts
  // opencode — plugin + slash command are copied into the config dir.
  const ocRoot = process.env.XDG_CONFIG_HOME || join(home, '.config');
  const ocPlugin = existsSync(join(ocRoot, 'opencode', 'plugins', 'nio.js'));
  const ocCommand = existsSync(join(ocRoot, 'opencode', 'commands', 'nio.md'));
  if (ocPlugin && ocCommand) {
    out.push('- ✓ opencode: plugin + /nio command installed');
  } else if (ocPlugin || ocCommand) {
    out.push(`- ~ opencode: partial install (plugin: ${ocPlugin ? 'yes' : 'no'}, command: ${ocCommand ? 'yes' : 'no'})`);
    out.push('    hint: re-run plugins/opencode/setup.sh to repair.');
  } else {
    out.push('- · opencode: not installed (run plugins/opencode/setup.sh to enable)');
  }
```

Same rule as the Pi probe: informational only, never `markFail`.

- [ ] **Step 8: Build and verify end to end**

```bash
pnpm run build && pnpm test && pnpm typecheck
test -f plugins/opencode/plugins/nio.js && echo "bundle OK"
test -f plugins/opencode/skills/nio/SKILL.md && echo "umbrella skill OK"
test -f plugins/opencode/skills/nio-scan/SKILL.md && echo "focused skill OK"
test -f plugins/opencode/commands/nio.md && echo "command OK"
pnpm release:opencode && ls -la releases/
```

- [ ] **Step 9: Sandbox install smoke test**

```bash
TMP_OC=$(mktemp -d)
NIO_HOME=$(mktemp -d) bash plugins/opencode/setup.sh --opencode-home "$TMP_OC"
find "$TMP_OC" -maxdepth 2 -type f | sort
NIO_HOME=$(mktemp -d) bash plugins/opencode/setup.sh --opencode-home "$TMP_OC"   # idempotency
find "$TMP_OC" -maxdepth 2 -type f | sort                                        # identical listing
NIO_HOME=$(mktemp -d) bash plugins/opencode/setup.sh --opencode-home "$TMP_OC" --uninstall
find "$TMP_OC" -type f | sort                                                    # nio files gone
```

AMENDED (Task 11 review, human ruling) — the sentinel now has three cases
that must each be exercised by hand in a temp dir. `XDG_CONFIG_HOME` must be
cleared and `NIO_HOME` must be a `mktemp -d` for every invocation.

```bash
# Case A — clean dir: sentinel written, ownership marker written,
#          uninstall removes both.
TMP_A=$(mktemp -d)
NIO_HOME=$(mktemp -d) bash plugins/opencode/setup.sh --opencode-home "$TMP_A"
test -f "$TMP_A/plugins/package.json"      && echo "A: sentinel written"
test -f "$TMP_A/plugins/.nio-esm-sentinel" && echo "A: marker written"
NIO_HOME=$(mktemp -d) bash plugins/opencode/setup.sh --opencode-home "$TMP_A" --uninstall
test ! -f "$TMP_A/plugins/package.json"      && echo "A: sentinel removed"
test ! -f "$TMP_A/plugins/.nio-esm-sentinel" && echo "A: marker removed"

# Case B — sibling CJS plugin present: sentinel SKIPPED, warning printed,
#          the sibling's module format is left as it was.
TMP_B=$(mktemp -d); mkdir -p "$TMP_B/plugins"; : > "$TMP_B/plugins/other.js"
NIO_HOME=$(mktemp -d) bash plugins/opencode/setup.sh --opencode-home "$TMP_B" | grep -q 'WARN: other plugins present' \
  && echo "B: warned"
test ! -f "$TMP_B/plugins/package.json"      && echo "B: sentinel skipped"
test ! -f "$TMP_B/plugins/.nio-esm-sentinel" && echo "B: no marker"

# Case C — a package.json we do NOT own is never touched, not even on uninstall.
TMP_C=$(mktemp -d); mkdir -p "$TMP_C/plugins"
echo '{"name":"someone-else"}' > "$TMP_C/plugins/package.json"
NIO_HOME=$(mktemp -d) bash plugins/opencode/setup.sh --opencode-home "$TMP_C"
NIO_HOME=$(mktemp -d) bash plugins/opencode/setup.sh --opencode-home "$TMP_C" --uninstall
grep -q 'someone-else' "$TMP_C/plugins/package.json" && echo "C: foreign manifest intact"
```

- [ ] **Step 10: Commit**

```bash
git add plugins/opencode scripts/build.js scripts/sync-shared.js scripts/release.js \
        package.json src/adapters/openclaw-dispatch.ts
git commit -m "feat(opencode): add plugin package, installer, and release pipeline

opencode has no plugin-install CLI, so setup.sh does an idempotent
nuke + copy into the config dir. Plugin discovery is confirmed by
opencode's config/plugin.ts glob over {plugin,plugins}/*.{ts,js}."
```

---

## Phase D — Verification and documentation

### Task 12: E2E documents, repo docs, and changeset

**Files:**
- Create: `e2e-test/pi-trace-e2e-task.md`
- Create: `e2e-test/opencode-trace-e2e-task.md`
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/COLLECTOR-SIGNALS.md`
- Modify: `plugins/shared/skills/nio/SKILL.md`
- Modify: `setup.sh` (repo root)
- Modify: `install.sh`
- Create: `.changeset/<name>.md`

**Interfaces:**
- Consumes: everything built in Tasks 1–11.
- Produces: no code interfaces — documentation and release metadata only.

- [ ] **Step 1: Write the Pi e2e document**

Create `e2e-test/pi-trace-e2e-task.md`, following the structure of `e2e-test/openclaw-trace-e2e-task.md`. It must cover, in order:

1. **Sandbox setup** — `export NIO_HOME=$(mktemp -d)` and `PI_HOME=$(mktemp -d)`; never touch `~/.nio` or `~/.pi`.
2. **Install** — `bash plugins/pi/setup.sh --pi-home "$PI_HOME"`; verify `settings.json` gained exactly one nio `extensions` entry and one `skills` entry.
3. **Collector config** — write an OTLP endpoint into `$NIO_HOME/config.yaml` pointing at the local collector used by the other e2e docs.
4. **Allow path** — ask pi to run a benign `bash` command; confirm `audit.jsonl` gained a row with `decision: allow` and `platform: pi`, and that a tool span appears as a child of the turn root span carrying `nio.guard.decision = allow`.
5. **Deny path** — ask pi to run a command matching a dangerous rule; confirm pi reports the block, `audit.jsonl` shows `decision: deny`, and an orphan tool span was still emitted with the guard-error status (the post-side `tool_result` never fires for a blocked call).
6. **Confirm path** — set `guard.confirm_action: ask`, trigger a `confirm` verdict, and verify a real dialog appears; answer no and confirm the span records `confirm_denied`. Then re-run with `pi -p` (print mode, `ctx.hasUI === false`) and confirm it folds to the two-state behaviour without hanging.
7. **`user_bash` audit-only** — type `!rm -rf /tmp/nio-e2e-nonexistent`; confirm an audit row with `lifecycle_type: user_bash` and `actor: user` appears **and that the command was not blocked**.
8. **`/nio` command** — run `/nio scan <path>` and `/nio report`; confirm output renders and that the command did **not** go through the LLM (no assistant message is generated for it).
9. **MCP note** — run `/nio doctor`; confirm it prints the "Pi does not support MCP" line.
10. **Teardown** — `bash plugins/pi/setup.sh --pi-home "$PI_HOME" --uninstall`; confirm `settings.json` has no nio entries left.

- [ ] **Step 2: Write the opencode e2e document**

Create `e2e-test/opencode-trace-e2e-task.md` with the same sandbox discipline (`NIO_HOME=$(mktemp -d)`, `--opencode-home $(mktemp -d)`), covering install, allow path, deny path, `/nio` command, `/nio doctor`, and teardown — plus the two mandatory measurements from design spec §4.4 and §7.5:

11. **Denial presentation (mandatory measurement)** — trigger a deny and record *verbatim* how the `NioBlockedError` message reaches the model and the user: does the reason text survive, is it labelled as a tool error, does the session continue normally? Write the observed output into the document as the expected result. If the presentation is unusable, note it explicitly as a follow-up rather than papering over it.
12. **Span reclamation on tool error (mandatory measurement)** — make a tool fail on its own (for example `bash` with a command that exits non-zero in a way opencode surfaces as a thrown tool error), confirm `tool.execute.after` did **not** fire, and confirm the pending span was still closed by the `session.idle` flush. This is the scenario the design flags as opencode-specific.

- [ ] **Step 3: Update `CLAUDE.md`**

In the "Project Structure" section, add two entries after the `plugins/codex/` entry, matching the existing entries' level of detail:

- `plugins/pi/` — Pi extension. The release zip is itself a valid pi package (`package.json` with the `pi` manifest key and the `pi-package` keyword), so `setup.sh` prefers `pi install "$SCRIPT_DIR"` and falls back to copying the bundle into `~/.pi/agent/extensions/nio/` plus an explicit path entry in `settings.json`. Subscribes `tool_call` (blocking) / `tool_result` / `input` / `session_start` / `session_shutdown` / `agent_end` / `message_end` / `user_bash`. `/nio` is a real slash command via `pi.registerCommand`, bypassing the LLM. Pi is the only platform with an interactive channel, so a `confirm` verdict opens a real `ctx.ui.confirm` dialog with a timeout. **Pi has no MCP and no subagent concept** — the Phase 0 MCP gate is inactive and no Task spans are emitted. Adapter at `src/adapters/pi.ts`; binding at `src/adapters/pi-plugin.ts`.
- `plugins/opencode/` — opencode plugin. No plugin-install CLI exists, so `setup.sh` does an idempotent nuke + copy into `~/.config/opencode/` (`plugins/nio.js`, `commands/nio.md`, `skills/`). Hooks: `tool.execute.before` (throws `NioBlockedError` to block) / `tool.execute.after` / `chat.message` / `permission.ask` / `event` / `dispose`. No plugin API for slash commands, so `/nio` is a `commands/nio.md` template that instructs the model to call the plugin-registered `nio_command` tool. MCP tool names are `<sanitize(server)>_<sanitize(tool)>`, handled by the two-tier `opencode` branch in `parseMcpToolName`. Adapter at `src/adapters/opencode.ts`; binding at `src/adapters/opencode-plugin.ts`.

Also update the "Skill" section note about focused skills — the current text says "**Claude Code + Codex only**". Change it to "**Claude Code, Codex, Pi, and opencode**" and adjust the parenthetical to "(OpenClaw/Hermes keep the unified `/nio`)".

Update the Build section: `scripts/build.js` now also bundles `plugins/pi/extensions/nio/index.js` and `plugins/opencode/plugins/nio.js`; `sync-shared.js` now syncs skills to six plugin dirs. Update the Release section with `pnpm run release:pi` and `pnpm run release:opencode`.

Update the Configuration section's `native_tool_mapping` sample to include the `pi` and `opencode` rows.

- [ ] **Step 4: Update `README.md`, `docs/ARCHITECTURE.md`, `docs/COLLECTOR-SIGNALS.md`**

- `README.md` — add Pi and opencode to the supported-platform list and the install instructions, matching the existing per-platform sections.
- `docs/ARCHITECTURE.md` — document the new `InProcessPluginRuntime` layer and that OpenClaw, Pi, and opencode all sit on top of it, in contrast to the subprocess hook model used by Claude Code and Codex.
- `docs/COLLECTOR-SIGNALS.md` — add Pi and opencode columns/rows to the signal-coverage matrix. Record honestly what each platform cannot provide: Pi has no subagent spans; opencode's `tool.execute.after` does not fire for tools that throw, so those spans are reclaimed at `session.idle` rather than closed precisely.

- [ ] **Step 5: Update `plugins/shared/skills/nio/SKILL.md`**

Add Pi and opencode wherever the file enumerates supported platforms. Remember this is the source of truth — never edit the synced copies.

Then run `node scripts/sync-shared.js`.

- [ ] **Step 6: Update the root installers**

In the repo-root `setup.sh` and `install.sh`, add Pi and opencode to the platform detection and dispatch, following exactly how the existing four platforms are detected and invoked (Pi: presence of `~/.pi/agent` or a `pi` binary on PATH; opencode: presence of `~/.config/opencode` or an `opencode` binary on PATH).

- [ ] **Step 7: Add a changeset**

Create `.changeset/pi-opencode-support.md`:

```markdown
---
"@core0-io/nio": minor
---

Add Pi and opencode platform support

Full feature parity with the existing platforms: guard Phase 0-6, OTEL
traces/metrics/logs, audit log, the `/nio` skill surface with the six
focused skills, an idempotent installer, and a per-platform release zip.

Both platforms load Nio as an in-process plugin, so the platform-agnostic
part of the OpenClaw plugin was extracted into a shared
`InProcessPluginRuntime` that all three now share.

Pi is the first platform where a `confirm` verdict opens a real
interactive dialog rather than folding to `guard.confirm_action`.
```

- [ ] **Step 8: Full verification**

```bash
node scripts/sync-shared.js
pnpm run build && pnpm test && pnpm typecheck
pnpm release   # builds every platform zip
ls -la releases/
```

Expected: all green; `releases/` contains `nio-claude-code-*`, `nio-codex-*`, `nio-openclaw-*`, `nio-hermes-*`, `nio-pi-*`, `nio-opencode-*`, and `nio-all-*`.

- [ ] **Step 9: Commit**

```bash
git add e2e-test CLAUDE.md README.md docs/ARCHITECTURE.md docs/COLLECTOR-SIGNALS.md \
        plugins/ setup.sh install.sh .changeset
git commit -m "docs(pi,opencode): add e2e task documents and platform documentation

Both e2e documents carry mandatory empirical measurements: opencode's
denial-message presentation (which cannot be determined statically
because plugin.trigger wraps hooks in Effect.promise) and its span
reclamation when a tool throws and skips tool.execute.after."
```

---

## Post-Plan Verification

After Task 12, run the complete acceptance checklist from design spec §9.4:

- [ ] `pnpm run build` succeeds
- [ ] `pnpm test` fully green
- [ ] `pnpm typecheck` clean
- [ ] `bash plugins/pi/setup.sh --pi-home $(mktemp -d)` installs idempotently; `--uninstall` removes cleanly
- [ ] `bash plugins/opencode/setup.sh --opencode-home $(mktemp -d)` installs idempotently; `--uninstall` removes cleanly
- [ ] `/nio doctor` correctly reports install state on both platforms, including the "Pi has no MCP" note
- [ ] `e2e-test/openclaw-trace-e2e-task.md` still passes unchanged (the Task 4 regression gate)
- [ ] `e2e-test/pi-trace-e2e-task.md` passes
- [ ] `e2e-test/opencode-trace-e2e-task.md` passes, with both mandatory measurements recorded in the document
