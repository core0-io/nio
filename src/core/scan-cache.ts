/**
 * ScanCache — lightweight in-memory + file-backed cache of scan results.
 *
 * Written by ScanOrchestrator after each scan. Read by RuntimeAnalyser
 * to incorporate prior scan intelligence into guard decisions.
 *
 * Cache file: ~/.ffwd-agent-guard/scan-cache.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { RiskLevel } from '../types/scanner.js';

// ── Types ───────────────────────────────────────────────────────────────

export interface ScanCacheEntry {
  /** Skill or directory identifier */
  skill_id: string;
  /** When the scan was performed (ISO 8601) */
  scan_time: string;
  /** Hash of the scanned artifact (for staleness detection) */
  artifact_hash: string;
  /** Aggregate risk level */
  risk_level: RiskLevel;
  /** Total number of findings */
  finding_count: number;
  /** Critical findings count */
  critical_findings: number;
  /** High findings count */
  high_findings: number;
}

interface ScanCacheData {
  version: 1;
  entries: Record<string, ScanCacheEntry>;
}

// ── ScanCache ───────────────────────────────────────────────────────────

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class ScanCache {
  private data: ScanCacheData;
  private filePath: string;

  constructor(filePath?: string) {
    const dir = process.env.FFWD_AGENT_GUARD_HOME || join(homedir(), '.ffwd-agent-guard');
    this.filePath = filePath || join(dir, 'scan-cache.json');
    this.data = this.load();
  }

  /** Get a cache entry by skill ID. Returns null if missing or stale. */
  get(skillId: string): ScanCacheEntry | null {
    const entry = this.data.entries[skillId];
    if (!entry) return null;

    // Check TTL
    const age = Date.now() - new Date(entry.scan_time).getTime();
    if (age > CACHE_TTL_MS) {
      delete this.data.entries[skillId];
      return null;
    }

    return entry;
  }

  /** Write or update a cache entry. Persists to disk. */
  set(entry: ScanCacheEntry): void {
    this.data.entries[entry.skill_id] = entry;
    this.save();
  }

  /** Remove a cache entry. */
  remove(skillId: string): void {
    delete this.data.entries[skillId];
    this.save();
  }

  /** List all non-stale entries. */
  list(): ScanCacheEntry[] {
    const now = Date.now();
    const entries: ScanCacheEntry[] = [];

    for (const [key, entry] of Object.entries(this.data.entries)) {
      const age = now - new Date(entry.scan_time).getTime();
      if (age > CACHE_TTL_MS) {
        delete this.data.entries[key];
      } else {
        entries.push(entry);
      }
    }

    return entries;
  }

  /** Purge all stale entries and save. */
  prune(): number {
    const before = Object.keys(this.data.entries).length;
    this.list(); // side-effect: removes stale entries
    this.save();
    return before - Object.keys(this.data.entries).length;
  }

  // ── Persistence ─────────────────────────────────────────────────────

  private load(): ScanCacheData {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw) as ScanCacheData;
        if (parsed.version === 1 && parsed.entries) {
          return parsed;
        }
      }
    } catch {
      // Corrupt or missing — start fresh
    }
    return { version: 1, entries: {} };
  }

  private save(): void {
    try {
      const dir = this.filePath.replace(/[/\\][^/\\]+$/, '');
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch {
      // Non-critical — cache is best-effort
    }
  }
}
