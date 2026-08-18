#!/usr/bin/env node
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Nio PreToolUse / PostToolUse Hook (Claude Code + Codex CLI)
 *
 * Reads hook input from stdin, delegates to evaluateHook(), and outputs
 * allow / deny / ask via the Claude Code protocol (which Codex also
 * accepts — both treat exit 2 as deny + stderr as reason). Selects the
 * platform adapter via `--platform <name>` (default: claude-code).
 *
 * Usage:
 *   node guard-hook.js                      # claude-code (default)
 *   node guard-hook.js --platform codex     # codex CLI
 *
 * PreToolUse exit codes:
 *   0  = allow (or JSON with permissionDecision)
 *   2  = deny  (stderr = reason shown to the agent)
 *
 * PostToolUse: appends audit log entry (async, always exits 0)
 */

import { loadCollectorConfig } from './lib/config-loader.js';
import { createMeterProvider, recordGuardDecision } from './lib/metrics-collector.js';
import { createLoggerProvider } from './lib/logs-collector.js';
import {
  createTracerProvider,
  ensureTurn,
  nioGuardAttributes,
  recordPreToolUse,
  recordPostToolUse,
  genAiToolCallInputAttributes,
  setPendingGuardAttrs,
} from './lib/traces-collector.js';
import { loadState, saveState } from './lib/traces-state-store.js';
import { reportFlushFailure } from './lib/exporter-diagnostics.js';
import { createFlushBudget } from './lib/flush-budget.js';
import { isSessionMonitored } from './lib/monitor-check.js';
import { spanKey, toolSummary, type HookStdinPayload } from './lib/collector-core.js';
import { asText } from '../adapters/common.js';
import { createNio, ClaudeCodeAdapter, CodexAdapter, evaluateHook, loadConfig } from '../index.js';
import type { HookAdapter } from '../index.js';
import { formatDiagnosticsForUser, type Diagnostic } from '../adapters/diagnostics.js';

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}
const PLATFORM = getArg('platform') ?? 'claude-code';
const PLATFORM_KEY = PLATFORM.replace(/-/g, '_');

// ---------------------------------------------------------------------------
// Read stdin
// ---------------------------------------------------------------------------

function readStdin(): Promise<unknown> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => (data += chunk));
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(null);
      }
    });
    setTimeout(() => resolve(null), 5000);
  });
}

// ---------------------------------------------------------------------------
// Claude Code output helpers
// ---------------------------------------------------------------------------

function appendDiagnostics(reason: string, diagnostics?: readonly Diagnostic[]): string {
  if (!diagnostics || diagnostics.length === 0) return reason;
  return `${reason}\n\n${formatDiagnosticsForUser(diagnostics)}`;
}

function outputDeny(reason: string, diagnostics?: readonly Diagnostic[]): never {
  process.stderr.write(appendDiagnostics(reason, diagnostics) + '\n');
  process.exit(2);
}

function outputAsk(reason: string, diagnostics?: readonly Diagnostic[]): never {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: appendDiagnostics(reason, diagnostics),
    },
  }));
  process.exit(0);
}

