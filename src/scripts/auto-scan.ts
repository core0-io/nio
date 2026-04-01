#!/usr/bin/env node

export {};

/**
 * FFWD AgentGuard — SessionStart Auto-Scan Hook
 *
 * Runs on session startup to discover and scan newly installed skills.
 * For each skill in ~/.claude/skills/:
 *   1. Calculate artifact hash
 *   2. Check trust registry — skip if already registered with same hash
 *   3. Run quickScan for new/updated skills
 *   4. Report results to stderr (scan-only, does NOT modify trust registry)
 *
 * OPT-IN: This script only runs when auto_scan is true in config.json.
 * Without this setting, the script exits immediately.
 *
 * To register scanned skills, use: /ffwd-agent-guard trust attest
 *
 * Exits 0 always (informational only, never blocks session startup).
 */

import { readdirSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Opt-in gate: only run when auto_scan is enabled in config
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Load AgentGuard engine
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const agentguardPath = join(dirname(__filename), '..', '..', '..', 'dist', 'index.js');

interface AgentGuardConfig {
  level: string;
  auto_scan?: boolean;
}

interface AgentGuardModule {
  createAgentGuard: (options?: Record<string, unknown>) => {
    scanner: {
      quickScan: (path: string) => Promise<{ risk_level: string; risk_tags: string[] }>;
    };
    registry: unknown;
    actionScanner: unknown;
  };
  loadConfig: () => AgentGuardConfig;
  detectPlatform: () => string;
}

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

const { createAgentGuard, loadConfig, detectPlatform } = mod!;

const config = loadConfig();
if (!config.auto_scan) {
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SKILLS_DIRS = [
  join(homedir(), '.claude', 'skills'),
  join(homedir(), '.openclaw', 'skills'),
];
const FFWD_AGENT_GUARD_DIR = join(homedir(), '.ffwd-agent-guard');
const AUDIT_PATH = join(FFWD_AGENT_GUARD_DIR, 'audit.jsonl');

function ensureDir(): void {
  if (!existsSync(FFWD_AGENT_GUARD_DIR)) {
    mkdirSync(FFWD_AGENT_GUARD_DIR, { recursive: true });
  }
}

interface AuditEntry {
  timestamp: string;
  platform: string;
  event: string;
  skill_name: string;
  risk_level: string;
  risk_tags: string[];
}

function writeAuditLog(entry: AuditEntry): void {
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
        const skillMd = join(skillDir, 'SKILL.md');
        if (existsSync(skillMd)) {
          skills.push({ name: entry.name, path: skillDir });
        }
      }
    } catch {
      // Can't read skills dir
    }
  }
  return skills;
}

// ---------------------------------------------------------------------------
// Main — scan-only mode (no trust registry mutations)
// ---------------------------------------------------------------------------

interface ScanResult {
  name: string;
  risk_level: string;
  risk_tags: string[];
}

async function main(): Promise<void> {
  const skills = discoverSkills();
  if (skills.length === 0) {
    process.exit(0);
  }

  const { scanner } = createAgentGuard();

  let scanned = 0;
  const results: ScanResult[] = [];

  for (const skill of skills) {
    if (skill.name === 'ffwd-agent-guard') continue;

    try {
      const result = await scanner.quickScan(skill.path);
      scanned++;

      results.push({
        name: skill.name,
        risk_level: result.risk_level,
        risk_tags: result.risk_tags,
      });

      writeAuditLog({
        timestamp: new Date().toISOString(),
        platform: detectPlatform(),
        event: 'auto_scan',
        skill_name: skill.name,
        risk_level: result.risk_level,
        risk_tags: result.risk_tags,
      });
    } catch {
      // Skip skills that fail to scan
    }
  }

  if (scanned > 0) {
    const lines = results.map(r =>
      `  ${r.name}: ${r.risk_level}${r.risk_tags.length ? ` [${r.risk_tags.join(', ')}]` : ''}`
    );
    process.stderr.write(
      `FFWD AgentGuard: scanned ${scanned} skill(s)\n${lines.join('\n')}\n` +
      `Use /ffwd-agent-guard trust attest to register trusted skills.\n`
    );
  }

  process.exit(0);
}

main();
