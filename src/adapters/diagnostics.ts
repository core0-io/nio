// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Diagnostics — unified channel for surfacing config & runtime failures.
 *
 *   reportDiagnostic()   — fire-and-forget: append to audit log JSONL +
 *                          structured stderr line. Use for failures not
 *                          bound to an orchestrator.evaluate() scope (e.g.
 *                          config-load errors, OTLP export failures).
 *
 *   DiagnosticCollector  — per-scope collector used inside
 *                          ActionOrchestrator.evaluate() so each evaluation
 *                          has an isolated diagnostics array (no module-
 *                          level race when concurrent evaluations run in
 *                          library mode). collect() ALSO writes to audit
 *                          log + stderr — take() returns the collected list
 *                          for embedding in ActionDecision.
 *
 * BOTH legs are rate-limited per distinct diagnostic, in lockstep: see the
 * flood-control block below for why, what "distinct" means, and how the
 * audit leg keeps the occurrence count exact while collapsing the lines.
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AuditDiagnosticEntry } from './audit-types.js';
import { rotateIfNeeded } from './audit-rotate.js';

export type Diagnostic = Omit<AuditDiagnosticEntry, 'event' | 'timestamp'>;

/**
 * Override the audit-log path used by reportDiagnostic. Tests inject a temp
 * file to keep ~/.nio/audit.jsonl clean.
 */
let auditPathOverride: string | null = null;

export function _setDiagnosticsAuditPathForTests(path: string | null): void {
  auditPathOverride = path;
  // Flood windows are keyed by the diagnostic, not by the file it lands
  // in, so they must not survive a change of destination: a window opened
  // against the old file would swallow the first report against the new
  // one, and would later write its summary — describing occurrences that
  // went elsewhere — into a file it never described. Repointing the log
  // starts a fresh accounting period.
  openWindows.clear();
}

function resolveAuditPath(): string {
  if (auditPathOverride) return auditPathOverride;
  // Avoid a circular import with common.ts — re-derive the default path
  // inline. This MUST agree with common.ts's `defaultAuditPath()`
  // (`join(NIO_HOME ?? join(homedir(), '.nio'), 'audit.jsonl')`), because a
  // diagnostic that lands in a different file than the audit entries around
  // it is a diagnostic nobody will ever find.
  //
  // `homedir()`, not `process.env.HOME`: they are the same in a normal
  // shell, but a host launched by a daemon / launchd / a container entry
  // point can have HOME unset, and the old fallback chain then resolved to
  // the RELATIVE path `.nio/audit.jsonl` — i.e. diagnostics scattered into
  // whichever directory each session happened to start in, while every
  // other audit entry went to the real `~/.nio/audit.jsonl`. `homedir()`
  // falls back to the passwd entry, so there is no cwd-relative case left.
  //
  // KNOWN GAP (deliberate, documented in the report): a user who points
  // `collector.logs.path` somewhere other than the default splits the two
  // legs again — `writeAuditLog` honours that setting and this does not.
  // Closing it needs a config read from here, which is exactly the import
  // cycle this function exists to avoid.
  const root = process.env.NIO_HOME || join(homedir(), '.nio');
  return join(root, 'audit.jsonl');
}

/**
 * Test seam: the path `reportDiagnostic` would append to, resolved
 * WITHOUT writing anything. Lets a test assert the resolution rule (no
 * cwd-relative fallback) without creating files in a real home directory.
 */
export function _resolveDiagnosticsAuditPathForTests(): string {
  return resolveAuditPath();
}

/**
 * Size ceiling for the audit file, in MB, as configured under
 * `collector.logs.max_size_mb`. `undefined` until something tells this
 * module otherwise, in which case rotation falls back to the shared
 * built-in default.
 */
let auditLimitMb: number | undefined;

/**
 * Publish the configured audit-log ceiling to this leg.
 *
 * `reportDiagnostic` cannot read the config itself — doing so would pull
 * the loader (and a cycle back through common.ts) into a module that the
 * guard and scanner paths both import. So the value is pushed in by
 * whoever has already loaded it; `writeAuditLog()` does this on every
 * call, which costs an assignment and keeps the two writers agreeing
 * about the file they share.
 *
 * Passing `undefined` restores the built-in default.
 */
export function setDiagnosticsAuditLimitMb(mb: number | undefined): void {
  auditLimitMb = mb;
}

function ensureParentDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
  }
}

// ── flood control (stderr + audit) ──────────────────────────────────────
//
// WHY THIS EXISTS
//
// stderr is the HOST's terminal. On the fork-per-event platforms
// (Claude Code, Codex, Hermes) an unthrottled writer is harmless: the
// process handles one event and exits, so it can only ever print a
// handful of lines. On the in-process platforms (Pi, opencode, OpenClaw)
// ONE process serves the whole session, and a collector fault repeats for
// as long as the fault lasts — a `PeriodicExportingMetricReader` alone
// re-exports every second, and every recorded event force-flushes on top
// of that. Measured on a live Pi session: 205 identical
// `otlp_export_failed` lines in 6 minutes, which buried the user's actual
// work until they turned monitoring off.
//
// The same flood reaches the audit log, and there it does worse than
// annoy. Measured on a live machine: `~/.nio/audit.jsonl` at 13.9 MB
// holding 34 689 `otlp_export_failed` entries — 97 % of the file —
// against ~1 500 real agent events, with the previous 100 MB generation
// already filled the same way and rotated over. Rotation keeps exactly
// ONE generation (`renameSync(path, path + '.1')` overwrites), so the
// flood evicts the guard decisions and lifecycle records that are the
// reason the log exists, permanently.
//
// This module used to state that "the AUDIT leg never dedupes — it is the
// forensic record". That was a defensible aim and the wrong trade: it
// preserved the diagnostic COUNT at the cost of the agent RECORD. The
// record wins. What follows keeps both.
//
// WHAT IS *NOT* THE FIX: lowering the severity, or defaulting diagnostics
// off. A telemetry fault that nobody can see is worse than one that is
// noisy — the first occurrence must always reach the terminal AND the log.
//
// THE RULE — both legs collapse in lockstep
//
//   - The FIRST occurrence of a distinct diagnostic always prints in full
//     and is written to the audit log in full. No warm-up, no sampling.
//   - Further occurrences of the SAME diagnostic inside
//     `STDERR_WINDOW_MS` are counted, and neither printed nor written.
//   - When that window closes, ONE stderr summary line and ONE audit
//     summary entry report how many were suppressed and over what span.
//     The audit entry carries `suppressed_count` + `window_started_at`,
//     so the exact original count stays recoverable from the log — the
//     34 689 above become 12 lines with none of the count lost.
//   - The next occurrence opens a new window and prints/writes in full.
//
// A summary entry stands for the repeats it collapsed and NOT for itself,
// so a reader tallying occurrences sums `suppressed_count ?? 1` per entry
// rather than counting lines. That is the one thing downstream
// aggregation had to learn; in exchange the log stops evicting itself.
//
// "Distinct" includes `detail`, which is the field that names the actual
// fault ('Concurrent export limit reached' vs 'Request timed out' are
// different failures with different fixes). A fault that CHANGES is new
// information and must not be hidden behind an older fault's window.
//
// No timers are used anywhere here: a `setInterval` in this module would
// be a ref'd handle in every hook subprocess and would keep short-lived
// processes alive. Expired windows are swept on the next report instead,
// which is exactly when a flood is still happening.

/**
 * How long one distinct diagnostic occupies its slot on both legs.
 * Named for the stderr leg it was introduced for; it now governs the
 * audit leg too.
 */
export const STDERR_WINDOW_MS = 60_000;

/**
 * Ceiling on tracked distinct diagnostics. A pathological caller that
 * varies `detail` on every call (an embedded timestamp, say) would
 * otherwise grow this map without bound in a process that runs for weeks.
 */
const MAX_TRACKED_KEYS = 256;

interface DiagnosticWindow {
  /** When this key last emitted in full, on both legs. */
  openedAt: number;
  /** Occurrences swallowed since then, on both legs. */
  suppressed: number;
  /** Rendered header, kept so the stderr summary can name what was suppressed. */
  head: string;
  /** Severity marker for the stderr summary line. */
  sev: string;
  /**
   * The diagnostic that opened the window, kept so the audit summary can
   * repeat its identifying fields (kind, component, detail, …) instead of
   * writing a shape no aggregator would recognise.
   */
  diag: Diagnostic;
}

const openWindows = new Map<string, DiagnosticWindow>();

