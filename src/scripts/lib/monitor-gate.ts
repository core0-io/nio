// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Monitor gate — decides whether a given session's telemetry may leave
 * the machine.
 *
 * Pure: takes a store snapshot in, returns a verdict plus the store as
 * it should be persisted. The caller owns all filesystem IO, mirroring
 * how `traces-collector.ts` stays pure while `collector-core.ts`
 * orchestrates load → mutate → save.
 *
 * Default posture is silence. A session emits telemetry only when the
 * user explicitly armed it (`/nio-monitor`) or when the operator set
 * `collector.monitor_all_sessions: true` globally.
 */

import type { MonitorStore } from './monitor-store.js';

/**
 * How long a `pending_arm` stays claimable. Short on purpose: the arm is
 * meant to be picked up by the very next hook event of the session the
 * user just typed into. A long window would let an unrelated concurrent
 * session in the same directory steal it.
 */
export const PENDING_ARM_TTL_MS = 60_000;

/**
 * Backstop expiry for armed sessions. `SessionEnd` normally removes the
 * record; this catches sessions that died without firing it, so the
 * store cannot grow without bound.
 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface GateInput {
  store: MonitorStore;
  sessionId: string;
  cwd: string | null;
  monitorAllSessions: boolean;
  nowMs: number;
}

export interface GateResult {
  /** Whether this session's telemetry may be exported. */
  monitored: boolean;
  /** The store as it should be persisted. */
  store: MonitorStore;
  /** True when `store` differs from the input and needs saving. */
  changed: boolean;
}

/** Drop session records past SESSION_TTL_MS. Returns null when nothing changed. */
function gcExpiredSessions(
  sessions: MonitorStore['sessions'],
  nowMs: number,
): MonitorStore['sessions'] | null {
  const live: MonitorStore['sessions'] = {};
  let dropped = false;
  for (const [id, entry] of Object.entries(sessions)) {
    if (nowMs - entry.armed_at > SESSION_TTL_MS) {
      dropped = true;
      continue;
    }
    live[id] = entry;
  }
  return dropped ? live : null;
}

export function resolveMonitorGate(input: GateInput): GateResult {
  const { store, sessionId, cwd, monitorAllSessions, nowMs } = input;

  // Global override — never touches the store. Operators who set this
  // want blanket capture and should not have their store churned by
  // every hook event.
  if (monitorAllSessions) {
    return { monitored: true, store, changed: false };
  }

  let changed = false;
  let sessions = store.sessions;
  let pendingArm = store.pending_arm;

  const gcd = gcExpiredSessions(sessions, nowMs);
  if (gcd) {
    sessions = gcd;
    changed = true;
  }

  // Expired arm: drop it before anyone can claim it.
  if (pendingArm && nowMs - pendingArm.at > PENDING_ARM_TTL_MS) {
    pendingArm = undefined;
    changed = true;
  }

  const armed = sessions[sessionId];
  if (armed) {
    const next: MonitorStore = { sessions };
    if (pendingArm) next.pending_arm = pendingArm;
    return { monitored: true, store: next, changed };
  }

  // Claim a fresh arm whose cwd matches this event's. cwd matching is
  // what keeps two concurrent sessions from stealing each other's arm.
  if (pendingArm && cwd !== null && pendingArm.cwd === cwd) {
    const next: MonitorStore = {
      sessions: { ...sessions, [sessionId]: { armed_at: nowMs, cwd } },
    };
    return { monitored: true, store: next, changed: true };
  }

  const next: MonitorStore = { sessions };
  if (pendingArm) next.pending_arm = pendingArm;
  return { monitored: false, store: next, changed };
}
