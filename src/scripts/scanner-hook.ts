#!/usr/bin/env node
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Nio — SessionStart Scanner Hook
 *
 * Async hook that runs on session startup. Discovers other installed skills
 * in ~/.claude/skills/ and ~/.openclaw/skills/, scans each with the
 * ScanOrchestrator, and writes results to scan-cache for the ActionOrchestrator
 * guard pipeline to consume.
 *
 * Skips skills that are already cached and fresh (< 24h, same hash).
 * Always exits 0 — informational only, never blocks session startup.
 */

import { readdirSync, readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { loadCollectorConfig } from './lib/config-loader.js';
import { createLoggerProvider, emitAuditLog } from './lib/logs-collector.js';
import { createNio, ScanCache } from '../index.js';

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
// Config
// ---------------------------------------------------------------------------

const SKILLS_DIRS = [
  join(homedir(), '.claude', 'skills'),
  join(homedir(), '.openclaw', 'skills'),
];
const NIO_DIR = process.env.NIO_HOME || join(homedir(), '.nio');
const AUDIT_PATH = join(NIO_DIR, 'audit.jsonl');

function ensureDir(): void {
  if (!existsSync(NIO_DIR)) {
    mkdirSync(NIO_DIR, { recursive: true });
  }
}

// LoggerProvider for OTEL audit log export (lazy-initialized)
let _loggerProvider: import('@opentelemetry/sdk-logs').LoggerProvider | null | undefined;
function getLoggerProvider(): import('@opentelemetry/sdk-logs').LoggerProvider | null {
  if (_loggerProvider === undefined) {
    try {
      const cc = loadCollectorConfig();
      _loggerProvider = createLoggerProvider(cc);
    } catch {
      _loggerProvider = null;
    }
  }
  return _loggerProvider;
}

function writeScanAuditLog(entry: AuditScanEntry): void {
  // OTEL export
  try {
    const lp = getLoggerProvider();
    if (lp) emitAuditLog(lp, entry);
  } catch { /* non-critical */ }

  // Local JSONL
  try {
    ensureDir();
    appendFileSync(AUDIT_PATH, JSON.stringify(entry) + '\n');
  } catch {
    // Non-critical
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
        platform: 'claude-code',
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