/** Injectable clock so tests can move time without sleeping. */
let clock: () => number = () => Date.now();
let windowMs: number = STDERR_WINDOW_MS;

/**
 * Test seam: pin the clock and/or shrink the suppression window.
 * Passing `null` for either restores the production behaviour. Always
 * resets the tracking map, so tests never inherit another test's windows.
 */
export function _setDiagnosticsThrottleForTests(
  opts: { now?: (() => number) | null; windowMs?: number | null } = {},
): void {
  if (opts.now !== undefined) clock = opts.now ?? (() => Date.now());
  if (opts.windowMs !== undefined) windowMs = opts.windowMs ?? STDERR_WINDOW_MS;
  openWindows.clear();
}

function severityMark(severity: Diagnostic['severity']): string {
  return severity === 'error' ? '!' : severity === 'warning' ? '~' : 'i';
}

function diagnosticKey(d: Diagnostic): string {
  return [d.severity, d.source, d.kind, d.component ?? '', d.message, d.detail ?? ''].join('\u0000');
}

/**
 * Close one window on both legs: a summary line to stderr and a summary
 * entry to the audit log, each naming how many repeats they stand for.
 * Only ever called with `w.suppressed > 0` — a window that swallowed
 * nothing has nothing to report and is simply dropped.
 */
function emitSummary(w: DiagnosticWindow, elapsedMs: number): void {
  const secs = Math.max(1, Math.round(elapsedMs / 1000));
  process.stderr.write(
    `${w.sev} ${w.head}\n` +
    `  suppressed ${w.suppressed} more identical in the last ${secs}s ` +
    `(summarised in the audit log)\n`,
  );
  writeAudit(w.diag, {
    suppressed_count: w.suppressed,
    window_started_at: new Date(w.openedAt).toISOString(),
  });
}

/**
 * Emit the pending "suppressed N" summary for every window that has
 * closed. Called at the top of each report. Exported with a `force`
 * argument so a caller about to exit could surface a trailing count;
 * nothing does that yet, and the tests drive it directly.
 */
export function flushSuppressedDiagnostics(force = false): void {
  const now = clock();
  for (const [key, w] of openWindows) {
    const elapsed = now - w.openedAt;
    if (!force && elapsed < windowMs) continue;
    if (w.suppressed > 0) emitSummary(w, elapsed);
    openWindows.delete(key);
  }
}

function writeStderr(d: Diagnostic): { head: string; sev: string } {
  const sev = severityMark(d.severity);
  const head = `[nio:${d.source}:${d.kind}]${d.component ? ' ' + d.component + ':' : ''} ${d.message}`;
  process.stderr.write(`${sev} ${head}\n`);
  // `detail` carries the only text that names the actual fault. Omitting
  // it is how a run of 'Concurrent export limit reached' (the exporter
  // refusing to send, endpoint untouched) read on screen as an
  // unreachable endpoint for six minutes.
  if (d.detail) process.stderr.write(`  detail: ${d.detail}\n`);
  if (d.hint) process.stderr.write(`  hint: ${d.hint}\n`);
  return { head, sev };
}

/**
 * Start a window for `key`, evicting the oldest first if the map is at
 * its ceiling. An evicted window still reports its count — early, rather
 * than at its natural expiry — so eviction never loses occurrences.
 */
function openWindow(key: string, d: Diagnostic, head: string, sev: string): void {
  if (openWindows.size >= MAX_TRACKED_KEYS) {
    let oldestKey: string | undefined;
    let oldest: DiagnosticWindow | undefined;
    for (const [k, w] of openWindows) {
      if (oldest === undefined || w.openedAt < oldest.openedAt) { oldest = w; oldestKey = k; }
    }
    if (oldestKey !== undefined && oldest !== undefined) {
      if (oldest.suppressed > 0) emitSummary(oldest, clock() - oldest.openedAt);
      openWindows.delete(oldestKey);
    }
  }
  openWindows.set(key, { openedAt: clock(), suppressed: 0, head, sev, diag: d });
}

/**
 * Append one entry. `summary` is set only when closing a flood window,
 * in which case the entry stands for `suppressed_count` further
 * occurrences on top of itself.
 */
