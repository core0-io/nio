#!/usr/bin/env bun
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { cpSync, rmSync as purgeDir, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Bun emits ESM bundles (`format: 'esm'`) but writes them as `.js`. Node
 * decides ESM-vs-CJS by walking up from the script file to the nearest
 * `package.json`; without a sentinel near the bundle, `.js` is treated
 * as CJS and the first `import` statement throws SyntaxError. The
 * install dirs (`~/.hermes/plugins/nio/scripts/`, the Claude Code
 * plugin cache, etc.) have no parent package.json with
 * `"type": "module"`, so hooks crash on invocation. Drop a minimal
 * sentinel into every output dir so Node parses the bundle as ESM.
 */
function writeEsmSentinel(dir) {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ type: 'module' }, null, 2) + '\n',
  );
}

const shared = {
  target: 'node',
  format: 'esm',
  external: ['node:*'],
  sourcemap: 'none',
};

// NOTE: no writeEsmSentinel() call for openclaw/plugin/ — that dir has a
// real package.json (the plugin manifest with `name`, `version`,
// `openclaw.extensions`, also `"type": "module"`) that sync-versions.js
// maintains. Writing a minimal sentinel would clobber the manifest.
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

const CC_SKILL_SCRIPTS = join(ROOT, 'plugins/claude-code/skills/nio/scripts');
const OPENCLAW_SKILL_SCRIPTS = join(ROOT, 'plugins/openclaw/skills/nio/scripts');
const CODEX_SKILL_SCRIPTS = join(ROOT, 'plugins/codex/skills/nio/scripts');
const PI_SKILL_SCRIPTS = join(ROOT, 'plugins/pi/skills/nio/scripts');
const OC_SKILL_SCRIPTS = join(ROOT, 'plugins/opencode/skills/nio/scripts');

const cc = await Bun.build({
  ...shared,
  entrypoints: [
    'scanner-hook',
    'guard-hook',
    'collector-hook',
    'action-cli',
    'config-cli',
    'external-score-cli',
    'doctor-cli',
    'hook-cli',
  ].map((n) => join(ROOT, `src/scripts/${n}.ts`)),
  outdir: CC_SKILL_SCRIPTS,
  splitting: true,
});

if (!cc.success) {
  console.error(cc.logs);
  process.exit(1);
}
writeEsmSentinel(CC_SKILL_SCRIPTS);

// Mirror the compiled CC skill scripts to OpenClaw + Codex + Pi + opencode
// skill dirs so all plugins ship byte-identical scripts. cpSync copies the
// package.json sentinel along with the bundled JS. opencode needs this too:
// its synced skills/nio/SKILL.md and the focused nio-* skills both reference
// `scripts/<cli>.js` / `../nio/scripts/<cli>.js` as a natural-language-driven
// fallback alongside the direct nio_command tool path.
for (const dst of [OPENCLAW_SKILL_SCRIPTS, CODEX_SKILL_SCRIPTS, PI_SKILL_SCRIPTS, OC_SKILL_SCRIPTS]) {
  purgeDir(dst, { recursive: true, force: true });
  cpSync(CC_SKILL_SCRIPTS, dst, { recursive: true });
}

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
writeEsmSentinel(HERMES_SCRIPTS);

console.log(
  `  Built ${openclaw.outputs.length} OpenClaw output(s), ${cc.outputs.length} Claude Code output(s) (mirrored to OpenClaw + Codex + Pi + opencode skill), ${hermesOutputs} Hermes output(s), ${pi.outputs.length} Pi output(s), ${opencode.outputs.length} opencode output(s)`,
);
