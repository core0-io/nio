// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Monitor check — the one place that turns the pure gate decision into
 * a filesystem-backed answer.
 *
 * Claude Code (`collector-hook.ts`, `guard-hook.ts`) and Codex CLI (same
 * two files, `--platform codex`) call this before creating any OTEL
 * provider — each hook event is a fresh process, so the gate can be
 * decided once, up front. Hermes (`hook-cli.ts`) does the same: also a
 * fresh process per event. OpenClaw (`openclaw-plugin.ts`) is a
 * long-running daemon: it creates its providers lazily, on the first
 * event this function answers `true` for, and then shares them across
 * every session for the process's lifetime. So it calls this inside
 * each event handler instead, keyed by that event's session id, and
 * skips only the OTEL-writing part of the handler when unmonitored.
 * All four platforms are wired in.
 * Keeping the check in a single module means the load → decide →
 * persist sequence cannot drift between platforms regardless of which
 * of the two call patterns they use.
 *
 * Fails closed: any error answers "not monitored". Telemetry must never
 * escape because a state file was unreadable, and a hook must never die
 * because of the gate.
 */

import type { CollectorLogsConfig } from '../../adapters/config-schema.js';
import { loadMonitorStore, saveMonitorStore, canonicaliseCwd } from './monitor-store.js';
import { resolveMonitorGate } from './monitor-gate.js';
import { loadMonitorAllSessions } from './config-loader.js';

/**
 * Session ids that are placeholders, not identities.
 *
 * Every one of these is a literal a call site substitutes when the host
 * gave it nothing: `''`, `?? 'unknown'` in the Claude Code / Codex /
 * Hermes hooks, and `|| 'openclaw'` in the ctx fallbacks in
 * `openclaw-plugin.ts`. They are fine as a label on an audit record and
 * catastrophic as a store key: because every id-less event collapses
 * onto the *same* literal, one user arming one session would arm that
 * key for every id-less event from every directory, for the full 7-day
 * TTL.
 *
 * Exported so the shape of "an id we refuse to trust" has a single
 * definition, and so a new platform adding its own fallback literal has
 * an obvious place to declare it.
 */
export const UNTRUSTED_SESSION_IDS: ReadonlySet<string> = new Set([
  '',
  'unknown',
  'openclaw',
]);

/**
 * Decide whether this session's telemetry may be exported, persisting
 * any store change (pending-arm claim, expiry GC) as a side effect.
 */
export function isSessionMonitored(
  sessionId: string,
  cwd: string | null,
  logsConfig?: CollectorLogsConfig,
): boolean {
  // A session id we cannot trust is never monitored, and never claims a
  // pending arm. This check must run before loadMonitorStore so such an
  // event never gets a chance to claim a pending arm either.
  if (typeof sessionId !== 'string' || UNTRUSTED_SESSION_IDS.has(sessionId)) {
    return false;
  }
  try {
    const store = loadMonitorStore(logsConfig);
    const result = resolveMonitorGate({
      store,
      sessionId,
      cwd: cwd === null ? null : canonicaliseCwd(cwd),
      monitorAllSessions: loadMonitorAllSessions(),
      nowMs: Date.now(),
    });
    if (result.changed) {
      saveMonitorStore(logsConfig, result.store);
    }
    return result.monitored;
  } catch {
    return false;
  }
}

/**
 * Platforms whose `SessionEnd` does not actually end the session.
 *
 * Hermes fires `on_session_end` at the end of every TURN — one
 * SessionStart against many SessionEnd under a single `session_id`, with
 * the host still using that session after each one. Treating it as a
 * real teardown makes `forgetSession` disarm a session that is still
 * running, so `/nio monitor on` buys a single turn of capture and then
 * goes silent, leaving a store that looks as though nothing was ever
 * armed. Nothing else in the SessionEnd branch has to change: emitting
 * the session span and discarding the turn state per turn is
 * self-correcting, but deleting the user's arm is not — nothing
 * re-creates it.
 *
 * These platforms fall back to `SESSION_TTL_MS`, exactly as Codex already
 * does — it has no session-end hook at all — plus `/nio monitor off`,
 * which disarms by cwd on precisely the platforms that arm by cwd.
 *
 * Declared here, next to the store it protects, so a platform whose
 * lifecycle events are turn-scoped has one obvious place to say so.
 */
export const PER_TURN_SESSION_END_PLATFORMS: ReadonlySet<string> = new Set([
  'hermes',
]);

/**
 * Whether a `SessionEnd` from this platform is authoritative enough to
 * drop the session's arm record.
 */
export function sessionEndDisarms(platform: string): boolean {
  return !PER_TURN_SESSION_END_PLATFORMS.has(platform);
}

/**
 * Drop a session's arm record. Called on SessionEnd so a finished
 * session does not linger in the store until the 7-day backstop.
 * Never throws — cleanup failure must not break session teardown.
 *
 * Callers on the hook path must gate this behind {@link sessionEndDisarms}
 * — see its docblock for the platform whose SessionEnd is a turn
 * boundary.
 */
export function forgetSession(
  sessionId: string,
  logsConfig?: CollectorLogsConfig,
): void {
  try {
    const store = loadMonitorStore(logsConfig);
    if (!(sessionId in store.sessions)) return;
    const sessions = { ...store.sessions };
    delete sessions[sessionId];
    const next = { sessions, ...(store.pending_arm ? { pending_arm: store.pending_arm } : {}) };
    saveMonitorStore(logsConfig, next);
  } catch {
    // Cleanup is best-effort; the TTL backstop covers failures.
  }
}
