#!/usr/bin/env node
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Nio Hook CLI — cross-process dispatcher for Hermes shell-hooks.
 *
 * Routes the JSON envelope (stdin or --envelope) into one of two
 * pipelines based on the event name:
 *   pre_tool_call → guard path (Phase 0–6 + audit)
 *   anything else → collector path (lib/collector-core)
 *
 * Hermes spawns this script for every event declared in
 * ~/.hermes/config.yaml; one shared command string handles all events
 * because dispatch keys off stdin's hook_event_name field, not CLI
 * arguments. Hermes's snake_case event names are translated to the
 * canonical Claude-Code-shaped names the collector core expects.
 *
 * Usage:
 *   node hook-cli.js --platform hermes --stdin
 *   node hook-cli.js --platform hermes --envelope '<json>'
 *
 * Output (Hermes wire-shape per agent/shell_hooks.py::_parse_response):
 *   pre_tool_call deny  → {"decision":"block","reason":"..."}
 *   pre_tool_call allow → {} (silent)
 *   pre_tool_call ask   → folded through guard.confirm_action
 *                         (allow → {}, deny → block, ask → block + warn)
 *   collector events    → {} (telemetry never blocks)
 *
 * Failure handling: malformed JSON / missing flags exit 1 with empty
 * stdout. Hermes treats non-zero exits and missing stdout as no-action
 * (fail-open per upstream spec).
 */

import { createNio, HermesAdapter, evaluateHook, loadConfig } from '../index.js';
import type { HookAdapter, HookOutput } from '../index.js';
import { formatDiagnosticsForUser } from '../adapters/diagnostics.js';
import { loadCollectorConfig } from './lib/config-loader.js';
import { createMeterProvider, recordGuardDecision } from './lib/metrics-collector.js';
import {
  createTracerProvider,
  ensureTurn,
  nioGuardAttributes,
  recordPostToolUse,
  setPendingGuardAttrs,
} from './lib/traces-collector.js';
import { loadState, saveState } from './lib/traces-state-store.js';
import { createLoggerProvider } from './lib/logs-collector.js';
import { reportFlushFailure } from './lib/exporter-diagnostics.js';
import { isSessionMonitored } from './lib/monitor-check.js';
import { dumpPayload } from './lib/payload-dump.js';
import {
  dispatchCollectorEvent,
  spanKey,
  type HookStdinPayload,
} from './lib/collector-core.js';

// ── CLI arg parsing ─────────────────────────────────────────────────────

const argv = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

function hasFlag(name: string): boolean {
  return argv.includes(`--${name}`);
}

function printUsage(): never {
  console.error(`Usage: hook-cli.js --platform <name> (--stdin | --envelope '<json>')

Options:
  --platform <name>   Platform adapter (supported: hermes)
  --stdin             Read JSON envelope from stdin (preferred for Hermes)
  --envelope <json>   Pass JSON envelope as a CLI arg (testing convenience)

Examples:
  echo '{...}' | node hook-cli.js --platform hermes --stdin
  node hook-cli.js --platform hermes --envelope '{...}'`);
  process.exit(1);
}

// ── Stdin reader ────────────────────────────────────────────────────────

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf));
    // Fail-open safety net: if the parent never closes stdin, don't hang.
    setTimeout(() => resolve(buf), 5_000).unref();
  });
}

// ── Platform adapter selection ──────────────────────────────────────────

function selectAdapter(
  platform: string,
  config: ReturnType<typeof loadConfig>,
): HookAdapter {
  switch (platform) {
    case 'hermes':
      return new HermesAdapter({
        nativeToolMapping: config.guard?.native_tool_mapping?.hermes,
      });
    default:
      console.error(
        `Error: unsupported --platform '${platform}' (supported: hermes)`,
      );
      process.exit(1);
  }
}

// ── Hermes → canonical event-name translation (collector path) ─────────
//
// Maps Hermes's snake_case lifecycle events onto the canonical Claude-
// Code-shaped names that lib/collector-core.ts dispatches on.
// pre_tool_call is intentionally NOT here — guard path handles it.

