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
 * long-running daemon whose providers are created once at plugin
 * registration and shared across every session for the process's
 * lifetime, so it calls this inside each event handler instead, keyed
 * by that event's session id, and skips only the OTEL-writing part of
 * the handler when unmonitored. All four platforms are wired in.
 * Keeping the check in a single module means the load → decide →
 * persist sequence cannot drift between platforms regardless of which
 * of the two call patterns they use.
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
