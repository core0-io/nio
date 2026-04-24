#!/usr/bin/env node
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Nio Hook CLI — thin CLI wrapper over evaluateHook (Phase 0–6 + audit).
 *
 * For cross-process hook consumers that can't `import` TypeScript
 * directly. In particular, Hermes Agent's shell-hooks subsystem
 * (upstream PR #13296) spawns arbitrary subprocesses and pipes a JSON
 * envelope over stdin — this CLI is what gets spawned.
 *
 * Platform-specific stdout formatting is done here so each cross-
 * process consumer receives JSON in the shape it expects, without
 * any external translator.
 *
 * Usage:
 *   node hook-cli.js --platform hermes --stdin
 *   node hook-cli.js --platform hermes --envelope '<json>'
 *
 *   For Hermes, both forms expect the Hermes canonical snake_case
 *   envelope payload. Output on stdout:
 *     deny  → {"decision": "block", "reason": "..."}
 *     allow → {} (silent)
 *     ask   → folded through `guard.confirm_action` config knob
 *             (allow → {}, deny → block, ask → block + stderr warn).
 *
 * Failure handling:
 *   - JSON parse errors / missing flags: exit 1, empty stdout, error
 *     on stderr. Hermes's `_parse_response` treats non-zero exits and
 *     malformed/missing stdout as "no block" (fail-open per upstream
 *     spec: "non-zero exit codes … never abort the agent loop").
 *   - evaluateHook errors: same — exit 1, empty stdout.
 */

import { createNio, HermesAdapter, evaluateHook, loadConfig } from '../index.js';
import type { HookAdapter, HookOutput } from '../index.js';

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

// ── Platform-specific stdout formatting ────────────────────────────────

interface FormattedOutput {
  stdout: string;
  stderr?: string;
}

/**
 * Translate Nio's three-valued HookOutput.decision into the binary
 * Hermes wire protocol, folding `ask` through `guard.confirm_action`.
 *
 * See upstream `agent/shell_hooks.py::_parse_response` — Hermes only
 * recognises `{"decision":"block",...}` / `{"action":"block",...}`;
 * any other stdout (including empty) is treated as "no action" (allow).
 */
function formatHermesOutput(
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

  const config = loadConfig();
  const nio = createNio();
  const adapter = selectAdapter(platform!, config);

  const result = await evaluateHook(adapter, payload, { config, nio });

  if (platform === 'hermes') {
    const confirmAction = config.guard?.confirm_action ?? 'allow';
    const { stdout, stderr } = formatHermesOutput(result, confirmAction);
    if (stderr) process.stderr.write(stderr + '\n');
    process.stdout.write(stdout + '\n');
  } else {
    // Other platforms (future) get the raw HookOutput.
    process.stdout.write(JSON.stringify(result) + '\n');
  }
}

main().catch((err: Error) => {
  process.stderr.write(`hook-cli error: ${err.message}\n`);
  process.exit(1);
});
