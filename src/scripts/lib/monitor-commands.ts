// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Monitor commands — the single implementation of `on` / `off` /
 * `status` behind every `/nio-monitor` surface.
 *
 * Two entry points share it:
 *
 * - `monitor-cli.ts`, the bundled script the Claude Code / Codex skills
 *   shell out to.
 * - `openclaw-dispatch.ts`'s `monitor` subcommand, which is the *only*
 *   way to arm a session on OpenClaw and Hermes — neither platform
 *   installs the focused `nio-*` skills, so `/nio monitor …` is their
 *   sole entry point (Hermes reaches this same dispatcher through
 *   `nio-cli.ts`).
 *
 * Keeping the bodies here rather than duplicating them means the two
 * surfaces cannot answer differently.
 *
 * `status` reuses `resolveMonitorGate` — the very function
 * `monitor-check.ts` runs on the hook side — rather than re-deriving "is
 * this monitored" from its own `sessionId in store.sessions` lookup.
 * `status` is the only reading a user gets of where the privacy boundary
 * currently sits, so a second implementation of the verdict is a bug
 * generator: such a lookup ignores both SESSION_TTL_MS (a record older
 * than 7 days reads as `monitored: true` while the hooks reject and GC
 * it) and `pending_arm` (on the platforms that always take the pending
 * path, `on` followed immediately by `status` reads as
 * `monitored: false, armed_sessions: 0` — indistinguishable from `on`
 * having silently failed).
 */

import { loadLogsConfig, loadMonitorAllSessions } from './config-loader.js';
import {
  loadMonitorStore,
  saveMonitorStore,
  canonicaliseCwd,
  type MonitorStore,
} from './monitor-store.js';
import { resolveMonitorGate } from './monitor-gate.js';

/**
 * Environment variables that carry the host's session id. Only Claude
 * Code is listed — it is the one platform whose variable has been
 * verified on a real session. Other platforms fall through to the
 * pending-arm path until their variables are confirmed.
 */
const SESSION_ENV_VARS = ['CLAUDE_CODE_SESSION_ID'] as const;

export function resolveSessionId(): string | null {
  for (const name of SESSION_ENV_VARS) {
    const value = process.env[name];
    if (value && value.length > 0) return value;
  }
  return null;
}

export type MonitorSubcommand = 'on' | 'off' | 'status';

export const MONITOR_SUBCOMMANDS: readonly MonitorSubcommand[] = ['on', 'off', 'status'];

/**
 * Map the words a user (or the skill's routing table) may type onto the
 * three canonical subcommands. Returns null for anything unrecognised so
 * callers can print their own usage text.
 */
export function normaliseMonitorSubcommand(raw: string): MonitorSubcommand | null {
  switch (raw.trim().toLowerCase()) {
    case '':
    case 'on':
    case 'start':
      return 'on';
    case 'off':
    case 'stop':
      return 'off';
    case 'status':
    case 'show':
      return 'status';
    default:
      return null;
  }
}

export interface MonitorOnResult {
  action: 'on';
  /** `direct` — bound to a resolved session id. `pending` — waiting to be claimed. */
  mode: 'direct' | 'pending';
  session_id: string | null;
  /** Directory the pending arm is keyed to (`pending` mode only). */
  cwd?: string;
}

export interface MonitorOffResult {
  action: 'off';
  /** True when at least one armed session record was actually deleted. */
  removed: boolean;
  /** How many armed session records were deleted. */
  removed_sessions: number;
  /**
   * How the records to delete were chosen:
   *
   * - `session` — the host exposed a session id and only that session's
   *   record was touched.
   * - `cwd` — no session id was resolvable, so every armed session whose
   *   record is keyed to this directory was removed. See the `off`
   *   branch of `runMonitorCommand` for why that is the correct fallback.
   */
  matched_by: 'session' | 'cwd';
}

