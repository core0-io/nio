// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Traces state store — owns the on-disk persistence
 * (`traces-state-store-<session>.json`) for cross-process trace state.
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
 * `${NIO_HOME ?? ~/.nio}/traces-state-store-<session>.json`. Users who
 * customise `collector.logs.path` get the state files in the same
 * directory automatically.
 *
 * ── One file PER SESSION, not one file ─────────────────────────────────
 *
 * The store used to be a single fixed filename shared by all four
 * platforms. Two host windows open at once are two independent sessions
 * writing that one file, and the damage was not lost data but
 * MIS-ATTRIBUTED data: `dispatchCollectorEvent`'s Stop branch loads the
 * state and hands it straight to `endTurn` with no session check, so
 * session A's Stop — arriving after session B's last write — exported
 * A's conversation content under B's `turn_trace_id` and with B's
 * `gen_ai.conversation.id` on the root. Measured on the pre-shard
 * implementation with two interleaved sessions: exactly ONE turn root
 * came out, carrying B's id and B's prompt, for two sessions' worth of
 * events. `ensureTurn`'s session-change branch then reset
 * `pending_spans`, so the interleaved session's in-flight tool spans
 * were discarded outright rather than merely delayed.
 *
 * So the session id is part of the filename. It is host-controlled
 * input, so it is never used raw — see `shardKey`.
 *
 * OpenClaw is unaffected either way: its daemon keeps `CollectorState`
 * in an in-memory `Map` keyed by session and never touches this module.
 */

import {
  readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync,
  readdirSync, statSync,
} from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
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
  /**
   * The platform that owns this shard ('claude-code' / 'codex' /
   * 'hermes'), and the `agent_name` configured for it.
   *
   * Recorded because a shard OUTLIVES the process that wrote it and can
   * be picked up by a different platform entirely. All four platforms
   * share `$NIO_HOME` by default and Claude Code / Codex are the same
   * scripts behind a different `--platform` flag, so "a Codex shard swept
   * by a Claude Code SessionStart" is a routine configuration.
   *
   * Since 9da6c81, `nio.platform` / `service.name` / `gen_ai.agent.name`
   * live ONLY on the OTEL Resource, and a Resource belongs to a provider
   * — so the recovering process cannot label the recovered spans
   * correctly without knowing whose they were. Without these two fields a
   * dead Codex session's tree went out as `service.name=nio-claude-code`
   * while its spans still carried the Codex `session.id`.
   *
   * Optional because a shard written by an older version has neither;
   * readers fall back to their own identity, which is the pre-existing
   * behaviour.
   */
  platform?: string;
  agent_name?: string;
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

const STATE_FILE_PREFIX = 'traces-state-store-';

/**
 * The single fixed filename every session shared before sharding. Read
 * once, adopted once, then removed — see `adoptLegacyState`.
 */
const LEGACY_STATE_FILE_NAME = 'traces-state-store.json';

/**
 * How long a shard must go untouched before it counts as ABANDONED — its
 * session's host died without ever reaching `SessionEnd`.
 *
 * Sharding trades one reused file for one file per session, so something
 * has to collect them. `discardState` covers the sessions that end
 * cleanly; `takeAbandonedShards` covers the rest, and is also what keeps
 * the documented crash guarantee alive (COLLECTOR-SIGNALS.md: "the parked
 * tree is flushed by the next event that finds it — or by the next
 * SessionStart"). Pre-sharding that worked by accident, because a new
 * session simply loaded the dead one's state out of the shared file.
 *
 * An hour, not seven days: the tree is only worth recovering while the
 * backend still cares, and every event a live session fires touches its
 * own shard, so an hour of total silence is a strong abandonment signal.
 * The cost of being wrong is bounded and honest — a session idle for over
 * an hour mid-turn gets its tree flushed early under its OWN trace id,
 * tagged `nio.turn.incomplete`, exactly as a real crash would. It is
 * never re-attributed to the recovering session.
 */
const SHARD_STALE_MS = 60 * 60 * 1000;

function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

function defaultStateDir(): string {
  return process.env['NIO_HOME'] || join(homedir(), '.nio');
}

