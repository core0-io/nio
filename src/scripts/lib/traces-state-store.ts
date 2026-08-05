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

/**
 * A span that has finished but is being held back until the turn ends.
 *
 * Tool spans can only be nested under the chat call that issued them,
 * and that attribution is not knowable at PostToolUse time — it comes
 * from the transcript once the turn is complete. So finished tool spans
 * park here, and the whole tree is emitted together at endTurn.
 *
 * Only metadata lives here. Content (prompts, thinking, results) goes
 * out through the logs signal as it happens, keyed by the span id that
 * was pre-allocated at PreToolUse — otherwise this file would grow with
 * every tool call and the per-event read/write would degrade.
 */
export interface DeferredSpan {
  kind: 'tool' | 'task';
  name: string;
  span_id: string;
  start_ms: number;
  end_ms: number;
  attributes: Record<string, unknown>;
  /** Sets the span status to ERROR and records an exception. */
  error?: string;
  /** Used to attribute this span to the chat call that issued it. */
  tool_use_id?: string;
}

export interface CollectorState {
  session_id: string;
  turn_number: number;
  turn_trace_id: string;    // 16-byte random hex, minted once per turn in ensureTurn()
  turn_start_ms: number;
  pending_spans: Record<string, PendingToolSpan>;        // keyed by tool_use_id or fallback
  pending_task_spans: Record<string, PendingTaskSpan>;   // keyed by task_id
  /**
   * Guard-decision attrs handed off from PreToolUse (guard-hook process)
   * to PostToolUse (collector-hook process). Drained + cleared when the
   * matching tool span is closed. Keyed by the same spanKey as
   * `pending_spans`.
   */
  pending_guard_attrs?: Record<string, Record<string, unknown>>;
  turn_attributes?: Record<string, unknown>;
  /** Finished spans awaiting the end-of-turn flush. */
  deferred_spans?: DeferredSpan[];
  /** Session-level trace. Minted at SessionStart so turns can link to it. */
  session_trace_id?: string;
  session_span_id?: string;
  session_start_ms?: number;
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
