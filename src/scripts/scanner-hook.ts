#!/usr/bin/env node
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Nio — SessionStart Scanner Hook
 *
 * Async hook that runs on session startup. Discovers other installed
 * skills (Claude Code, Codex, OpenClaw), scans each with the
 * ScanOrchestrator, and writes results to scan-cache for the
 * ActionOrchestrator guard pipeline to consume.
 *
 * Platform tag for the audit log entry is selected via
 * `--platform <name>` (default: claude-code).
 *
 * Skips skills that are already cached and fresh (< 24h, same hash).
 * Always exits 0 — informational only, never blocks session startup.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { loadCollectorConfig } from './lib/config-loader.js';
import { createLoggerProvider } from './lib/logs-collector.js';
import { createNio, ScanCache } from '../index.js';
import { loadConfig, writeAuditLog } from '../adapters/index.js';

interface AuditScanEntry {
  event: 'session_scan';
  timestamp: string;
  platform: string;
  session_id?: string;
  skill_name: string;
  risk_level: string;
  risk_tags: string[];
  finding_count?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}
const PLATFORM = getArg('platform') ?? 'claude-code';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SKILLS_DIRS = [
  join(homedir(), '.claude', 'skills'),
  join(homedir(), '.codex', 'skills'),
  join(homedir(), '.openclaw', 'skills'),
];

// LoggerProvider for OTEL audit log export (lazy-initialized).
// createLoggerProvider already short-circuits on missing endpoint or
// collector.logs.enabled === false.
let _loggerProvider: import('@opentelemetry/sdk-logs').LoggerProvider | null | undefined;
function getLoggerProvider(): import('@opentelemetry/sdk-logs').LoggerProvider | null {
  if (_loggerProvider === undefined) {
    try {
      _loggerProvider = createLoggerProvider(loadCollectorConfig());
    } catch {
      _loggerProvider = null;
    }
  }
  return _loggerProvider;
}

function writeScanAuditLog(entry: AuditScanEntry): void {
  // Route through writeAuditLog so collector.logs.{enabled,local,path,
  // max_size_mb} are all honored uniformly with the other hook scripts.
  try {
    const logsConfig = loadConfig().collector?.logs;
    writeAuditLog(entry, { loggerProvider: getLoggerProvider(), logsConfig });
  } catch {
    // Non-critical — audit failure must not block session startup
  }
}

// ---------------------------------------------------------------------------
// Discover skills
// ---------------------------------------------------------------------------

interface DiscoveredSkill {
  name: string;
  path: string;
}

function discoverSkills(): DiscoveredSkill[] {
  const skills: DiscoveredSkill[] = [];
  for (const skillsDir of SKILLS_DIRS) {
    if (!existsSync(skillsDir)) continue;
    try {
      const entries = readdirSync(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillDir = join(skillsDir, entry.name);
        if (existsSync(join(skillDir, 'SKILL.md'))) {
          skills.push({ name: entry.name, path: skillDir });
        }
      }
    } catch {
      // Can't read skills dir
    }
  }
  return skills;
}

/**
 * Compute a fast hash of a skill directory (SKILL.md + any .ts/.js files).
 * Used to skip re-scanning unchanged skills.
 */
function hashSkillDir(skillDir: string): string {
  const hash = createHash('sha256');
  try {
    const entries = readdirSync(skillDir, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/\.(ts|js|mts|mjs|tsx|jsx|md|json)$/.test(entry.name)) continue;
      const fullPath = join(entry.parentPath || entry.path, entry.name);
      try {
        hash.update(readFileSync(fullPath));
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Fallback: just hash the skill name + timestamp
    hash.update(skillDir + Date.now());
  }
  return hash.digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const skills = discoverSkills();
  if (skills.length === 0) {
    process.exit(0);
  }

  const { scanner } = createNio();
  const cache = new ScanCache();

  let scanned = 0;
  let skipped = 0;
  const results: Array<{ name: string; risk_level: string; risk_tags: string[]; cached: boolean }> = [];

  for (const skill of skills) {
    // Never scan ourselves
    if (skill.name === 'nio') continue;

    const artifactHash = hashSkillDir(skill.path);

    // Check cache — skip if fresh with same hash
    const cached = cache.get(skill.name);
    if (cached && cached.artifact_hash === artifactHash) {
      skipped++;
      continue;
    }

    try {
      const result = await scanner.quickScan(skill.path);
      scanned++;

      // Write to scan-cache
      cache.set({
        skill_id: skill.name,
        scan_time: new Date().toISOString(),
        artifact_hash: artifactHash,
        risk_level: result.risk_level,
        finding_count: 0, // quickScan doesn't return finding count
        critical_findings: 0,
        high_findings: 0,
      });

      results.push({
        name: skill.name,
        risk_level: result.risk_level,
        risk_tags: result.risk_tags,
        cached: false,
      });

      writeScanAuditLog({
        event: 'session_scan',
        timestamp: new Date().toISOString(),
        platform: PLATFORM,
        skill_name: skill.name,
        risk_level: result.risk_level,
        risk_tags: result.risk_tags,
      });
    } catch {
      // Skip skills that fail to scan
    }
  }

  if (scanned > 0 || skipped > 0) {
    const lines = results.map(r =>
      `  ${r.name}: ${r.risk_level}${r.risk_tags.length ? ` [${r.risk_tags.join(', ')}]` : ''}`
    );
    const parts = [];
    if (scanned > 0) parts.push(`scanned ${scanned}`);
    if (skipped > 0) parts.push(`${skipped} cached`);
    process.stderr.write(`Nio: ${parts.join(', ')} skill(s)\n`);
    if (lines.length > 0) {
      process.stderr.write(lines.join('\n') + '\n');
    }
  }

  process.exit(0);
}

main();
