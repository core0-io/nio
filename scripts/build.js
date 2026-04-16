#!/usr/bin/env bun

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
  outdir: join(ROOT, 'plugins/openclaw'),
  naming: { entry: 'plugin.js' },
});

if (!openclaw.success) {
  console.error(openclaw.logs);
  process.exit(1);
}

const cc = await Bun.build({
  ...shared,
  entrypoints: [
    'scanner-hook',
    'guard-hook',
    'collector-hook',
    'action-cli',
    'config-cli',
  ].map((n) => join(ROOT, `src/scripts/${n}.ts`)),
  outdir: join(ROOT, 'plugins/claude-code/skills/ffwd-agent-guard/scripts'),
  splitting: true,
});

if (!cc.success) {
  console.error(cc.logs);
  process.exit(1);
}

console.log(
  `  Built ${openclaw.outputs.length} OpenClaw output(s), ${cc.outputs.length} Claude Code output(s)`,
);
