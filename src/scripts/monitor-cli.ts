#!/usr/bin/env node
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Nio — Monitor CLI
 *
 * Backs the `/nio-monitor` skill on Claude Code and Codex. Arms or
 * disarms telemetry capture for the current agent session.
 *
 * The behaviour itself lives in `lib/monitor-commands.ts`, shared with
 * `/nio monitor` on OpenClaw and Hermes (see `openclaw-dispatch.ts`), so
 * the two surfaces cannot drift. This file is just argv parsing plus
 * JSON on stdout for the calling skill to present without parsing prose.
 */

import {
  normaliseMonitorSubcommand,
  runMonitorCommand,
} from './lib/monitor-commands.js';

function usage(): never {
  process.stderr.write(
    'Usage: monitor-cli.js <on|off|status>\n\n' +
    '  on      Start capturing telemetry for the current session\n' +
    '  off     Stop capturing, and clear any pending arm\n' +
    '  status  Report global and per-session capture state\n',
  );
  process.exit(1);
}

function main(): void {
  const raw = process.argv[2];
  if (!raw) usage();
  const command = normaliseMonitorSubcommand(raw);
  if (command === null) usage();

  process.stdout.write(JSON.stringify(runMonitorCommand(command)) + '\n');
}

main();
