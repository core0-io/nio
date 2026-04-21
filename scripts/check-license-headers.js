#!/usr/bin/env node
/**
 * License-header enforcer for .ts / .js source files.
 *
 *   node scripts/check-license-headers.js              # check only; exits 1 if any missing
 *   node scripts/check-license-headers.js --fix        # add missing headers to all tracked src files
 *   node scripts/check-license-headers.js --fix --staged  # only act on git-staged files (pre-commit)
 *
 * Header format (SPDX short form):
 *   // Copyright 2026 core0-io
 *   // SPDX-License-Identifier: Apache-2.0
 *
 * Idempotent: files already carrying an `SPDX-License-Identifier: Apache-2.0`
 * line in the top ~500 bytes are left alone.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HEADER = '// Copyright 2026 core0-io\n// SPDX-License-Identifier: Apache-2.0\n\n';
const HEADER_RE = /SPDX-License-Identifier:\s*Apache-2\.0/;

const FIX = process.argv.includes('--fix');
const STAGED = process.argv.includes('--staged');

// Scan scope:
//  - src/**/*.ts, scripts/*.{ts,js} are enforced.
//  - generated output (dist/, node_modules/, plugins/*/skills/*/scripts/) is skipped
//    by git ls-files (gitignored) or by explicit path prefix filter.
const INCLUDE_PREFIXES = ['src/', 'scripts/'];
const EXCLUDE_SUFFIXES = ['.d.ts', '.test.ts', '.test.js']; // tests optional; flip here if desired
const EXCLUDE_CONTAINS = ['/fixtures/', '/dist/', '/node_modules/'];

function listFiles() {
  const cmd = STAGED
    ? 'git diff --cached --name-only --diff-filter=ACMR'
    : 'git ls-files';
  const out = execSync(cmd, { cwd: ROOT, encoding: 'utf8' });
  return out
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .filter(p => INCLUDE_PREFIXES.some(pre => p.startsWith(pre)))
    .filter(p => p.endsWith('.ts') || p.endsWith('.js'))
    .filter(p => !EXCLUDE_SUFFIXES.some(s => p.endsWith(s)))
    .filter(p => !EXCLUDE_CONTAINS.some(c => p.includes(c)));
}

function hasHeader(content) {
  return HEADER_RE.test(content.slice(0, 500));
}

function addHeader(content) {
  // Preserve shebang as the literal first line.
  if (content.startsWith('#!')) {
    const nl = content.indexOf('\n');
    const shebang = content.slice(0, nl + 1);
    const rest = content.slice(nl + 1);
    const sep = rest.startsWith('\n') ? '' : '\n';
    return shebang + sep + HEADER + rest.replace(/^\n+/, '');
  }
  return HEADER + content.replace(/^\n+/, '');
}

const files = listFiles();
const missing = [];
let fixed = 0;

for (const rel of files) {
  const abs = join(ROOT, rel);
  let content;
  try {
    content = readFileSync(abs, 'utf8');
  } catch {
    continue; // deleted during staging, etc.
  }
  if (hasHeader(content)) continue;

  if (FIX) {
    writeFileSync(abs, addHeader(content));
    // Restage so the header goes into the commit during pre-commit runs.
    if (STAGED) {
      try { execSync(`git add "${rel}"`, { cwd: ROOT }); } catch {}
    }
    fixed++;
  } else {
    missing.push(rel);
  }
}

if (FIX) {
  console.log(`  license-headers: ${fixed} file(s) updated, ${files.length - fixed} already OK`);
  process.exit(0);
}

if (missing.length) {
  console.error('  Missing Apache-2.0 SPDX header in:');
  for (const f of missing) console.error(`    ${f}`);
  console.error('\n  Fix with: node scripts/check-license-headers.js --fix');
  process.exit(1);
}

console.log(`  license-headers: OK (${files.length} files)`);