function outputAllow(diagnostics?: readonly Diagnostic[]): never {
  // No diagnostics → exit silently (current behaviour preserved).
  // Diagnostics present → emit hookSpecificOutput.additionalContext so the
  // agent sees the failure without us having to block the action.
  if (diagnostics && diagnostics.length > 0) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: formatDiagnosticsForUser(diagnostics),
      },
    }));
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const input = await readStdin();
  if (!input) {
    process.exit(0);
  }

  const config = loadConfig();
  const nativeToolMapping = config.guard?.native_tool_mapping?.[PLATFORM_KEY];
  const adapter: HookAdapter = PLATFORM === 'codex'
    ? new CodexAdapter({ nativeToolMapping })
    : new ClaudeCodeAdapter({ nativeToolMapping });
  const nio = createNio();

  // Set up OTEL providers for metrics + audit logs + traces
  const collectorConfig = loadCollectorConfig();
  const resourceAgentName = config.agent_name && config.agent_name.length > 0
    ? config.agent_name
    : undefined;
  const logsConfig = config.collector?.logs;

  // Gate telemetry export behind the session's monitor state.
  //
  // Two things deliberately stay outside the gate:
  //   1. evaluateHook below runs unconditionally — enforcement is
  //      orthogonal to capture. An unmonitored session still gets its
  //      dangerous commands blocked.
  //   2. Local audit writes continue — evaluateHook writes those via
  //      `logsConfig`, not via `loggerProvider`, so nulling the provider
  //      stops OTLP export without touching ~/.nio/audit.jsonl.
  const gatePayload = input as Record<string, unknown>;
  const monitored = isSessionMonitored(
    (gatePayload['session_id'] as string) ?? 'unknown',
    (gatePayload['cwd'] as string) ?? null,
    logsConfig,
  );

  const meterProvider = monitored
    ? createMeterProvider(collectorConfig, PLATFORM, resourceAgentName)
    : null;
  const tracerProvider = (monitored && collectorConfig.enabled)
    ? createTracerProvider(collectorConfig, PLATFORM, resourceAgentName)
    : null;
  const loggerProvider = (monitored && logsConfig?.enabled !== false)
    ? createLoggerProvider(collectorConfig, PLATFORM, resourceAgentName)
    : null;

  // Time the guard evaluation so we can stamp it onto the tool span
  // as `nio.guard.eval_ms` (and use the start time for the deny-path
  // span's wall-clock so it reflects the actual evaluation window).
  const evalStartMs = Date.now();
  const result = await evaluateHook(
    adapter, input, { config, nio },
    { loggerProvider, logsConfig },
  );
  const evalMs = Date.now() - evalStartMs;

  // Record guard decision metrics
  const payload = (input as HookStdinPayload | Record<string, unknown>);
  // `asText`, not `as string`. A SECOND, independent read of the raw
  // stdin payload — the adapter's own coercion never touches it — feeding
  // a metric attribute and the `toolSummary` switch below, both of which
  // run AFTER `evaluateHook` has decided and BEFORE the decision is
  // written. Defence in depth rather than a load-bearing fix: every path
  // it feeds is already total on its own (`toolSummary` coerces), so no
  // input distinguishes this line from the `as string` it replaced.
  const toolName = asText((payload as Record<string, unknown>).tool_name);

  // One shared budget covers EVERY OTLP-touching await between here and
  // the decision write — not just the closing Promise.all. The library
  // helpers below (`recordGuardDecision`, `recordPostToolUse`) each end
  // with their own internal `provider.forceFlush()`, so bounding only the
  // final flush leaves the earlier ones free to block for the full OS TCP
  // connect timeout. See lib/flush-budget.ts for the measured numbers.
  const withFlushBudget = createFlushBudget(collectorConfig.timeout);

  if (meterProvider) {
    await withFlushBudget(
      recordGuardDecision(
        meterProvider,
        result.decision,
        result.riskLevel || 'low',
        result.riskScore ?? 0,
        toolName,
      ).catch(e => reportFlushFailure('metrics', collectorConfig.endpoint, e)),
      undefined,
    );
  }

  // Resolve final decision taking `guard.confirm_action` into account
  // (so the value carried on traces matches what actually happens to
  // the tool call, not the raw orchestrator decision).
  const confirmAction = config.guard?.confirm_action ?? 'ask';
  const resolvedDecision =
    result.decision === 'deny' ? 'deny'
    : result.decision === 'ask'
      ? (confirmAction === 'allow' ? 'confirm_allowed'
        : confirmAction === 'deny'  ? 'confirm_denied'
        : 'ask')
      : 'allow';
  const isBlock = resolvedDecision === 'deny' || resolvedDecision === 'confirm_denied';

  // Bridge guard attrs from this PreToolUse process (guard-hook) over
  // to the collector-hook PostToolUse process via the on-disk state
  // file. Done on every decision so allow spans also carry nio.guard.*.
  // PostToolUse invocations of this same script must NOT write — the
  // span is already closing in the collector by then.
  const hookEventName = (payload as Record<string, unknown>).hook_event_name as string | undefined;
  const guardAttrs: Record<string, unknown> = {
    ...nioGuardAttributes(
      resolvedDecision,
      result.riskLevel || 'low',
      result.riskScore ?? 0,
      result.riskTags,
      result.phaseStopped,
      result.topFindingRule,
    ),
    'nio.guard.eval_ms': evalMs,
  };
  if (tracerProvider && hookEventName === 'PreToolUse') {
    const sessionId = (payload as Record<string, unknown>).session_id as string || 'unknown';
    const key = spanKey(payload as HookStdinPayload);
    let state = ensureTurn(loadState(logsConfig), sessionId);
    state = setPendingGuardAttrs(state, key, guardAttrs);

    // Block path: PostToolUse will never fire → no one will close the
    // tool span via the normal collector pipeline. Emit a complete
    // one-shot span here (open + close + export) so the blocked call is
    // visible in traces. Wall-clock = real evaluation window.
    if (isBlock) {
      const cwd = (payload as Record<string, unknown>).cwd as string ?? process.cwd();
      const toolInput = ((payload as Record<string, unknown>).tool_input ?? {}) as Record<string, unknown>;
      const tool_use_id = (payload as Record<string, unknown>).tool_use_id as string | undefined;
      const summary = toolSummary(toolName, toolInput);
      state = recordPreToolUse(
        state, key, toolName, summary,
        genAiToolCallInputAttributes(toolInput, tool_use_id),
        evalStartMs,
      );
      const reason = result.reason || (resolvedDecision === 'deny' ? 'Blocked by Nio' : 'Requires confirmation (Nio)');
      // Budgeted like every other OTLP-touching await here: this call
      // ends in `provider.forceFlush()`. On timeout `state` keeps the
      // value it had before the call, so `saveState` below still runs
      // rather than the whole hook stalling on an unreachable endpoint.
      const r = await withFlushBudget(
        recordPostToolUse(
          tracerProvider, state, key, cwd,
          guardAttrs,
          reason,
        ).catch(e => {
          reportFlushFailure('traces', collectorConfig.endpoint, e);
          return null;
        }),
        null,
      );
      if (r) state = r.state;
    }

    saveState(logsConfig, state);
  }

  // Flush OTEL providers before exit, sharing the deadline above so an
  // unreachable endpoint can't hold the PreToolUse decision hostage.
  // Each flush carries its own .catch(): an unhandled rejection here
  // would reject the Promise.all and abort main() before the decision is
  // ever written.
  await withFlushBudget(
    Promise.all([
      meterProvider?.forceFlush().catch(e => reportFlushFailure('metrics', collectorConfig.endpoint, e)),
      tracerProvider?.forceFlush().catch(e => reportFlushFailure('traces', collectorConfig.endpoint, e)),
      loggerProvider?.forceFlush().catch(e => reportFlushFailure('logs', collectorConfig.endpoint, e)),
    ]).then(() => undefined),
    undefined,
  );

  const diags = result.diagnostics;

  if (result.decision === 'deny') outputDeny(result.reason || 'Action blocked', diags);
  else if (result.decision === 'ask') {
    if (confirmAction === 'deny') outputDeny(result.reason || 'Action requires confirmation', diags);
    else if (confirmAction === 'allow') outputAllow(diags);
    else outputAsk(result.reason || 'Action requires confirmation', diags);
  }
  else outputAllow(diags);
}

main();
