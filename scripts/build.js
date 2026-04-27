#!/usr/bin/env bun
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { cpSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const shared = {
  target: 'node',
  format: 'esm',
  external: ['node:*'],
  sourcemap: 'none',
};

const openclaw = await Bun.build({
  ...shared,
  entrypoints: [join(ROOT, 'dist/adapters/openclaw-plugin.js')],
  outdir: join(ROOT, 'plugins/openclaw/plugin'),
  naming: { entry: 'plugin.js' },
});

if (!openclaw.success) {
  console.error(openclaw.logs);
  process.exit(1);
}

const CC_SKILL_SCRIPTS = join(ROOT, 'plugins/claude-code/skills/nio/scripts');
const OPENCLAW_SKILL_SCRIPTS = join(ROOT, 'plugins/openclaw/skills/nio/scripts');

const cc = await Bun.build({
  ...shared,
  entrypoints: [
    'scanner-hook',
    'guard-hook',
    'collector-hook',
    'action-cli',
    'config-cli',
    'hook-cli',
  ].map((n) => join(ROOT, `src/scripts/${n}.ts`)),
  outdir: CC_SKILL_SCRIPTS,
  splitting: true,
});

if (!cc.success) {
  console.error(cc.logs);
  process.exit(1);
}

// Mirror the compiled CC skill scripts to the OpenClaw skill dir so both
// plugins ship identical scripts.
rmSync(OPENCLAW_SKILL_SCRIPTS, { recursive: true, force: true });
cpSync(CC_SKILL_SCRIPTS, OPENCLAW_SKILL_SCRIPTS, { recursive: true });

// Hermes plugin needs self-contained CLIs at plugin-local paths so a
// release zip of plugins/hermes/ works standalone (without reaching
// into plugins/claude-code/). Build each entry as a single non-split
// bundle — no shared chunks means each output is one file with no
// file-level dependencies, suitable for a Hermes-only distribution.
//
//   hook-cli.js — shell-hook dispatcher (guard + collector paths)
//   nio-cli.js  — /nio slash-command dispatcher (Python plugin shells
//                 out to this; bypasses the LLM)
const HERMES_SCRIPTS = join(ROOT, 'plugins/hermes/scripts');
let hermesOutputs = 0;
for (const entry of ['hook-cli', 'nio-cli']) {
  const out = await Bun.build({
    ...shared,
    entrypoints: [join(ROOT, `src/scripts/${entry}.ts`)],
    outdir: HERMES_SCRIPTS,
    splitting: false,
  });
  if (!out.success) {
    console.error(out.logs);
    process.exit(1);
  }
  hermesOutputs += out.outputs.length;
}

console.log(
  `  Built ${openclaw.outputs.length} OpenClaw output(s), ${cc.outputs.length} Claude Code output(s) (mirrored to OpenClaw skill), ${hermesOutputs} Hermes output(s)`,
);