const HERMES_COLLECTOR_EVENTS: Record<string, string> = {
  post_tool_call: 'PostToolUse',
  pre_llm_call: 'UserPromptSubmit',
  post_llm_call: 'Stop',
  on_session_start: 'SessionStart',
  on_session_end: 'SessionEnd',
  subagent_stop: 'SubagentStop',
};

/**
 * Convert a Hermes-shaped envelope into the HookStdinPayload the
 * collector core consumes. Hermes places event-specific fields
 * (user message, tool result, task id) inside the `extra` object;
 * we lift the ones the dispatcher recognises.
 */
function hermesToCollectorInput(
  raw: unknown,
  canonicalEvent: string,
): HookStdinPayload {
  const r = (raw ?? {}) as Record<string, unknown>;
  const extra = (r.extra ?? {}) as Record<string, unknown>;
  // `||`, not `??`. Hermes never omits `session_id` — its
  // `_serialize_payload` writes
  // `kwargs.get("session_id") or kwargs.get("parent_session_id") or ""`,
  // so a call site that had no session sends the *empty string*, not
  // `undefined`. That is not hypothetical: `tools/code_execution_tool.py`
  // dispatches `handle_function_call(tool_name, tool_args, task_id=...)`
  // with no `session_id`, so every tool invoked from inside the
  // code-execution sandbox fires `pre_tool_call` / `post_tool_call` with
  // `session_id: ""` (verified against the installed Hermes agent).
  //
  // Under `??` the empty string is a "present" value, so the
  // parent_session_id recovery below could never fire — it was dead code.
  // Matching Hermes's own `or` semantics makes it reachable.
  //
  // When nothing is recoverable the id stays `''`, which
  // `UNTRUSTED_SESSION_IDS` rejects: no OTLP export for that event. That
  // fail-closed outcome is deliberate and identical on all four
  // platforms (Claude Code / Codex `?? 'unknown'`, OpenClaw
  // `|| 'openclaw'`) — a placeholder id shared by every id-less event
  // would arm every such event globally the moment one user armed one
  // session. The local audit entry is still written either way.
  const sessionId =
    (r.session_id as string | undefined) ||
    (extra.parent_session_id as string | undefined) ||
    '';

  const input: HookStdinPayload = {
    hook_event_name: canonicalEvent,
    session_id: sessionId,
    cwd: r.cwd as string | undefined,
    tool_name: r.tool_name as string | undefined,
    tool_input: r.tool_input as Record<string, unknown> | undefined,
    tool_use_id: extra.tool_call_id as string | undefined,
    task_id: extra.task_id as string | undefined,
  };

  if (canonicalEvent === 'UserPromptSubmit') {
    input.prompt =
      (extra.user_message as string | undefined) ??
      (r.prompt as string | undefined);
  } else if (canonicalEvent === 'PostToolUse') {
    const result = extra.result as unknown;
    if (typeof result === 'string') {
      input.tool_response = { output: result };
    } else if (result && typeof result === 'object') {
      input.tool_response = result as HookStdinPayload['tool_response'];
    }
  }

  return input;
}

/**
 * Run the collector pipeline for a non-guard Hermes event. Always emits
 * `{}` to Hermes stdout regardless of whether telemetry is enabled.
 */
