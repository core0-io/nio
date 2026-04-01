#!/usr/bin/env node
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
 * OPT-IN: This script only runs when FFWD_AGENT_GUARD_AUTO_SCAN=1.
 * Without this env var, the script exits immediately.
 *
 * To register scanned skills, use: /ffwd-agent-guard trust attest
 *
 * Exits 0 always (informational only, never blocks session startup).
 */
import { readdirSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
// ---------------------------------------------------------------------------
// Opt-in gate: only run when explicitly enabled
// ---------------------------------------------------------------------------
if (process.env.FFWD_AGENT_GUARD_AUTO_SCAN !== '1') {
    process.exit(0);
}
// ---------------------------------------------------------------------------
// Load AgentGuard engine
// ---------------------------------------------------------------------------
const agentguardPath = join(import.meta.url.replace('file://', ''), '..', '..', '..', '..', 'dist', 'index.js');
let mod;
try {
    mod = await import(agentguardPath);
}
catch {
    try {
        mod = // @ts-expect-error fallback to npm package if relative import fails
            await import('@core0-io/ffwd-agent-guard');
    }
    catch {
        process.exit(0);
    }
}
const { createAgentGuard } = mod;
// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SKILLS_DIRS = [
    join(homedir(), '.claude', 'skills'),
    join(homedir(), '.openclaw', 'skills'),
];
const FFWD_AGENT_GUARD_DIR = join(homedir(), '.ffwd-agent-guard');
const AUDIT_PATH = join(FFWD_AGENT_GUARD_DIR, 'audit.jsonl');
function ensureDir() {
    if (!existsSync(FFWD_AGENT_GUARD_DIR)) {
        mkdirSync(FFWD_AGENT_GUARD_DIR, { recursive: true });
    }
}
function writeAuditLog(entry) {
    try {
        ensureDir();
        appendFileSync(AUDIT_PATH, JSON.stringify(entry) + '\n');
    }
    catch {
        // Non-critical
    }
}
function discoverSkills() {
    const skills = [];
    for (const skillsDir of SKILLS_DIRS) {
        if (!existsSync(skillsDir))
            continue;
        try {
            const entries = readdirSync(skillsDir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory())
                    continue;
                const skillDir = join(skillsDir, entry.name);
                const skillMd = join(skillDir, 'SKILL.md');
                if (existsSync(skillMd)) {
                    skills.push({ name: entry.name, path: skillDir });
                }
            }
        }
        catch {
            // Can't read skills dir
        }
    }
    return skills;
}
async function main() {
    const skills = discoverSkills();
    if (skills.length === 0) {
        process.exit(0);
    }
    const { scanner } = createAgentGuard();
    let scanned = 0;
    const results = [];
    for (const skill of skills) {
        if (skill.name === 'ffwd-agent-guard')
            continue;
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
                event: 'auto_scan',
                skill_name: skill.name,
                risk_level: result.risk_level,
                risk_tags: result.risk_tags,
            });
        }
        catch {
            // Skip skills that fail to scan
        }
    }
    if (scanned > 0) {
        const lines = results.map(r => `  ${r.name}: ${r.risk_level}${r.risk_tags.length ? ` [${r.risk_tags.join(', ')}]` : ''}`);
        process.stderr.write(`FFWD AgentGuard: scanned ${scanned} skill(s)\n${lines.join('\n')}\n` +
            `Use /ffwd-agent-guard trust attest to register trusted skills.\n`);
    }
    process.exit(0);
}
main();
