#!/usr/bin/env node

/**
 * FFWD AgentGuard — Release packaging script
 *
 * Usage:
 *   node scripts/release.js claude-code   # Claude Code plugin zip
 *   node scripts/release.js openclaw      # OpenClaw plugin zip
 *   node scripts/release.js all           # All-in-one zip (all platforms)
 *
 * Output: releases/ffwd-agent-guard-{target}-v{version}.zip
 *
 * Single-platform zips extract as a self-contained plugin directory:
 *   claude-code.zip → .claude-plugin/, hooks/, skills/, setup.sh, ...
 *   openclaw.zip    → openclaw.plugin.json, plugin.js, setup.sh, ...
 *
 * The all zip preserves the multi-plugin structure:
 *   all.zip → plugins/claude-code/, plugins/openclaw/, setup.sh
 */

import { execSync } from 'node:child_process';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RELEASES_DIR = join(ROOT, 'releases');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
const version = pkg.version;

const target = process.argv[2];
if (!target || !['claude-code', 'openclaw', 'all'].includes(target)) {
  console.error('Usage: node scripts/release.js <claude-code|openclaw|all>');
  process.exit(1);
}

rmSync(RELEASES_DIR, { recursive: true, force: true });
mkdirSync(RELEASES_DIR, { recursive: true });

const EXCLUDES = '-x "*/.DS_Store" "*/node_modules/.package-lock.json" "*/node_modules/.pnpm-*"';

/**
 * Create a zip from the contents of sourceDir (relative to ROOT).
 * The zip entries start at "." inside sourceDir — no parent directories.
 */
function zipFromDir(outName, sourceDir) {
  const outPath = join(RELEASES_DIR, outName);
  execSync(
    `cd "${join(ROOT, sourceDir)}" && zip -r "${outPath}" . ${EXCLUDES}`,
    { stdio: 'inherit' }
  );
  console.log(`\n  Created: ${outPath}\n`);
}

/**
 * Create a zip from repo root with explicit file/dir list.
 */
function zipFromRoot(outName, files) {
  const outPath = join(RELEASES_DIR, outName);
  execSync(
    `cd "${ROOT}" && zip -r "${outPath}" ${files.join(' ')} ${EXCLUDES}`,
    { stdio: 'inherit' }
  );
  console.log(`\n  Created: ${outPath}\n`);
}

const targets = target === 'all' ? ['claude-code', 'openclaw', 'all'] : [target];

for (const t of targets) {
  const name = `ffwd-agent-guard-${t}-v${version}.zip`;
  console.log(`\n  Packaging: ${t} → ${name}`);

  switch (t) {
    case 'claude-code':
      zipFromDir(name, 'plugins/claude-code');
      break;

    case 'openclaw':
      zipFromDir(name, 'plugins/openclaw');
      break;

    case 'all':
      zipFromRoot(name, [
        'plugins/',
        'setup.sh',
        'README.md',
      ]);
      break;
  }
}

console.log('  Done!\n');
