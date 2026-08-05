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
 *
 * Telemetry gate: like `collector-hook.ts` / `guard-hook.ts` / Hermes's
 * `hook-cli.ts`, the OTLP leg of this hook's audit writes is gated on
 * `isSessionMonitored`. Without it this hook would be the one hole in
 * the session gate — a SessionStart event carries the full inventory of
 * installed skills plus each one's risk level and risk tags, and it
 * would leave the machine before the user ever had a chance to arm the
 * session. The local `audit.jsonl` leg is *not* gated (same rule as
 * every other hook).
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { loadCollectorConfig, loadAgentName, loadLogsConfig } from './lib/config-loader.js';
import { createLoggerProvider } from './lib/logs-collector.js';
import { reportFlushFailure } from './lib/exporter-diagnostics.js';
import { isSessionMonitored } from './lib/monitor-check.js';
import { dumpPayload } from './lib/payload-dump.js';
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
const AGENT_NAME = loadAgentName();   // empty when unset/empty

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SKILLS_DIRS = [
  join(homedir(), '.claude', 'skills'),
  join(homedir(), '.codex', 'skills'),
  join(homedir(), '.openclaw', 'skills'),
];

// ---------------------------------------------------------------------------
// Session monitor gate
// ---------------------------------------------------------------------------

/**
 * Whether this session's telemetry may be exported. Resolved once in
 * `main()` from the SessionStart stdin payload, before a single audit
 * entry is written. It starts `false` so that no code path can create an
 * OTLP exporter ahead of the decision — the gate fails closed.
 */
let MONITORED = false;

/** Shape of the SessionStart payload we care about. */
interface SessionStartPayload {
  session_id?: string;
  cwd?: string;
}

/**
 * Budget for reading the hook payload from stdin.
 *
 * Deliberately much shorter than the collector hook's 5s: SessionStart
 * gives this hook a 30s total budget that it also has to spend scanning
 * every installed skill. Both Claude Code and Codex pipe the payload and
 * close stdin immediately, so this only ever matters when the hook is
 * invoked with no payload at all — in which case we fall through to
 * "unmonitored" and skip the OTLP leg, which is the safe answer.
 */
const STDIN_TIMEOUT_MS = 2000;

function readSessionStartPayload(): Promise<SessionStartPayload | null> {
  return new Promise((resolve) => {
    // A TTY stdin never ends (someone ran the hook by hand) — don't
    // stall the scan waiting for an EOF that isn't coming.
    if (process.stdin.isTTY) {
      resolve(null);
      return;
    }
    let data = '';
    let settled = false;
    const timer = setTimeout(() => finish(null), STDIN_TIMEOUT_MS);
    function finish(value: SessionStartPayload | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => (data += chunk));
    process.stdin.on('end', () => {
      try {
        finish(JSON.parse(data) as SessionStartPayload);
      } catch {
        finish(null);
      }
    });
    process.stdin.on('error', () => finish(null));
  });
}

// LoggerProvider for OTEL audit log export (lazy-initialized).
// createLoggerProvider already short-circuits on missing endpoint or
// collector.logs.enabled === false; the MONITORED check in front of it
// is what keeps an unarmed session from ever constructing an exporter.
let _loggerProvider: import('@opentelemetry/sdk-logs').LoggerProvider | null | undefined;

// Upper bound on how long the exit path waits for forceFlush()+shutdown()
// to drain the logs pipeline. `collector.timeout` is honored when it's
// smaller (a caller who wants a tighter budget can set one), but this is
// the hard ceiling — see the comment above the shutdown call in main()
// for why an unroutable endpoint would otherwise block on the OS TCP
// connect timeout (~75s+). Same backstop-timer pattern as
// `WRITE_CALLBACK_BACKSTOP_MS` in hook-cli.ts.
const SHUTDOWN_BACKSTOP_MS = 5000;
function getLoggerProvider(): import('@opentelemetry/sdk-logs').LoggerProvider | null {
  if (!MONITORED) return null;
  if (_loggerProvider === undefined) {
    try {
      const resourceAgentName = AGENT_NAME.length > 0 ? AGENT_NAME : undefined;
      _loggerProvider = createLoggerProvider(loadCollectorConfig(), PLATFORM, resourceAgentName);
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
  // Resolve the telemetry gate first, from the SessionStart payload.
  // Everything below this point may write audit entries, and the OTLP
  // leg of those writes must not be reachable before the decision.
  // Never let a gate failure break session startup: any throw leaves
  // MONITORED at its fail-closed default.
  try {
    const payload = await readSessionStartPayload();
    // Debug-only sampling switch — dumps the raw SessionStart payload
    // (a different shape from the other hooks' PreToolUse/PostToolUse
    // events). Deliberately NOT behind the MONITORED gate below: see
    // lib/payload-dump.ts module doc for why. Runtime object may carry
    // fields beyond the narrow SessionStartPayload type — those are
    // preserved as-is since the cast above doesn't strip them.
    if (payload) dumpPayload(PLATFORM, 'SessionStart', payload);
    MONITORED = isSessionMonitored(
      payload?.session_id ?? 'unknown',
      payload?.cwd ?? null,
      loadLogsConfig(),
    );
  } catch {
    MONITORED = false;
  }

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
        ...(AGENT_NAME ? { agent_name: AGENT_NAME } : {}),
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

  // Drain before exiting. The logs pipeline uses a
  // SimpleLogRecordProcessor whose export is a fire-and-forget promise,
  // and its `forceFlush()` only awaits records still waiting on async
  // resource attributes — not the in-flight HTTP requests. So
  // `process.exit(0)` can tear the process down mid-POST. `shutdown()`
  // is the call that actually awaits the exporter's request queue
  // (OTLPExportDelegate.shutdown → forceFlush → promiseQueue.awaitAll).
  // Only reachable when a provider was created at all, i.e. only for a
  // monitored session.
  //
  // `shutdown()` is NOT bounded by `collector.timeout` — that config
  // only governs the request-timeout once a socket is connected; it does
  // nothing during TCP connect. Against an endpoint that silently drops
  // packets (firewalled/unroutable IP, VPN torn down) connect() blocks
  // until the OS-level TCP timeout, which is ~75s on macOS and can be
  // over 100s on Linux — far past any caller's patience. So this needs
  // its own external backstop, same pattern as `WRITE_CALLBACK_BACKSTOP_MS`
  // in hook-cli.ts: race the drain against a timer and exit regardless of
  // which one wins.
  if (_loggerProvider) {
    const collectorConfig = loadCollectorConfig();
    const endpoint = collectorConfig.endpoint;
    const budget = Math.min(collectorConfig.timeout ?? SHUTDOWN_BACKSTOP_MS, SHUTDOWN_BACKSTOP_MS);
    await Promise.race([
      (async () => {
        await _loggerProvider!.forceFlush().catch((e) => reportFlushFailure('logs', endpoint, e));
        await _loggerProvider!.shutdown().catch((e) => reportFlushFailure('logs', endpoint, e));
      })(),
      new Promise<void>((resolve) => setTimeout(resolve, budget).unref()),
    ]);
  }

  process.exit(0);
}

main();