function stateDir(logsConfig?: CollectorLogsConfig): string {
  const auditPath = logsConfig?.path ? expandHome(logsConfig.path) : null;
  return auditPath ? dirname(auditPath) : defaultStateDir();
}

/**
 * Turn an untrusted session id into a filename segment.
 *
 * Session ids come from the host (`session_id` on the hook payload, or a
 * ctx field on OpenClaw) and are never validated upstream, so this has to
 * assume hostile input. Two independent defences, both required:
 *
 *  - **Allowlist slug.** Everything outside `[A-Za-z0-9_-]` becomes `_`,
 *    which is what actually stops path traversal: `/`, `\`, NUL and the
 *    dots in `../..` all collapse to `_`, so no id can name a directory,
 *    escape the state dir, or produce a name the filesystem rejects.
 *    Truncated to 64 chars so `basename` stays under NAME_MAX (255) no
 *    matter how long the host's id is.
 *  - **Digest suffix.** The slug is lossy — `a/b` and `a:b` both become
 *    `a_b` — and two sessions colliding onto one file is precisely the
 *    bug being fixed. 12 hex chars of SHA-256 over the RAW id restores
 *    injectivity in practice. It is a collision guard, not a secret; no
 *    security property rests on it.
 *
 * Note the empty id maps to `-<digest>`, a valid and distinct name. It
 * is unreachable in practice — `UNTRUSTED_SESSION_IDS` makes `''` /
 * `'unknown'` / `'openclaw'` permanently unmonitored, so no provider is
 * ever built for them and nothing reaches this module — but sanitisation
 * must not depend on that gate holding.
 */
function shardKey(sessionId: string): string {
  const raw = typeof sessionId === 'string' ? sessionId : String(sessionId);
  const slug = raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  const digest = createHash('sha256').update(raw, 'utf-8').digest('hex').slice(0, 12);
  return `${slug}-${digest}`;
}

/**
 * Resolve a session's state file. Sits next to the audit log so a single
 * `collector.logs.path` setting controls both.
 */
export function statePath(logsConfig: CollectorLogsConfig | undefined, sessionId: string): string {
  return join(stateDir(logsConfig), `${STATE_FILE_PREFIX}${shardKey(sessionId)}.json`);
}

// ── Read / write ───────────────────────────────────────────────────────

/**
 * Adopt the pre-shard `traces-state-store.json`, once, for the session
 * that owns it.
 *
 * Chosen over "ignore it" and over "delete it on sight" because the file
 * can hold a LIVE turn at upgrade time: a `PreToolUse` that landed on the
 * old code and a `PostToolUse` that lands on the new one are the same
 * tool call, and dropping the handoff loses that span plus every
 * `deferred_spans` entry parked behind it. Adoption is conditional on
 * `state.session_id` matching, because adopting another session's state
 * would re-create the exact cross-session mixing sharding exists to
 * remove — and unconditional deletion would throw away a live turn
 * belonging to a session that simply had not fired an event yet.
 *
 * Deleting on successful adoption is what keeps this one-shot: the next
 * `saveState` writes the shard, and no second session can ever pick the
 * same state up later. A legacy file whose owning session never returns
 * is left where it is; it is a few KB, and there is no signal that would
 * make deleting it safe rather than merely tidy.
 */
function adoptLegacyState(
  logsConfig: CollectorLogsConfig | undefined,
  sessionId: string,
): CollectorState | null {
  const legacy = join(stateDir(logsConfig), LEGACY_STATE_FILE_NAME);
  try {
    const state = JSON.parse(readFileSync(legacy, 'utf-8')) as CollectorState;
    if (state?.session_id !== sessionId) return null;
    try { unlinkSync(legacy); } catch { /* best effort */ }
    return state;
  } catch {
    // Missing or corrupt: nothing to migrate.
    return null;
  }
}

/** Load a session's state from disk. Returns null when missing or corrupt. */
export function loadState(
  logsConfig: CollectorLogsConfig | undefined,
  sessionId: string,
): CollectorState | null {
  try {
    const raw = readFileSync(statePath(logsConfig, sessionId), 'utf-8');
    return JSON.parse(raw) as CollectorState;
  } catch {
    // No shard yet (or an unreadable one) — this is also the upgrade
    // path, so give the pre-shard file its one chance to be adopted.
    return adoptLegacyState(logsConfig, sessionId);
  }
}

