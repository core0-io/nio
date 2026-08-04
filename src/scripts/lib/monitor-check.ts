// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Monitor check — the one place that turns the pure gate decision into
 * a filesystem-backed answer.
 *
 * Claude Code (`collector-hook.ts`, `guard-hook.ts`) and Codex CLI (same
 * two files, `--platform codex`) call this before creating any OTEL
 * provider. Hermes (`hook-cli.ts`) and OpenClaw (`openclaw-plugin.ts`)
 * do not wire into this yet — that's tracked as follow-up work. Keeping
 * the check in a single module means the load → decide → persist
 * sequence cannot drift between the platforms that do call it, and the
 * remaining two will get the same guarantee for free once wired.
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
  // A session id we cannot trust is never monitored, and never claims a
  // pending arm. The `?? 'unknown'` fallback at the call sites is a
  // placeholder for audit records, not an identity — treating it as one
  // would make it a shared key that any id-less event from any directory
  // could match, turning a single arm into blanket capture. This check
  // must run before loadMonitorStore so such an event never gets a
  // chance to claim a pending arm either.
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId === 'unknown') {
    return false;
  }
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
