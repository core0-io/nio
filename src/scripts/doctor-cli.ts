#!/usr/bin/env node
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * `/nio doctor` CLI — thin wrapper for the LLM-driven platforms (Claude Code,
 * Codex) that read SKILL.md and shell out to bundled scripts rather than
 * honouring OpenClaw's `command-dispatch: tool`. Forwards to the shared
 * dispatcher so all platforms share one implementation.
 *
 * doctor only reads ~/.nio/config.yaml and probes the configured endpoints —
 * it needs neither the orchestrator nor the scanner, so we pass undefined deps
 * (same as `config import` / `external-score`).
 */

import { dispatchNioCommand } from '../adapters/openclaw-dispatch.js';

async function main(): Promise<void> {
  const out = await dispatchNioCommand('doctor', {
    orchestrator: undefined as never,
    scanner: undefined as never,
  });
  process.stdout.write(out + (out.endsWith('\n') ? '' : '\n'));
}

main().catch((err: Error) => {
  process.stderr.write(`doctor-cli error: ${err.message}\n`);
  if (err.stack) process.stderr.write(err.stack + '\n');
  process.exit(1);
});
