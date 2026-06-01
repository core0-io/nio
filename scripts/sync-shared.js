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
// All skill sources live under plugins/shared/skills/<name>/ — the unified
// `nio` umbrella plus the focused per-capability skills (nio-scan, …) sit
// side by side, mirroring each plugin's own skills/ layout.
const SHARED_SKILLS = join(SHARED, 'skills');
const SHARED_SKILL = join(SHARED_SKILLS, 'nio');

// Plugins that install as an agent skill (claude-code, openclaw, codex)
// get the shared SKILL.md + rule docs synced into their skills/nio/
// subdirectory.
const SKILL_PLUGIN_DIRS = [
  join(ROOT, 'plugins', 'claude-code'),
  join(ROOT, 'plugins', 'openclaw'),
  join(ROOT, 'plugins', 'codex'),
];

// Plugins that don't install as a skill (hermes — runs via shell-hook
// config in ~/.hermes/config.yaml, no skill surface) still benefit from
// the shared config template + schema + README for documentation.
const CONFIG_ONLY_PLUGIN_DIRS = [
  join(ROOT, 'plugins', 'hermes'),
];

const SKILL_ID = 'nio';

// Rule docs are OWNED by the focused skill whose capability they describe
// (single source of truth): SCAN-RULES.md lives in nio-scan, ACTION-POLICIES.md
// in nio-action. The unified `nio` umbrella references both from its scan /
// action sections, so its dest dir borrows a copy of each.
const UMBRELLA_COMPANIONS = {
  'SCAN-RULES.md': join(SHARED_SKILLS, 'nio-scan', 'SCAN-RULES.md'),
  'ACTION-POLICIES.md': join(SHARED_SKILLS, 'nio-action', 'ACTION-POLICIES.md'),
};

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
  // Borrow the rule docs the umbrella SKILL.md links to from their owning skills.
  for (const [name, src] of Object.entries(UMBRELLA_COMPANIONS)) {
    copyFileSync(src, join(skillDst, name));
  }
}

// Focused per-capability skills (nio-scan, nio-action, nio-report, nio-config,
// nio-doctor, nio-external-score) live under plugins/shared/skills/<name>/ and
// are already self-contained (nio-scan ships its SCAN-RULES.md, nio-action its
// ACTION-POLICIES.md). They are LLM-driven and only meaningful on the platforms
// whose /nio is dispatched by the model reading SKILL.md + running bundled
// scripts: Claude Code and Codex. OpenClaw (tool-dispatch via the single
// nio_command tool) and Hermes (nio-cli.js) keep using the unified /nio, so we
// deliberately do NOT sync the focused skills there.
const FOCUSED_SKILL_PLUGIN_DIRS = [
  join(ROOT, 'plugins', 'claude-code'),
  join(ROOT, 'plugins', 'codex'),
];

for (const dir of FOCUSED_SKILL_PLUGIN_DIRS) {
  for (const skillName of readdirSync(SHARED_SKILLS)) {
    if (skillName === SKILL_ID) continue; // umbrella handled above (→ all skill plugins)
    const src = join(SHARED_SKILLS, skillName);
    const dst = join(dir, 'skills', skillName);
    mkdirSync(dst, { recursive: true });
    for (const f of readdirSync(src)) {
      copyFileSync(join(src, f), join(dst, f));
    }
  }
}

console.log('  Shared files synced to plugin directories');
