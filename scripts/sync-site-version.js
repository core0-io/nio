#!/usr/bin/env node
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Sync the GitHub Pages version badge to match package.json.
 *
 * Rewrites every HTML page under index.html + docs/**\/*.html:
 *   - topbar pill  <span class="pill">vX.Y.Z</span>
 *     → <a class="pill link" href="…/releases/tag/vX.Y.Z">vX.Y.Z</a>
 *   - footer  <div class="site-footer"> … <span>vX.Y.Z</span> … </div>
 *     → <div class="site-footer"> … <a href="…/releases/tag/vX.Y.Z">vX.Y.Z</a> … </div>
 *
 * Idempotent: also matches the already-rewritten <a> form so repeated runs are
 * no-ops, and bumps the version inside existing anchors when package.json changes.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
const TAG = `v${pkg.version}`;
const RELEASE_URL = `https://github.com/core0-io/nio/releases/tag/${TAG}`;

const VER = String.raw`v\d+\.\d+\.\d+(?:-[^"<\s]+)?`;
const REPO_RELEASES_PREFIX = String.raw`https:\/\/github\.com\/core0-io\/nio\/releases\/tag\/`;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.html')) out.push(full);
  }
  return out;
}

function rewrite(html) {
  let out = html;

  // Topbar pill — original <span> form.
  out = out.replace(
    new RegExp(`<span class="pill">${VER}<\\/span>`, 'g'),
    `<a class="pill link" href="${RELEASE_URL}">${TAG}</a>`,
  );
  // Topbar pill — already rewritten <a> form (re-sync on version bump).
  out = out.replace(
    new RegExp(`<a class="pill link" href="${REPO_RELEASES_PREFIX}${VER}">${VER}<\\/a>`, 'g'),
    `<a class="pill link" href="${RELEASE_URL}">${TAG}</a>`,
  );

  // Footer version — original <span> form, scoped to <div class="site-footer">.
  out = out.replace(
    new RegExp(
      `(<div class="site-footer">[\\s\\S]*?)<span>${VER}<\\/span>([\\s\\S]*?<\\/div>)`,
      'g',
    ),
    (_, pre, post) => `${pre}<a href="${RELEASE_URL}">${TAG}</a>${post}`,
  );
  // Footer version — already rewritten <a> form.
  out = out.replace(
    new RegExp(
      `(<div class="site-footer">[\\s\\S]*?)<a href="${REPO_RELEASES_PREFIX}${VER}">${VER}<\\/a>([\\s\\S]*?<\\/div>)`,
      'g',
    ),
    (_, pre, post) => `${pre}<a href="${RELEASE_URL}">${TAG}</a>${post}`,
  );

  return out;
}

const files = [join(ROOT, 'index.html'), ...walk(join(ROOT, 'docs'))];

let updated = 0;
for (const file of files) {
  const before = readFileSync(file, 'utf-8');
  const after = rewrite(before);
  if (after !== before) {
    writeFileSync(file, after);
    updated++;
  }
}

console.log(`  Site version synced → ${TAG} (${updated} file${updated === 1 ? '' : 's'} updated)`);
