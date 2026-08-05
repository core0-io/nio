// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Monitor store — owns `monitored-sessions.json`, the persistent record
 * of which sessions the user explicitly opted into telemetry for.
 *
 * Deliberately separate from `traces-state-store.json`: that file holds
 * turn-scoped ephemeral state (cleared every turn), this one holds
 * session-scoped durable state. Different lifecycles, different files.
 *
 * Path: derived from `collector.logs.path` so it sits next to the audit
 * log, same convention as the traces state store. Default
 * `${NIO_HOME ?? ~/.nio}/monitored-sessions.json`.
 */

import {
  readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync, realpathSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { CollectorLogsConfig } from '../../adapters/config-schema.js';

/** A session the user explicitly armed via `/nio-monitor`. */
export interface MonitoredSession {
  armed_at: number;
  cwd: string;
}

/**
 * A pending arm request from a platform where the CLI could not resolve
 * the session id itself. The next hook event matching `cwd` within the
 * TTL claims it.
 */
export interface PendingArm {
  at: number;
  cwd: string;
}

export interface MonitorStore {
  sessions: Record<string, MonitoredSession>;
  pending_arm?: PendingArm;
}

const STORE_FILE_NAME = 'monitored-sessions.json';

/**
 * Resolve a directory to its canonical form so `cwd` comparisons survive
 * symlinks.
 *
 * Every cwd in this store is compared against some other cwd sooner or
 * later — the gate matches `pending_arm.cwd` against a hook payload's
 * cwd, and `/nio-monitor off` matches an armed record's cwd against the
 * caller's. The two sides arrive in different forms: `monitor-cli`
 * stamps `process.cwd()`, which POSIX always reports resolved
 * (`/private/var/...` on macOS, where `/var` is a symlink), while hook
 * payloads carry whatever form the host chose, which may be the
 * unresolved one (`/var/...`). Comparing them raw makes an arm
 * unclaimable — and, worse for `off`, undeletable — on any machine whose
 * working directory sits under a symlink, which on macOS includes
 * everything under `/tmp`.
 *
 * Falls back to the input when the path cannot be resolved (it may not
 * exist any more); a best-effort canonical form still beats no
 * comparison. Lives here, next to the records whose `cwd` field it
 * normalises, so the gate and the `off` command cannot drift apart on
 * what "the same directory" means.
 */
export function canonicaliseCwd(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

function defaultStoreDir(): string {
  return process.env['NIO_HOME'] || join(homedir(), '.nio');
}

function isPlainObject(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidSession(entry: unknown): entry is MonitoredSession {
  if (!isPlainObject(entry)) return false;
  const e = entry as Record<string, unknown>;
  return typeof e.armed_at === 'number' && typeof e.cwd === 'string';
}

function isValidPendingArm(entry: unknown): entry is PendingArm {
  if (!isPlainObject(entry)) return false;
  const e = entry as Record<string, unknown>;
  return typeof e.at === 'number' && typeof e.cwd === 'string';
}

/** Resolve the store location — next to the audit log. */
export function monitorStorePath(logsConfig?: CollectorLogsConfig): string {
  const auditPath = logsConfig?.path ? expandHome(logsConfig.path) : null;
  const dir = auditPath ? dirname(auditPath) : defaultStoreDir();
  return join(dir, STORE_FILE_NAME);
}

function normalizeStore(parsed: Partial<MonitorStore>): MonitorStore {
  // Normalize sessions: must be a plain object with valid entries only
  let sessions: Record<string, MonitoredSession> = {};
  if (isPlainObject(parsed.sessions)) {
    const s = parsed.sessions as Record<string, unknown>;
    for (const [key, entry] of Object.entries(s)) {
      if (isValidSession(entry)) {
        sessions[key] = entry;
      }
    }
  }

  const store: MonitorStore = { sessions };

  // Normalize pending_arm: must be valid or omitted entirely
  if (isValidPendingArm(parsed.pending_arm)) {
    store.pending_arm = parsed.pending_arm;
  }

  return store;
}

/**
 * Load the store. Returns an empty store when the file is missing or
 * corrupt — a broken store must never enable telemetry that the user
 * did not ask for, and must never crash the hook.
 */
export function loadMonitorStore(logsConfig?: CollectorLogsConfig): MonitorStore {
  const path = monitorStorePath(logsConfig);

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    // Absent store is the normal default state (the overwhelming
    // majority of users have never armed a session) — not a fault.
    return { sessions: {} };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<MonitorStore>;
    return normalizeStore(parsed);
  } catch (err) {
    // A store that exists but cannot be parsed silently disables capture
    // for every session — the user sees "I armed it but no data" with no
    // clue why. Surface it. `/nio-monitor on` overwrites the bad file, so
    // this is self-healing once noticed.
    //
    // Dynamic import, not awaited: this function sits on the hook's
    // synchronous gating hot path and must never turn async, and
    // diagnostics reporting must never be able to throw back into it.
    void import('../../adapters/diagnostics.js')
      .then(({ reportDiagnostic }) => {
        reportDiagnostic({
          severity: 'warning',
          source: 'collector',
          kind: 'monitor_store_corrupt',
          message: '[nio] monitored-sessions.json is unreadable; no session will be captured',
          detail: err instanceof Error ? err.message : String(err),
          hint: 'Run /nio-monitor on to rewrite it, or delete the file.',
        });
      })
      .catch(() => { /* diagnostics must never break the gate */ });
    return { sessions: {} };
  }
}

/** Persist the store atomically. Creates the parent directory if missing. */
export function saveMonitorStore(
  logsConfig: CollectorLogsConfig | undefined,
  store: MonitorStore,
): void {
  const path = monitorStorePath(logsConfig);
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // Write-then-rename: several processes touch this file concurrently
  // (guard-hook and collector-hook both fire on one PreToolUse, and
  // `/nio-monitor off` can race a hook's expiry sweep). A truncating
  // write would let a reader observe half a JSON document; rename is
  // atomic within a filesystem, so a reader sees either the old store
  // or the new one.
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf-8');
    renameSync(tmp, path);
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}
