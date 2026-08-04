// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Monitor store — owns `monitored-sessions.json`, the persistent record
 * of which sessions the user explicitly opted into telemetry for.
 *
 * Deliberately separate from `traces-state-store.json`: that file holds
 * turn-scoped ephemeral state (cleared every turn), this one holds
 * session-scoped durable state. Different lifecycles, different files.
 *
 * Path: derived from `collector.logs.path` so it sits next to the audit
 * log, same convention as the traces state store. Default
 * `${NIO_HOME ?? ~/.nio}/monitored-sessions.json`.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { CollectorLogsConfig } from '../../adapters/config-schema.js';

/** A session the user explicitly armed via `/nio-monitor`. */
export interface MonitoredSession {
  armed_at: number;
  cwd: string;
}

/**
 * A pending arm request from a platform where the CLI could not resolve
 * the session id itself. The next hook event matching `cwd` within the
 * TTL claims it.
 */
export interface PendingArm {
  at: number;
  cwd: string;
}

export interface MonitorStore {
  sessions: Record<string, MonitoredSession>;
  pending_arm?: PendingArm;
}

const STORE_FILE_NAME = 'monitored-sessions.json';

function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

function defaultStoreDir(): string {
  return process.env['NIO_HOME'] || join(homedir(), '.nio');
}

/** Resolve the store location — next to the audit log. */
export function monitorStorePath(logsConfig?: CollectorLogsConfig): string {
  const auditPath = logsConfig?.path ? expandHome(logsConfig.path) : null;
  const dir = auditPath ? dirname(auditPath) : defaultStoreDir();
  return join(dir, STORE_FILE_NAME);
}

/**
 * Load the store. Returns an empty store when the file is missing or
 * corrupt — a broken store must never enable telemetry that the user
 * did not ask for, and must never crash the hook.
 */
export function loadMonitorStore(logsConfig?: CollectorLogsConfig): MonitorStore {
  try {
    const raw = readFileSync(monitorStorePath(logsConfig), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<MonitorStore>;
    const store: MonitorStore = { sessions: parsed.sessions ?? {} };
    if (parsed.pending_arm) store.pending_arm = parsed.pending_arm;
    return store;
  } catch {
    return { sessions: {} };
  }
}

/** Persist the store. Creates the parent directory if missing. */
export function saveMonitorStore(
  logsConfig: CollectorLogsConfig | undefined,
  store: MonitorStore,
): void {
  const path = monitorStorePath(logsConfig);
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(store, null, 2), 'utf-8');
}