export interface MonitorStatusResult {
  action: 'status';
  monitor_all_sessions: boolean;
  session_id: string | null;
  /**
   * Whether *this* session is being captured right now.
   *
   * Only meaningful when `session_undetermined` is false. When that flag
   * is true there is no session id to look up, so this field is `false`
   * in the weak sense of "not known to be monitored" — never read it on
   * its own, or you will tell a user capture is off while the hooks are
   * still exporting. Read `session_undetermined` first.
   */
  monitored: boolean;
  /**
   * The honest "I cannot answer that" case: this platform exposes no
   * session id (Codex / Hermes / OpenClaw all take this path) *and* the
   * store holds at least one live armed session. One of those records
   * may well be this very session — it would have been created by a hook
   * event claiming a pending arm, using an id only the hook ever saw —
   * but nothing readable from this process can decide which.
   *
   * With `armed_sessions: 0` the answer is not in doubt (nothing is
   * armed anywhere, so this session is certainly not being captured) and
   * this stays false.
   */
  session_undetermined: boolean;
  /**
   * A live, unclaimed `pending_arm` is sitting in the store: capture has
   * been requested but has not bound to a session yet. It binds on the
   * next hook event from the directory `on` was run in.
   */
  pending_arm: boolean;
  armed_sessions: number;
}

export type MonitorResult = MonitorOnResult | MonitorOffResult | MonitorStatusResult;

export interface MonitorCommandOptions {
  /**
   * Directory a pending arm is keyed to. Defaults to the calling
   * process's cwd — which is what the CLI wants, and is also what the
   * OpenClaw daemon's own hook handlers pass to `isSessionMonitored`, so
   * the two agree on what "this directory" means.
   */
  cwd?: string;
}

export function runMonitorCommand(
  command: MonitorSubcommand,
  options: MonitorCommandOptions = {},
): MonitorResult {
  const logsConfig = loadLogsConfig();
  const store = loadMonitorStore(logsConfig);
  const sessionId = resolveSessionId();
  // Canonicalised HERE, at the point it enters the store, rather than
  // only where it is compared. The gate canonicalises the event's cwd
  // before matching it against `pending_arm.cwd`
  // (`isSessionMonitored`), so an arm stored in unresolved form can
  // never be claimed — and on macOS anything under `/tmp` or `/var`
  // arrives unresolved from a host that hands us a session directory.
  const cwd = canonicaliseCwd(options.cwd ?? process.cwd());
  const now = Date.now();

  if (command === 'on') {
    if (sessionId) {
      const next: MonitorStore = {
        sessions: { ...store.sessions, [sessionId]: { armed_at: now, cwd } },
        // Preserve any pending arm: it belongs to a different session
        // (possibly on another platform sharing this NIO_HOME) that is
        // still waiting for its first hook event to claim it. Dropping it
        // here would silently un-arm that session.
        ...(store.pending_arm ? { pending_arm: store.pending_arm } : {}),
      };
      saveMonitorStore(logsConfig, next);
      return { action: 'on', mode: 'direct', session_id: sessionId };
    }
    const next: MonitorStore = {
      sessions: store.sessions,
      pending_arm: { at: now, cwd },
    };
    saveMonitorStore(logsConfig, next);
    return { action: 'on', mode: 'pending', session_id: null, cwd };
  }

  if (command === 'off') {
    const sessions = { ...store.sessions };
    let removedCount = 0;
    let matchedBy: 'session' | 'cwd';

    if (sessionId) {
      // The host told us exactly which session this is, so honour it
      // literally. Sweeping the directory as well would be actively
      // wrong here: two Claude Code sessions in one project directory
      // are independent, and `off` in one must not disarm the other.
      matchedBy = 'session';
      if (sessionId in sessions) {
        delete sessions[sessionId];
        removedCount = 1;
      }
    } else {
      // No resolvable session id — Codex, Hermes and OpenClaw are all
      // here, permanently, because SESSION_ENV_VARS lists only Claude
      // Code's variable. These are precisely the platforms that must
      // take the pending-arm route: `on` writes `pending_arm`, and the
      // next hook event claims it into `sessions[<id the hook saw>]`.
      // That id is never visible from this process, so keying `off` off
      // it deletes nothing and leaves the session exporting for the full
      // 7-day TTL — worst on Codex, which has no SessionEnd hook to
      // clean up behind it.
      //
      // So `off` falls back to the same key the arm was *claimed* by:
      // the directory. This is the exact inverse of the claim rule in
      // `resolveMonitorGate` (`pendingArm.cwd === cwd`), which is what
      // makes it correct rather than a guess — anything armed from here
      // was armed by an `on` typed here.
      //
      // Every match in this directory goes, not just one. Concurrent
      // sessions sharing a directory make the choice ambiguous, and the
      // two ways to be wrong are not symmetric: deleting one too many
      // costs some uncollected telemetry the user can restore with
      // another `on`, while deleting one too few keeps shipping data the
      // user was just told was off. `off` is a privacy control, so it
      // resolves ambiguity towards silence.
      matchedBy = 'cwd';
      const target = canonicaliseCwd(cwd);
      for (const [id, entry] of Object.entries(sessions)) {
        if (canonicaliseCwd(entry.cwd) === target) {
          delete sessions[id];
          removedCount++;
        }
      }
    }

    // Saving without `pending_arm` is what clears it.
    saveMonitorStore(logsConfig, { sessions });
    return {
      action: 'off',
      removed: removedCount > 0,
      removed_sessions: removedCount,
      matched_by: matchedBy,
    };
  }

  return statusResult(store, sessionId, now);
}

