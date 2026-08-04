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
 */

import { loadLogsConfig, loadMonitorAllSessions } from './config-loader.js';
import {
  loadMonitorStore,
  saveMonitorStore,
  type MonitorStore,
} from './monitor-store.js';

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

function statusResult(
  store: MonitorStore,
  sessionId: string | null,
  _now: number,
): MonitorStatusResult {
  const monitorAll = loadMonitorAllSessions();
  return {
    action: 'status',
    monitor_all_sessions: monitorAll,
    session_id: sessionId,
    monitored: monitorAll || (sessionId !== null && sessionId in store.sessions),
    armed_sessions: Object.keys(store.sessions).length,
  };
}