/**
 * Drop a session's shard. Called at `SessionEnd`, alongside
 * `forgetSession`'s equivalent cleanup of the monitor store, so a
 * session that ends cleanly does not leave a file behind.
 *
 * Best-effort: cleanup must never break session teardown.
 */
export function discardState(
  logsConfig: CollectorLogsConfig | undefined,
  sessionId: string,
): void {
  try { unlinkSync(statePath(logsConfig, sessionId)); } catch { /* already gone */ }
}

/** A shard whose session is gone, handed to the caller to flush. */
export interface AbandonedShard {
  sessionId: string;
  state: CollectorState;
}

/**
 * Claim every shard except `currentSessionId`'s that has gone untouched
 * for {@link SHARD_STALE_MS}, remove it, and return the ones still
 * carrying a deferred-span tree so the caller can flush them.
 *
 * This is the sharded replacement for what the single shared file did by
 * accident: a new session used to load a dead session's state and
 * recover its parked tree. It is deliberately called from `SessionStart`
 * ONLY, not from every event —
 *
 *  - it is a `readdir` plus a `stat`/`read` per shard, and `PreToolUse` /
 *    `PostToolUse` are hot paths that fire continuously, whereas
 *    `SessionStart` fires once;
 *  - it matches the guarantee COLLECTOR-SIGNALS.md already documents
 *    ("or by the next SessionStart");
 *  - and every event's own shard is still recovered lazily by
 *    `hasOrphanedDeferredTree`, which needs no directory scan.
 *
 * "Take" is literal: the file is removed as it is read. Leaving it would
 * make every later SessionStart re-emit the same tree, and the tree is
 * telemetry — one honest attempt beats an unbounded retry loop against a
 * backend that may not be there. Shards that are stale but carry nothing
 * to recover are removed too; that is the GC leg.
 *
 * Never throws: a state directory this cannot read is not a reason to
 * fail a session start.
 */
export function takeAbandonedShards(
  logsConfig: CollectorLogsConfig | undefined,
  currentSessionId: string,
  nowMs: number = Date.now(),
): AbandonedShard[] {
  const dir = stateDir(logsConfig);
  const mine = statePath(logsConfig, currentSessionId);
  const cutoff = nowMs - SHARD_STALE_MS;
  const claimed: AbandonedShard[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return claimed;
  }
  for (const name of names) {
    if (!name.startsWith(STATE_FILE_PREFIX) || !name.endsWith('.json')) continue;
    const full = join(dir, name);
    if (full === mine) continue;
    try {
      if (statSync(full).mtimeMs >= cutoff) continue;   // still live
      let state: CollectorState | null = null;
      try {
        state = JSON.parse(readFileSync(full, 'utf-8')) as CollectorState;
      } catch {
        // Corrupt shard: nothing to recover, but it is still garbage.
      }
      unlinkSync(full);
      if (state && (state.deferred_spans?.length ?? 0) > 0) {
        claimed.push({ sessionId: state.session_id, state });
      }
    } catch {
      // Raced with the owning process, or unreadable — skip it. The next
      // SessionStart tries again.
    }
  }
  return claimed;
}

/** Persist a session's state atomically. Creates the parent dir if missing. */
export function saveState(
  logsConfig: CollectorLogsConfig | undefined,
  state: CollectorState,
  sessionId: string,
): void {
  const path = statePath(logsConfig, sessionId);
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // Write-then-rename: a single PreToolUse fires both guard-hook and
  // collector-hook as separate processes, and both write this file —
  // exactly the concurrent-writer shape that made monitor-store.ts's
  // truncating write unsafe there (see saveMonitorStore). A truncating
  // write here lets a reader observe half a JSON document mid-write;
  // JSON.parse throws, loadState's catch returns null, and the caller
  // (ensureTurn) treats that as "no turn in progress" and starts a new
  // one — silently discarding this turn's already-finished deferred
  // tool spans, not just the pending one. Rename is atomic within a
  // filesystem, so a reader always sees either the old state or the new
  // one, never a torn write.
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
    renameSync(tmp, path);
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}
