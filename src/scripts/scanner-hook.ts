#!/usr/bin/env node

export {};

/**
 * FFWD AgentGuard — SessionStart Scanner Hook
 *
 * Async hook that runs on session startup. Discovers other installed skills
 * in ~/.claude/skills/ and ~/.openclaw/skills/, scans each with the
 * ScanOrchestrator, and writes results to scan-cache for the RuntimeAnalyzer
 * guard pipeline to consume.
 *
 * Skips skills that are already cached and fresh (< 24h, same hash).
 * Always exits 0 — informational only, never blocks session startup.
 */

import { readdirSync, readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Types (local to avoid cross-project imports in compiled scripts)
// ---------------------------------------------------------------------------

interface AgentGuardModule {
  createAgentGuard: () => {
    scanner: {
      quickScan: (path: string) => Promise<{ risk_level: string; risk_tags: string[] }>;
    };
    [key: string]: unknown;
  };
  ScanCache: new (filePath?: string) => {
    get: (id: string) => { artifact_hash: string } | null;
    set: (entry: ScanCacheEntry) => void;
  };
}

interface ScanCacheEntry {
  skill_id: string;
  scan_time: string;
  artifact_hash: string;
  risk_level: string;
  finding_count: number;
  critical_findings: number;
  high_findings: number;
}

// ---------------------------------------------------------------------------
// Load AgentGuard engine
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const agentguardPath = join(dirname(__filename), '..', '..', '..', '..', '..', 'dist', 'index.js');

let mod: AgentGuardModule;
try {
  mod = await import(agentguardPath) as AgentGuardModule;
} catch {
  try {
    mod = // @ts-expect-error fallback to npm package if relative import fails
    await import('@core0-io/ffwd-agent-guard') as AgentGuardModule;
  } catch {
    process.exit(0);
  }
}

const { createAgentGuard, ScanCache } = mod!;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SKILLS_DIRS = [
  join(homedir(), '.claude', 'skills'),
  join(homedir(), '.openclaw', 'skills'),
];
const FFWD_AGENT_GUARD_DIR = process.env.FFWD_AGENT_GUARD_HOME || join(homedir(), '.ffwd-agent-guard');
const AUDIT_PATH = join(FFWD_AGENT_GUARD_DIR, 'audit.jsonl');

function ensureDir(): void {
  if (!existsSync(FFWD_AGENT_GUARD_DIR)) {
    mkdirSync(FFWD_AGENT_GUARD_DIR, { recursive: true });
  }
}

function writeAuditLog(entry: Record<string, unknown>): void {
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

  const { scanner } = createAgentGuard();
  const cache = new ScanCache();

  let scanned = 0;
  let skipped = 0;
  const results: Array<{ name: string; risk_level: string; risk_tags: string[]; cached: boolean }> = [];

  for (const skill of skills) {
    // Never scan ourselves
    if (skill.name === 'ffwd-agent-guard') continue;

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

      writeAuditLog({
        timestamp: new Date().toISOString(),
        event: 'session_scan',
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
    process.stderr.write(`FFWD AgentGuard: ${parts.join(', ')} skill(s)\n`);
    if (lines.length > 0) {
      process.stderr.write(lines.join('\n') + '\n');
    }
  }

  process.exit(0);
}

main();
