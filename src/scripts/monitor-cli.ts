#!/usr/bin/env node
// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Nio — Monitor CLI
 *
 * Backs the `/nio-monitor` skill. Arms or disarms telemetry capture for
 * the current agent session.
 *
 * Session resolution is two-tier. When the host exposes the session id
 * in the environment (Claude Code sets CLAUDE_CODE_SESSION_ID) we bind
 * directly and the arm takes effect on the next hook event. When it does
 * not, we leave a `pending_arm` stamped with this process's cwd, and the
 * next hook event from a matching directory claims it.
 *
 * Output is JSON on stdout so the calling skill can present it without
 * parsing prose.
 */

import { loadLogsConfig, loadMonitorAllSessions } from './lib/config-loader.js';
import {
  loadMonitorStore,
  saveMonitorStore,
  type MonitorStore,
} from './lib/monitor-store.js';

/**
 * Environment variables that carry the host's session id. Only Claude
 * Code is listed — it is the one platform whose variable has been
 * verified on a real session. Other platforms fall through to the
 * pending-arm path until their variables are confirmed.
 */
const SESSION_ENV_VARS = ['CLAUDE_CODE_SESSION_ID'] as const;

function resolveSessionId(): string | null {
  for (const name of SESSION_ENV_VARS) {
    const value = process.env[name];
    if (value && value.length > 0) return value;
  }
  return null;
}

function usage(): never {
  process.stderr.write(
    'Usage: monitor-cli.js <on|off|status>\n\n' +
    '  on      Start capturing telemetry for the current session\n' +
    '  off     Stop capturing, and clear any pending arm\n' +
    '  status  Report global and per-session capture state\n',
  );
  process.exit(1);
}

function main(): void {
  const command = process.argv[2];
  if (!command || !['on', 'off', 'status'].includes(command)) usage();

  const logsConfig = loadLogsConfig();
  const store = loadMonitorStore(logsConfig);
  const sessionId = resolveSessionId();
  const cwd = process.cwd();
  const now = Date.now();

  if (command === 'on') {
    if (sessionId) {
      const next: MonitorStore = {
        sessions: { ...store.sessions, [sessionId]: { armed_at: now, cwd } },
      };
      saveMonitorStore(logsConfig, next);
      process.stdout.write(JSON.stringify({
        action: 'on', mode: 'direct', session_id: sessionId,
      }) + '\n');
    } else {
      const next: MonitorStore = {
        sessions: store.sessions,
        pending_arm: { at: now, cwd },
      };
      saveMonitorStore(logsConfig, next);
      process.stdout.write(JSON.stringify({
        action: 'on', mode: 'pending', session_id: null,
      }) + '\n');
    }
    return;
  }

  if (command === 'off') {
    const sessions = { ...store.sessions };
    const removed = sessionId !== null && sessionId in sessions;
    if (sessionId) delete sessions[sessionId];
    saveMonitorStore(logsConfig, { sessions });
    process.stdout.write(JSON.stringify({ action: 'off', removed }) + '\n');
    return;
  }

  const monitorAll = loadMonitorAllSessions();
  const monitored = monitorAll || (sessionId !== null && sessionId in store.sessions);
  process.stdout.write(JSON.stringify({
    action: 'status',
    monitor_all_sessions: monitorAll,
    session_id: sessionId,
    monitored,
    armed_sessions: Object.keys(store.sessions).length,
  }) + '\n');
}

main();