async function runHermesCollector(
  rawPayload: unknown,
  hermesEvent: string,
): Promise<void> {
  const canonicalEvent = HERMES_COLLECTOR_EVENTS[hermesEvent];
  if (!canonicalEvent) return;

  const collectorConfig = loadCollectorConfig();
  const config = loadConfig();
  const logsConfig = config.collector?.logs;
  // Audit dispatch is kept on even when OTLP export is disabled so the
  // local audit.jsonl still gets hook-event entries. Only short-circuit
  // when both OTLP and local logging are off.
  if (!collectorConfig.enabled && logsConfig?.local === false) return;

  const resourceAgentName = config.agent_name && config.agent_name.length > 0
    ? config.agent_name
    : undefined;

  // Computed once, up front, so the monitor-gate lookup and the
  // dispatch below share the same parsed input instead of parsing the
  // raw Hermes envelope twice.
  const collectorInput = hermesToCollectorInput(rawPayload, canonicalEvent);
  const monitored = isSessionMonitored(
    collectorInput.session_id ?? 'unknown',
    collectorInput.cwd ?? null,
    logsConfig,
  );

  const meterProvider = (monitored && collectorConfig.enabled)
    ? createMeterProvider(collectorConfig, 'hermes', resourceAgentName) : null;
  const tracerProvider = (monitored && collectorConfig.enabled)
    ? createTracerProvider(collectorConfig, 'hermes', resourceAgentName) : null;
  const loggerProvider = (monitored && collectorConfig.enabled && logsConfig?.enabled !== false)
    ? createLoggerProvider(collectorConfig, 'hermes', resourceAgentName)
    : null;

  await dispatchCollectorEvent({
    event: canonicalEvent,
    input: collectorInput,
    platform: 'hermes',
    config: collectorConfig,
    meterProvider,
    tracerProvider,
    loggerProvider,
    logsConfig,
    // Hermes's conversation lives in the raw envelope, not in the
    // canonical payload above: `extra.conversation_history` is the only
    // place the LLM calls of this turn exist, and there is no transcript
    // file to read them back from. Passed on every event rather than
    // just `post_llm_call` — `createHermesSource` returns zero calls for
    // an envelope without a history, so a session_end or tool event
    // degrades to the same flat tree it produced before.
    conversationInput: { payload: rawPayload },
  });

  // Every hook-cli invocation is a fresh subprocess that exits right
  // after this returns. PeriodicExportingMetricReader batches metrics
  // on a 1s timer, and the HTTP exporter chunks requests — without an
  // explicit flush here the recorded metric/span/log can sit in-memory
  // and never reach OTLP before the process dies.
  await Promise.all([
    meterProvider?.forceFlush().catch(e => reportFlushFailure('metrics', collectorConfig.endpoint, e)),
    tracerProvider?.forceFlush().catch(e => reportFlushFailure('traces', collectorConfig.endpoint, e)),
    loggerProvider?.forceFlush().catch(e => reportFlushFailure('logs', collectorConfig.endpoint, e)),
  ]);
}

// ── Platform-specific stdout formatting ────────────────────────────────

interface FormattedOutput {
  stdout: string;
  stderr?: string;
}

/**
 * Translate Nio's three-valued HookOutput.decision into the binary
 * Hermes wire protocol, folding `ask` through `guard.confirm_action`.
 */
function formatHermesGuardOutput(
  result: HookOutput,
  confirmAction: string,
): FormattedOutput {
  const diagBlock = result.diagnostics?.length
    ? '\n\n' + formatDiagnosticsForUser(result.diagnostics)
    : '';

  if (result.decision === 'deny') {
    return {
      stdout: JSON.stringify({
        decision: 'block',
        reason: (result.reason || 'Blocked by Nio') + diagBlock,
      }),
    };
  }
  if (result.decision === 'allow') {
    // Hermes has no additionalContext channel; surface diagnostics on stderr
    // so they remain visible without changing the allow contract.
    return { stdout: '{}', stderr: diagBlock ? diagBlock.trim() : undefined };
  }
  // decision === 'ask' — Hermes has no confirmation channel.
  if (confirmAction === 'allow') {
    return { stdout: '{}', stderr: diagBlock ? diagBlock.trim() : undefined };
  }
  if (confirmAction === 'deny') {
    return {
      stdout: JSON.stringify({
        decision: 'block',
        reason: (result.reason || 'Action requires confirmation') + diagBlock,
      }),
    };
  }
  // confirmAction === 'ask' — nonsense on Hermes; fall back to deny.
  return {
    stdout: JSON.stringify({
      decision: 'block',
      reason: (result.reason || 'Action requires confirmation') + diagBlock,
    }),
    stderr:
      `guard.confirm_action: 'ask' not supported on Hermes (no confirmation channel); falling back to 'deny'`,
  };
}

