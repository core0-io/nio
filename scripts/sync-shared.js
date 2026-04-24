#!/usr/bin/env node
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Sync shared files to each plugin directory for self-contained distribution.
 * Source of truth: plugins/shared/ (config + skill) and repo root (README.md).
 */

import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = join(ROOT, 'plugins', 'shared');
const SHARED_SKILL = join(SHARED, 'skill');

// Plugins that install as an agent skill (claude-code, openclaw) get the
// shared SKILL.md + rule docs synced into their skills/nio/ subdirectory.
const SKILL_PLUGIN_DIRS = [
  join(ROOT, 'plugins', 'claude-code'),
  join(ROOT, 'plugins', 'openclaw'),
];

// Plugins that don't install as a skill (hermes — runs via shell-hook
// config in ~/.hermes/config.yaml, no skill surface) still benefit from
// the shared config template + schema + README for documentation.
const CONFIG_ONLY_PLUGIN_DIRS = [
  join(ROOT, 'plugins', 'hermes'),
];

const SKILL_ID = 'nio';

for (const dir of [...SKILL_PLUGIN_DIRS, ...CONFIG_ONLY_PLUGIN_DIRS]) {
  copyFileSync(join(SHARED, 'config.default.yaml'), join(dir, 'config.default.yaml'));
  copyFileSync(join(SHARED, 'config.schema.json'), join(dir, 'config.schema.json'));
  copyFileSync(join(ROOT, 'README.md'), join(dir, 'README.md'));
}

for (const dir of SKILL_PLUGIN_DIRS) {
  const skillDst = join(dir, 'skills', SKILL_ID);
  mkdirSync(skillDst, { recursive: true });
  for (const f of readdirSync(SHARED_SKILL)) {
    copyFileSync(join(SHARED_SKILL, f), join(skillDst, f));
  }
}

console.log('  Shared files synced to plugin directories');
