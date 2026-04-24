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

// Hermes plugin needs a self-contained hook-cli.js at a plugin-local
// path so a release zip of plugins/hermes/ works standalone (without
// reaching into plugins/claude-code/). Build hook-cli as a single
// non-split bundle — no shared chunks means the output is one file
// with no file-level dependencies, small enough to ship in a
// Hermes-only distribution.
const HERMES_SCRIPTS = join(ROOT, 'plugins/hermes/scripts');
const hermes = await Bun.build({
  ...shared,
  entrypoints: [join(ROOT, 'src/scripts/hook-cli.ts')],
  outdir: HERMES_SCRIPTS,
  splitting: false,
});

if (!hermes.success) {
  console.error(hermes.logs);
  process.exit(1);
}

console.log(
  `  Built ${openclaw.outputs.length} OpenClaw output(s), ${cc.outputs.length} Claude Code output(s) (mirrored to OpenClaw skill), ${hermes.outputs.length} Hermes output(s)`,
);
