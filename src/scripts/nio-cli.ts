#!/usr/bin/env node
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Nio Slash CLI — single-binary dispatcher for `/nio <subcommand> ...`.
 *
 * Cross-process consumers that want OpenClaw-style command-dispatch
 * (slash command bypasses the LLM, runs in-process) but can't import
 * TypeScript directly: shell out to this binary instead.
 *
 * In particular, the Hermes Agent Python plugin at
 * plugins/hermes/python-plugin/__init__.py registers a `/nio` slash
 * command whose handler subprocess-spawns this CLI with the raw arg
 * string. Hermes runtime routes the slash directly to the handler —
 * no LLM token spent on dispatch.
 *
 * Usage (programmatic, single raw arg — preferred):
 *   node nio-cli.js "scan ./src"
 *
 * Usage (shell, multi argv — also supported, joined on single space):
 *   node nio-cli.js scan ./src
 *   node nio-cli.js config show
 *   node nio-cli.js action "exec_command: ls /tmp"
 *
 * Subcommands match the SKILL.md surface and `dispatchNioCommand`'s
 * existing routing in src/adapters/openclaw-dispatch.ts:
 *   scan <path>     — static + behavioural scan of a directory
 *   action <body>   — evaluate a runtime action via Phase 1–6
 *   config [show|<level>|reset]
 *   report          — recent audit entries
 *   reset           — alias for `config reset`
 *   (empty)         — defaults to `config show`
 *
 * Exit codes:
 *   0 — handler returned a string (printed to stdout)
 *   1 — internal error (caught + logged to stderr)
 *
 * Output is whatever string `dispatchNioCommand` returns, verbatim.
 * No JSON wrapping; let the handler decide format per subcommand.
 */

import { createNio } from '../index.js';
import { SkillScanner } from '../scanner/index.js';
import { dispatchNioCommand } from '../adapters/openclaw-dispatch.js';
import { loadConfig } from '../adapters/common.js';

async function main(): Promise<void> {
  // Join all argv past the binary into a single space-delimited string.
  // This handles both invocation styles: programmatic callers can pass
  // the whole user input as a single quoted argv (no shell expansion
  // surprises) while shell users can write `nio-cli scan ./src` directly.
  const rawArgs = process.argv.slice(2).join(' ');

  // Build the same in-process dependencies dispatchNioCommand expects
  // when wired through OpenClaw's `nio_command` tool. createNio() reads
  // ~/.nio/config.yaml and constructs ActionOrchestrator with the user's
  // protection level, scoring weights, etc.
  const { orchestrator } = createNio();

  // SkillScanner needs file_scan_rules from config for any user-extended
  // patterns; same wiring openclaw-plugin.ts does.
  const config = loadConfig();
  const scanner = new SkillScanner({
    fileScanRules: config.guard?.file_scan_rules,
  });

  const out = await dispatchNioCommand(rawArgs, { orchestrator, scanner });
  process.stdout.write(out + (out.endsWith('\n') ? '' : '\n'));
}

main().catch((err: Error) => {
  process.stderr.write(`nio-cli error: ${err.message}\n`);
  if (err.stack) process.stderr.write(err.stack + '\n');
  process.exit(1);
});
