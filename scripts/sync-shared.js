#!/usr/bin/env node

/**
 * Sync shared files to each plugin directory for self-contained distribution.
 * Source of truth: plugins/shared/ (config) and repo root (README.md).
 */

import { copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = join(ROOT, 'plugins', 'shared');

const PLUGIN_DIRS = [
  join(ROOT, 'plugins', 'claude-code'),
  join(ROOT, 'plugins', 'openclaw'),
];

for (const dir of PLUGIN_DIRS) {
  copyFileSync(join(SHARED, 'config.default.yaml'), join(dir, 'config.default.yaml'));
  copyFileSync(join(SHARED, 'config.schema.json'), join(dir, 'config.schema.json'));
  copyFileSync(join(ROOT, 'README.md'), join(dir, 'README.md'));
}

console.log('  Shared files synced to plugin directories');
