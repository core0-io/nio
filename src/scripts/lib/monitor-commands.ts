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
 * `status` goes further and reuses `resolveMonitorGate` — the very
 * function `monitor-check.ts` runs on the hook side — rather than
 * re-deriving "is this monitored" from its own `sessionId in
 * store.sessions` lookup. `status` is the only reading a user gets of
 * where the privacy boundary currently sits, so a second implementation
 * of the verdict is a bug generator: the lookup ignored both
 * SESSION_TTL_MS (a record older than 7 days reported `monitored: true`
 * while the hooks rejected and GC'd it) and `pending_arm` (on Codex,
 * the one platform that always takes the pending path, `on` followed
 * immediately by `status` reported `monitored: false, armed_sessions: 0`
 * — indistinguishable from `on` having silently failed).
 */

import { loadLogsConfig, loadMonitorAllSessions } from './config-loader.js';
import {
  loadMonitorStore,
  saveMonitorStore,
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
  removed: boolean;
}

export interface MonitorStatusResult {
  action: 'status';
  monitor_all_sessions: boolean;
  session_id: string | null;
  monitored: boolean;
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
  const cwd = options.cwd ?? process.cwd();
  const now = Date.now();

  if (command === 'on') {
    if (sessionId) {
      const next: MonitorStore = {
        sessions: { ...store.sessions, [sessionId]: { armed_at: now, cwd } },
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
    const removed = sessionId !== null && sessionId in sessions;
    if (sessionId) delete sessions[sessionId];
    // Saving without `pending_arm` is what clears it.
    saveMonitorStore(logsConfig, { sessions });
    return { action: 'off', removed };
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

  return {
    action: 'status',
    monitor_all_sessions: monitorAll,
    session_id: sessionId,
    monitored: monitorAll || gate.monitored,
    pending_arm: gate.store.pending_arm !== undefined,
    // Counted off the gate's post-sweep store, so a record past
    // SESSION_TTL_MS is not reported as armed when the hooks would
    // reject it.
    armed_sessions: Object.keys(gate.store.sessions).length,
  };
}
