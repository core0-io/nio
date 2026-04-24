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
import { loadCollectorConfig } from './lib/config-loader.js';
import { createMeterProvider, recordGuardDecision } from './lib/metrics-collector.js';
import { createTracerProvider } from './lib/traces-collector.js';
import { createLoggerProvider } from './lib/logs-collector.js';
import {
  dispatchCollectorEvent,
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
        guardedTools: config.guard?.guarded_tools?.hermes,
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
  const sessionId =
    (r.session_id as string | undefined) ??
    (extra.parent_session_id as string | undefined) ??
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
  if (!collectorConfig.enabled) return;

  const meterProvider = createMeterProvider(collectorConfig);
  const tracerProvider = createTracerProvider(collectorConfig);

  await dispatchCollectorEvent({
    event: canonicalEvent,
    input: hermesToCollectorInput(rawPayload, canonicalEvent),
    platform: 'hermes',
    config: collectorConfig,
    meterProvider,
    tracerProvider,
  });

  // Every hook-cli invocation is a fresh subprocess that exits right
  // after this returns. PeriodicExportingMetricReader batches metrics
  // on a 1s timer, and the HTTP exporter chunks requests — without an
  // explicit flush here the recorded metric/span can sit in-memory
  // and never reach OTLP before the process dies.
  await Promise.all([
    meterProvider?.forceFlush(),
    tracerProvider?.forceFlush(),
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
  if (result.decision === 'deny') {
    return {
      stdout: JSON.stringify({
        decision: 'block',
        reason: result.reason || 'Blocked by Nio',
      }),
    };
  }
  if (result.decision === 'allow') {
    return { stdout: '{}' };
  }
  // decision === 'ask' — Hermes has no confirmation channel.
  if (confirmAction === 'allow') {
    return { stdout: '{}' };
  }
  if (confirmAction === 'deny') {
    return {
      stdout: JSON.stringify({
        decision: 'block',
        reason: result.reason || 'Action requires confirmation',
      }),
    };
  }
  // confirmAction === 'ask' — nonsense on Hermes; fall back to deny.
  return {
    stdout: JSON.stringify({
      decision: 'block',
      reason: result.reason || 'Action requires confirmation',
    }),
    stderr:
      `guard.confirm_action: 'ask' not supported on Hermes (no confirmation channel); falling back to 'deny'`,
  };
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
    const meterProvider = collectorConfig.enabled
      ? createMeterProvider(collectorConfig) : null;
    const tracerProvider = collectorConfig.enabled
      ? createTracerProvider(collectorConfig) : null;
    // LoggerProvider sends guard decisions to OTLP /v1/logs — matches
    // the guard-hook.ts wiring on Claude Code. Without this, SigNoz's
    // "Logs" view stays empty for Hermes guard activity even though
    // metrics and traces flow correctly.
    const logsConfig = config.collector?.logs;
    const loggerProvider = (collectorConfig.enabled && logsConfig?.enabled !== false)
      ? createLoggerProvider(collectorConfig) : null;

    const result = await evaluateHook(
      adapter, payload, { config, nio },
      { loggerProvider, logsConfig },
    );

    // Guard decision metric (nio.decision.count).
    if (meterProvider) {
      const toolName = ((payload ?? {}) as Record<string, unknown>).tool_name as string || '';
      await recordGuardDecision(
        meterProvider,
        result.decision,
        result.riskLevel || 'low',
        result.riskScore ?? 0,
        toolName,
        'hermes',
      );
    }

    // Also run the collector PreToolUse path so a pending_span is
    // saved AND nio.tool_use.count{event=PreToolUse,platform=hermes}
    // is emitted, mirroring Claude Code's parallel hook chain.
    if (collectorConfig.enabled) {
      await dispatchCollectorEvent({
        event: 'PreToolUse',
        input: hermesToCollectorInput(payload, 'PreToolUse'),
        platform: 'hermes',
        config: collectorConfig,
        meterProvider,
        tracerProvider,
      });
    }

    // Make sure network exports complete before the subprocess exits;
    // the PeriodicExportingMetricReader batches by default and would
    // drop the counter we just recorded without an explicit flush.
    await Promise.all([
      meterProvider?.forceFlush(),
      tracerProvider?.forceFlush(),
      loggerProvider?.forceFlush(),
    ]);

    const confirmAction = config.guard?.confirm_action ?? 'allow';
    const { stdout, stderr } = formatHermesGuardOutput(result, confirmAction);
    if (stderr) process.stderr.write(stderr + '\n');
    process.stdout.write(stdout + '\n');
    return;
  }

  // Collector path: post_*, on_session_*, subagent_stop, *_llm_call.
  if (platform === 'hermes' && hookEventName) {
    await runHermesCollector(payload, hookEventName);
    process.stdout.write('{}\n');
    return;
  }

  // Future non-Hermes platforms or missing event_name: forward raw
  // HookOutput so existing guard-hook-style consumers still work.
  if (platform !== 'hermes') {
    const config = loadConfig();
    const nio = createNio();
    const adapter = selectAdapter(platform!, config);
    const result = await evaluateHook(adapter, payload, { config, nio });
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }

  // Hermes envelope without hook_event_name — silent no-op.
  process.stdout.write('{}\n');
}

main().catch((err: Error) => {
  process.stderr.write(`hook-cli error: ${err.message}\n`);
  process.exit(1);
});