// How long writeAndExit() waits for the stdout write callback before
// giving up and exiting anyway. Exists only to cover a closed/broken
// pipe (the callback would otherwise never fire, reintroducing the
// exact hang this function was added to prevent). The trade-off this
// buys: a payload larger than the OS pipe buffer (64KB on macOS) paired
// with a slow consumer on the other end could still be truncated if the
// write hasn't drained by the time this backstop fires. In practice
// Hermes payloads (a JSON decision + reason string) never approach that
// size, so this is a theoretical risk kept short (not removed) — the
// alternative, no backstop at all, is the worse failure mode.
const WRITE_CALLBACK_BACKSTOP_MS = 2000;

/**
 * Write the Hermes response and exit.
 *
 * An explicit exit is required: when the OTLP endpoint is configured but
 * unreachable, the meter provider's PeriodicExportingMetricReader keeps
 * its retry timer alive past forceFlush(), so the event loop never drains
 * and the process hangs forever. Exiting from the write callback (rather
 * than immediately after write()) guarantees the response reaches Hermes
 * first — stdout is a pipe here, so write() is not synchronous.
 */
function writeAndExit(payload: string): void {
  process.stdout.write(payload, () => process.exit(0));
  // Backstop: if the callback never fires (closed pipe), don't inherit
  // the very hang this function exists to prevent.
  setTimeout(() => process.exit(0), WRITE_CALLBACK_BACKSTOP_MS).unref();
}

// ── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const platform = getArg('platform');
  if (!platform) printUsage();

  let rawInput: string | undefined;
  if (hasFlag('stdin')) {
    rawInput = await readStdin();
  } else {
    rawInput = getArg('envelope');
  }

  if (!rawInput) {
    console.error('Error: provide either --stdin or --envelope <json>');
    process.exit(1);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawInput);
  } catch (err) {
    console.error(`Error: invalid JSON payload: ${(err as Error).message}`);
    process.exit(1);
  }

  const hookEventName = ((payload ?? {}) as Record<string, unknown>)
    .hook_event_name as string | undefined;

  // Debug-only sampling switch — dumps the full envelope once, ahead of
  // the guard-path / collector-path branch below, so both are covered by
  // this single call site. See lib/payload-dump.ts module doc for why
  // this is deliberately NOT behind the monitor gate either branch uses.
  dumpPayload(platform!, hookEventName ?? 'unknown', payload);

  // Guard path: only pre_tool_call runs through Phase 0–6.
  //
  // On Claude Code, PreToolUse fires both guard-hook.ts (Phase 0–6
  // + guard-decision metric) AND collector-hook.ts (tool-use counter
  // + pending_span state that post_tool_call later closes). Hermes
  // registers a single hook command string per event, so the guard
  // path here has to do both — otherwise post_tool_call can't find
  // a pending span and no tool span ever reaches OTLP.
  if (platform === 'hermes' && hookEventName === 'pre_tool_call') {
    const config = loadConfig();
    const nio = createNio();
    const adapter = selectAdapter(platform!, config);

    const collectorConfig = loadCollectorConfig();
    const resourceAgentName = config.agent_name && config.agent_name.length > 0
      ? config.agent_name
      : undefined;
    const logsConfig = config.collector?.logs;

    // Gate before creating any provider — an unmonitored session must
    // not get OTLP exporters, even though evaluateHook() and the
    // guard decision below still run unconditionally.
    const monitorInput = hermesToCollectorInput(payload, 'PreToolUse');
    const monitored = isSessionMonitored(
      monitorInput.session_id ?? 'unknown',
      monitorInput.cwd ?? null,
      logsConfig,
    );

    const meterProvider = (monitored && collectorConfig.enabled)
      ? createMeterProvider(collectorConfig, 'hermes', resourceAgentName) : null;
    const tracerProvider = (monitored && collectorConfig.enabled)
      ? createTracerProvider(collectorConfig, 'hermes', resourceAgentName) : null;
    // LoggerProvider sends guard decisions to OTLP /v1/logs — matches
    // the guard-hook.ts wiring on Claude Code. Without this, SigNoz's
    // "Logs" view stays empty for Hermes guard activity even though
    // metrics and traces flow correctly.
    const loggerProvider = (monitored && collectorConfig.enabled && logsConfig?.enabled !== false)
      ? createLoggerProvider(collectorConfig, 'hermes', resourceAgentName) : null;

    const evalStartMs = Date.now();
    const result = await evaluateHook(
      adapter, payload, { config, nio },
      { loggerProvider, logsConfig },
    );
    const evalMs = Date.now() - evalStartMs;

    const toolName = ((payload ?? {}) as Record<string, unknown>).tool_name as string || '';

    // Guard decision metric (nio.decision.count).
    if (meterProvider) {
      await recordGuardDecision(
        meterProvider,
        result.decision,
        result.riskLevel || 'low',
        result.riskScore ?? 0,
        toolName,
      );
    }

    // Also run the collector PreToolUse path so a pending_span is
    // saved AND nio.tool_use.count{event=PreToolUse}
    // is emitted, mirroring Claude Code's parallel hook chain.
    if (collectorConfig.enabled || logsConfig?.local !== false) {
      await dispatchCollectorEvent({
        event: 'PreToolUse',
        input: hermesToCollectorInput(payload, 'PreToolUse'),
        platform: 'hermes',
        config: collectorConfig,
        meterProvider,
        tracerProvider,
        loggerProvider,
        logsConfig,
      });
    }

    // Bridge guard attrs to the eventual PostToolUse span (allow path)
    // and synchronously close + emit the span for the block path —
    // mirrors what guard-hook does for Claude Code / Codex.
    const confirmAction = config.guard?.confirm_action ?? 'allow';
    const resolvedDecision =
      result.decision === 'deny' ? 'deny'
      : result.decision === 'ask'
        ? (confirmAction === 'allow' ? 'confirm_allowed'
          : confirmAction === 'deny'  ? 'confirm_denied'
          : 'confirm_denied')  // 'ask' fallback on hermes = deny
        : 'allow';
    const isBlock = resolvedDecision === 'deny' || resolvedDecision === 'confirm_denied';
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
    if (tracerProvider) {
      const collectorInput = hermesToCollectorInput(payload, 'PreToolUse');
      const sessionId = collectorInput.session_id ?? 'unknown';
      const key = spanKey(collectorInput);
      let state = ensureTurn(loadState(logsConfig), sessionId);
      state = setPendingGuardAttrs(state, key, guardAttrs);
      if (isBlock) {
        const cwd = collectorInput.cwd ?? process.cwd();
        const reason = result.reason || (resolvedDecision === 'deny' ? 'Blocked by Nio' : 'Requires confirmation (Nio)');
        const r = await recordPostToolUse(
          tracerProvider, state, key, cwd,
          guardAttrs,
          reason,
        );
        state = r.state;
      }
      saveState(logsConfig, state);
    }

    // Make sure network exports complete before the subprocess exits;
    // the PeriodicExportingMetricReader batches by default and would
    // drop the counter we just recorded without an explicit flush.
    await Promise.all([
      meterProvider?.forceFlush().catch(e => reportFlushFailure('metrics', collectorConfig.endpoint, e)),
      tracerProvider?.forceFlush().catch(e => reportFlushFailure('traces', collectorConfig.endpoint, e)),
      loggerProvider?.forceFlush().catch(e => reportFlushFailure('logs', collectorConfig.endpoint, e)),
    ]);

    const { stdout, stderr } = formatHermesGuardOutput(result, confirmAction);
    if (stderr) process.stderr.write(stderr + '\n');
    writeAndExit(stdout + '\n');
    return;
  }

  // Collector path: post_*, on_session_*, subagent_stop, *_llm_call.
  if (platform === 'hermes' && hookEventName) {
    await runHermesCollector(payload, hookEventName);
    writeAndExit('{}\n');
    return;
  }

  // Future non-Hermes platforms or missing event_name: forward raw
  // HookOutput so existing guard-hook-style consumers still work.
  if (platform !== 'hermes') {
    const config = loadConfig();
    const nio = createNio();
    const adapter = selectAdapter(platform!, config);
    const result = await evaluateHook(adapter, payload, { config, nio });
    writeAndExit(JSON.stringify(result) + '\n');
    return;
  }

  // Hermes envelope without hook_event_name — silent no-op.
  writeAndExit('{}\n');
}

main().catch((err: Error) => {
  process.stderr.write(`hook-cli error: ${err.message}\n`);
  process.exit(1);
});
