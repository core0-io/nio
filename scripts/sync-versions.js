#!/usr/bin/env node
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Sync the package.json version into every per-plugin manifest / skill file.
 * Uses targeted regex replace (no JSON re-serialization) so file formatting
 * — comments, key ordering, custom array layouts — is preserved.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version;

// For each target the regex must match the version line exactly once.
// `replace(re, replacement)` (no /g flag) replaces only the first match,
// which is what we want for JSON files where "version" may appear later
// inside arrays or unrelated keys.
const targets = [
  // OpenClaw plugin manifest — top-level "version".
  { path: 'plugins/openclaw/plugin/package.json', re: /("version"\s*:\s*)"[^"]*"/, replacement: (v) => `$1"${v}"` },
  // Claude Code marketplace listing — first "version" is metadata.version.
  { path: 'plugins/claude-code/.claude-plugin/marketplace.json', re: /("version"\s*:\s*)"[^"]*"/, replacement: (v) => `$1"${v}"` },
  // Claude Code plugin manifest — top-level "version".
  { path: 'plugins/claude-code/.claude-plugin/plugin.json', re: /("version"\s*:\s*)"[^"]*"/, replacement: (v) => `$1"${v}"` },
  // SKILL.md frontmatter (source of truth — sync-shared.js copies this to
  // both claude-code and openclaw plugin skill dirs).
  { path: 'plugins/shared/skill/SKILL.md', re: /^(\s*version:\s*)"[^"]*"/m, replacement: (v) => `$1"${v}"` },
  // Hermes Python plugin manifest — Hermes reads ~/.hermes/plugins/nio/plugin.yaml.
  { path: 'plugins/hermes/python-plugin/plugin.yaml', re: /^(version:\s*).+$/m, replacement: (v) => `$1${v}` },
];

for (const { path, re, replacement } of targets) {
  const abs = join(ROOT, path);
  const before = readFileSync(abs, 'utf-8');
  if (!re.test(before)) {
    throw new Error(`Could not find version field in ${path}`);
  }
  writeFileSync(abs, before.replace(re, replacement(version)));
  console.log(`  synced ${path} → ${version}`);
}
