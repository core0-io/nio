// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Monitor check — the one place that turns the pure gate decision into
 * a filesystem-backed answer.
 *
 * All four platform entry points call this before creating any OTEL
 * provider. Keeping it in a single module means the load → decide →
 * persist sequence cannot drift between platforms.
 *
 * Fails closed: any error answers "not monitored". Telemetry must never
 * escape because a state file was unreadable, and a hook must never die
 * because of the gate.
 */

import { realpathSync } from 'node:fs';
import type { CollectorLogsConfig } from '../../adapters/config-schema.js';
import { loadMonitorStore, saveMonitorStore } from './monitor-store.js';
import { resolveMonitorGate } from './monitor-gate.js';
import { loadMonitorAllSessions } from './config-loader.js';

/**
 * Resolve a path to its canonical form so cwd comparisons survive
 * symlinks.
 *
 * `monitor-cli` stamps `pending_arm.cwd` from `process.cwd()`, which
 * POSIX always reports resolved (`/private/var/...` on macOS, where
 * `/var` is a symlink). Hook payloads carry whatever form the host
 * chose, which may be the unresolved one (`/var/...`). Comparing the
 * two raw would make the arm unclaimable on any machine where the
 * working directory sits under a symlink — on macOS that includes
 * anything under `/tmp`.
 *
 * Falls back to the input when the path cannot be resolved (it may not
 * exist yet); a best-effort canonical form still beats no comparison.
 */
function canonicalisePath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Decide whether this session's telemetry may be exported, persisting
 * any store change (pending-arm claim, expiry GC) as a side effect.
 */
export function isSessionMonitored(
  sessionId: string,
  cwd: string | null,
  logsConfig?: CollectorLogsConfig,
): boolean {
  try {
    const store = loadMonitorStore(logsConfig);
    const result = resolveMonitorGate({
      store,
      sessionId,
      cwd: cwd === null ? null : canonicalisePath(cwd),
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