function writeAudit(
  d: Diagnostic,
  summary?: { suppressed_count: number; window_started_at: string },
): void {
  const entry: AuditDiagnosticEntry = {
    event: 'diagnostic',
    timestamp: new Date().toISOString(),
    ...d,
    ...summary,
  };
  try {
    const path = resolveAuditPath();
    ensureParentDir(path);
    // The event leg rotates before every append; this leg used not to,
    // so the configured ceiling only applied to real agent events and a
    // host emitting nothing but diagnostics grew the file unbounded.
    rotateIfNeeded(path, auditLimitMb);
    appendFileSync(path, JSON.stringify(entry) + '\n');
  } catch {
    // Best-effort — never let audit-log IO swallow a primary failure.
  }
}

/**
 * Fire-and-forget reporter. Use for diagnostics not tied to an evaluation
 * scope (config-load, collector OTLP failures, library callers).
 *
 * Both legs are driven from here so they collapse in lockstep: a repeat
 * inside an open window is counted once and reaches neither the terminal
 * nor the log, and the closing summary reports that one count to both.
 * Splitting the decision across the two writers is what let the audit leg
 * grow to 34 689 lines while stderr showed one.
 */
export function reportDiagnostic(d: Diagnostic): void {
  flushSuppressedDiagnostics();

  const key = diagnosticKey(d);
  const open = openWindows.get(key);
  if (open) {
    open.suppressed++;
    return;
  }

  const { head, sev } = writeStderr(d);
  writeAudit(d);
  openWindow(key, d, head, sev);
}

/**
 * Per-scope collector. Pass into orchestrator-internal calls so each
 * evaluate() has its own diagnostics list, then call take() at the end and
 * embed the result in ActionDecision.diagnostics.
 *
 * collect() ALSO writes immediately to stderr + audit log, so the canonical
 * channels stay populated even when nobody calls take().
 */
export class DiagnosticCollector {
  private entries: Diagnostic[] = [];

  /**
   * @param silent  When true, collect() only buffers in memory — it does NOT
   *                write to audit log or stderr. Use for sandboxed probes
   *                like `/nio doctor` that should not pollute the audit
   *                trail with their dry-run findings.
   */
  constructor(private readonly silent: boolean = false) {}

  collect(d: Diagnostic): void {
    this.entries.push(d);
    if (!this.silent) reportDiagnostic(d);
  }

  /** Return the collected diagnostics and reset the buffer. */
  take(): Diagnostic[] {
    const out = this.entries;
    this.entries = [];
    return out;
  }

  /** Peek without resetting (for tests). */
  peek(): readonly Diagnostic[] {
    return this.entries;
  }

  /**
   * Append entries that were already collect()ed in another scope, without
   * re-firing the audit/stderr write side-effects. Use when forwarding
   * diagnostics from a per-sub-call collector into a parent collector at the
   * end of an evaluation.
   */
  addCollected(diags: readonly Diagnostic[]): void {
    this.entries.push(...diags);
  }

  /** Sugar for `addCollected(other.take())`. */
  absorb(other: DiagnosticCollector): void {
    this.entries.push(...other.take());
  }
}

// ── Formatting helpers (for hook surfacing) ─────────────────────────────

/**
 * Render a Diagnostic[] into a compact multi-line block intended for
 * inclusion in user-visible hook output (Claude Code's additionalContext,
 * appended to a deny/ask reason, etc.). Returns an empty string when the
 * input is empty.
 */
export function formatDiagnosticsForUser(diagnostics: readonly Diagnostic[]): string {
  if (diagnostics.length === 0) return '';

  const errors = diagnostics.filter(d => d.severity === 'error').length;
  const warnings = diagnostics.filter(d => d.severity === 'warning').length;
  const counts: string[] = [];
  if (errors)   counts.push(`${errors} error${errors === 1 ? '' : 's'}`);
  if (warnings) counts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);

  const header = counts.length > 0
    ? `Nio: ${counts.join(', ')} during this action`
    : `Nio: ${diagnostics.length} notice${diagnostics.length === 1 ? '' : 's'} during this action`;

  const lines = [header];
  for (const d of diagnostics) {
    const comp = d.component ? ` ${d.component}:` : '';
    lines.push(`  - [${d.source} ${d.kind}]${comp} ${d.message}`);
    if (d.hint) lines.push(`    hint: ${d.hint}`);
  }
  lines.push('Run /nio doctor or /nio report for details.');
  return lines.join('\n');
}
