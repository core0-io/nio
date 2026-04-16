#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version;

const targets = [
  { path: 'plugins/openclaw/package.json', set: (j) => { j.version = version; } },
  { path: 'plugins/claude-code/.claude-plugin/marketplace.json', set: (j) => { j.metadata.version = version; } },
];

for (const { path, set } of targets) {
  const abs = join(ROOT, path);
  const json = JSON.parse(readFileSync(abs, 'utf-8'));
  set(json);
  writeFileSync(abs, JSON.stringify(json, null, 2) + '\n');
  console.log(`  synced ${path} → ${version}`);
}