/**
 * Read-only projection of the hook-side gate.
 *
 * Two things this must NOT do, both of which would turn a question into
 * an action: claim the pending arm, and persist the expiry sweep. So
 * `cwd` is passed as `null` — the gate's claim branch requires a cwd
 * match, which a null cwd can never satisfy — and the `changed` flag the
 * gate hands back is deliberately ignored. Nothing here touches disk.
 *
 * A live-but-unclaimed pending arm therefore surfaces as
 * `monitored: false, pending_arm: true`, which is the honest reading:
 * capture starts at the next hook event from the arming directory, not
 * now.
 *
 * `monitorAllSessions` is passed as `false` on purpose even when the
 * global flag is on: the flag short-circuits the gate before it ever
 * looks at the store, and we still want the store's own truth (live
 * session count, pending arm) to report alongside it. The flag is then
 * OR-ed back into `monitored`, exactly as the gate itself would have.
 */
function statusResult(
  store: MonitorStore,
  sessionId: string | null,
  now: number,
): MonitorStatusResult {
  const monitorAll = loadMonitorAllSessions();
  const gate = resolveMonitorGate({
    store,
    // No resolvable session id means there is no key to look up. The
    // empty string is one of the sentinels the hook-side guard rejects
    // outright, so it can never match a real record.
    sessionId: sessionId ?? '',
    cwd: null,
    monitorAllSessions: false,
    nowMs: now,
  });

  // Counted off the gate's post-sweep store, so a record past
  // SESSION_TTL_MS is not reported as armed when the hooks would reject
  // it.
  const armedSessions = Object.keys(gate.store.sessions).length;

  // Without a session id the store lookup above was never a real
  // question — it looked up the empty string, which by construction
  // matches nothing. Reporting its `false` as the verdict is a lie on
  // exactly the platforms that always take the pending-arm path: their
  // armed record is keyed by an id only the hook process ever saw, so a
  // session that *is* being captured reads as `monitored: false` here.
  // Say so instead. `monitor_all_sessions` needs no such hedge — it
  // short-circuits the gate for every session, id or no id.
  const undetermined = !monitorAll && sessionId === null && armedSessions > 0;

  return {
    action: 'status',
    monitor_all_sessions: monitorAll,
    session_id: sessionId,
    monitored: monitorAll || gate.monitored,
    session_undetermined: undetermined,
    pending_arm: gate.store.pending_arm !== undefined,
    armed_sessions: armedSessions,
  };
}
