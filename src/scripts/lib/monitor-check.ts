// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, writeFileSync, renameSync, realpathSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { CollectorLogsConfig } from '../../adapters/config-schema.js';
import { loadMonitorAllSessions } from './config-loader.js';

const UNTRUSTED_SESSION_IDS: Record<string, true> = { '': true, unknown: true, openclaw: true };
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PENDING_ARM_TTL_MS = 60_000;

const SessionConsentSchema = z.object({ armed_at: z.number().finite(), cwd: z.string() });
const MonitorStoreSchema = z.object({
  sessions: z.record(SessionConsentSchema),
  pending_arm: z.object({ at: z.number().finite(), cwd: z.string() }).optional(),
});
type MonitorStore = z.infer<typeof MonitorStoreSchema>;

function canonicalCwd(cwd: string): string {
  try { return realpathSync(cwd); } catch { return cwd; }
}

// Read the existing monitor consent format without adding a management surface.
export function isSessionMonitored(
  sessionId: string,
  cwd: string | null,
  logsConfig?: CollectorLogsConfig,
): boolean {
  if (typeof sessionId !== 'string' || Object.hasOwn(UNTRUSTED_SESSION_IDS, sessionId)) return false;
  try {
    if (loadMonitorAllSessions()) return true;
    const home = process.env['NIO_HOME'] || join(homedir(), '.nio');
    const auditPath = logsConfig?.path?.replace(/^~\//, `${homedir()}/`);
    const path = join(auditPath ? dirname(auditPath) : home, 'monitored-sessions.json');
    const store = MonitorStoreSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    const now = Date.now();
    const consent = store.sessions?.[sessionId];
    if (consent && now - consent.armed_at <= SESSION_TTL_MS) {
      return true;
    }
    const pending = store.pending_arm;
    const canClaim = pending && Number.isFinite(pending.at) && typeof pending.cwd === 'string'
      && now - pending.at <= PENDING_ARM_TTL_MS && cwd !== null
      && pending.cwd === canonicalCwd(cwd);
    if (!canClaim) return false;
    const lockPath = `${path}.lock`;
    const lock = openSync(lockPath, 'wx', 0o600);
    try {
      const current = MonitorStoreSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
      const armed = current.sessions[sessionId];
      if (armed && Date.now() - armed.armed_at <= SESSION_TTL_MS) return true;
      const arm = current.pending_arm;
      const stillClaimable = arm && Date.now() - arm.at <= PENDING_ARM_TTL_MS
        && cwd !== null && arm.cwd === canonicalCwd(cwd);
      if (!stillClaimable) return false;
      const next: MonitorStore = {
        sessions: { ...current.sessions, [sessionId]: { armed_at: Date.now(), cwd: arm.cwd } },
      };
      const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
      try {
        writeFileSync(tmp, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
        renameSync(tmp, path);
      } catch (error) {
        try { unlinkSync(tmp); } catch { /* best effort */ }
        throw error;
      }
      return true;
    } finally {
      closeSync(lock);
      unlinkSync(lockPath);
    }
  } catch {
    return false;
  }
}
