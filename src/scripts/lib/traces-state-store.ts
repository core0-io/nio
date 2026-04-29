// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Traces state store — owns the on-disk persistence
 * (`traces-state-store.json`) for cross-process trace state.
 *
 * Why this exists: PreToolUse and PostToolUse run in separate Node
 * processes (Claude Code spawns a fresh process per hook; Hermes does the
 * same for its lifecycle hooks). Pairing pre/post into a single span and
 * carrying turn-level metadata across hooks therefore requires an
 * on-disk handoff. This module is the only place in the codebase that
 * reads/writes that handoff — `traces-collector.ts` stays pure (no fs IO),
 * and `collector-core.ts` orchestrates load → mutate → save around each
 * hook event.
 *
 * Path: derived from `collector.logs.path` so the trace state file always
 * sits next to the audit log. Default
 * `${NIO_HOME ?? ~/.nio}/traces-state-store.json`. Users who customise
 * `collector.logs.path` get the state file in the same directory
 * automatically.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { CollectorLogsConfig } from '../../adapters/config-schema.js';

// ── State types (moved here from traces-collector.ts) ─────────────────

export interface PendingToolSpan {
  tool_name: string;
  tool_summary: string;
  start_ms: number;
  span_id: string;  // 8-byte random hex, stable across pre/post
  attributes?: Record<string, unknown>;
}

export interface PendingTaskSpan {
  task_summary: string;
  start_ms: number;
  span_id: string;
}

export interface CollectorState {
  session_id: string;
  turn_number: number;
  turn_trace_id: string;    // MD5(session_id + ":" + turn_number)
  turn_start_ms: number;
  pending_spans: Record<string, PendingToolSpan>;        // keyed by tool_use_id or fallback
  pending_task_spans: Record<string, PendingTaskSpan>;   // keyed by task_id
  turn_attributes?: Record<string, unknown>;
}

// ── Path resolution ────────────────────────────────────────────────────

const STATE_FILE_NAME = 'traces-state-store.json';

function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

function defaultStateDir(): string {
  return process.env['NIO_HOME'] || join(homedir(), '.nio');
}

/**
 * Resolve the state file location. Sits next to the audit log so a
 * single `collector.logs.path` setting controls both.
 */
export function statePath(logsConfig?: CollectorLogsConfig): string {
  const auditPath = logsConfig?.path ? expandHome(logsConfig.path) : null;
  const dir = auditPath ? dirname(auditPath) : defaultStateDir();
  return join(dir, STATE_FILE_NAME);
}

// ── Read / write ───────────────────────────────────────────────────────

/** Load state from disk. Returns null when the file is missing or corrupt. */
export function loadState(logsConfig?: CollectorLogsConfig): CollectorState | null {
  try {
    const raw = readFileSync(statePath(logsConfig), 'utf-8');
    return JSON.parse(raw) as CollectorState;
  } catch {
    return null;
  }
}

/** Persist state. Creates the parent directory if missing. */
export function saveState(logsConfig: CollectorLogsConfig | undefined, state: CollectorState): void {
  const path = statePath(logsConfig);
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8');
}
