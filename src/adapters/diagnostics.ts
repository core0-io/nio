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
 * The AUDIT leg never dedupes — it is the forensic record, and
 * `/nio report` / `/nio doctor` aggregate it on read. The STDERR leg is
 * rate-limited per distinct diagnostic; see `writeStderr` below for why
 * and exactly what "distinct" means.
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AuditDiagnosticEntry } from './audit-types.js';

export type Diagnostic = Omit<AuditDiagnosticEntry, 'event' | 'timestamp'>;

/**
 * Override the audit-log path used by reportDiagnostic. Tests inject a temp
 * file to keep ~/.nio/audit.jsonl clean.
 */
let auditPathOverride: string | null = null;

export function _setDiagnosticsAuditPathForTests(path: string | null): void {
  auditPathOverride = path;
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

function ensureParentDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
  }
}

// ── stderr rate limiting ────────────────────────────────────────────────
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
// `otlp_export_failed` lines in 6 minutes, ~2 per second, which buried
// the user's actual work until they turned monitoring off.
//
// WHAT IS *NOT* THE FIX: lowering the severity, or defaulting diagnostics
// off. A telemetry fault that nobody can see is worse than one that is
// noisy — the first occurrence must always reach the terminal.
//
// THE RULE
//
//   - The FIRST occurrence of a distinct diagnostic always prints, in
//     full, immediately. No warm-up, no sampling.
//   - Further occurrences of the SAME diagnostic inside
//     `STDERR_WINDOW_MS` do not print; they are counted.
//   - When that window closes, a single summary line reports how many
//     were suppressed, and the next occurrence prints in full again.
//   - The AUDIT leg is untouched: every occurrence is still one JSONL
//     line, so `/nio report` and post-hoc analysis lose nothing.
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

/** How long one distinct diagnostic occupies its stderr slot. */
export const STDERR_WINDOW_MS = 60_000;

/**
 * Ceiling on tracked distinct diagnostics. A pathological caller that
 * varies `detail` on every call (an embedded timestamp, say) would
 * otherwise grow this map without bound in a process that runs for weeks.
 */
const MAX_TRACKED_KEYS = 256;

interface StderrWindow {
  /** When this key last printed in full. */
  openedAt: number;
  /** Occurrences swallowed since then. */
  suppressed: number;
  /** Rendered header, kept so the summary can name what was suppressed. */
  head: string;
  /** Severity marker for the summary line. */
  sev: string;
}

const stderrWindows = new Map<string, StderrWindow>();

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
  stderrWindows.clear();
}

function severityMark(severity: Diagnostic['severity']): string {
  return severity === 'error' ? '!' : severity === 'warning' ? '~' : 'i';
}

function diagnosticKey(d: Diagnostic): string {
  return [d.severity, d.source, d.kind, d.component ?? '', d.message, d.detail ?? ''].join('\u0000');
}

function emitSummary(w: StderrWindow, elapsedMs: number): void {
  const secs = Math.max(1, Math.round(elapsedMs / 1000));
  process.stderr.write(
    `${w.sev} ${w.head}\n` +
    `  suppressed ${w.suppressed} more identical in the last ${secs}s ` +
    `(every one is in the audit log)\n`,
  );
}

/**
 * Emit the pending "suppressed N" summary for every window that has
 * closed. Called at the top of each report, and exported so an
 * entrypoint that is about to exit can surface a trailing count.
 */
export function flushSuppressedDiagnostics(force = false): void {
  const now = clock();
  for (const [key, w] of stderrWindows) {
    const elapsed = now - w.openedAt;
    if (!force && elapsed < windowMs) continue;
    if (w.suppressed > 0) emitSummary(w, elapsed);
    stderrWindows.delete(key);
  }
}

function writeStderr(d: Diagnostic): void {
  flushSuppressedDiagnostics();

  const key = diagnosticKey(d);
  const open = stderrWindows.get(key);
  if (open) {
    open.suppressed++;
    return;
  }

  const sev = severityMark(d.severity);
  const head = `[nio:${d.source}:${d.kind}]${d.component ? ' ' + d.component + ':' : ''} ${d.message}`;
  process.stderr.write(`${sev} ${head}\n`);
  // `detail` carries the only text that names the actual fault. Omitting
  // it is how a run of 'Concurrent export limit reached' (the exporter
  // refusing to send, endpoint untouched) read on screen as an
  // unreachable endpoint for six minutes.
  if (d.detail) process.stderr.write(`  detail: ${d.detail}\n`);
  if (d.hint) process.stderr.write(`  hint: ${d.hint}\n`);

  if (stderrWindows.size >= MAX_TRACKED_KEYS) {
    // Evict the oldest window rather than growing forever. Its count is
    // reported now instead of at its natural expiry.
    let oldestKey: string | undefined;
    let oldest: StderrWindow | undefined;
    for (const [k, w] of stderrWindows) {
      if (oldest === undefined || w.openedAt < oldest.openedAt) { oldest = w; oldestKey = k; }
    }
    if (oldestKey !== undefined && oldest !== undefined) {
      if (oldest.suppressed > 0) emitSummary(oldest, clock() - oldest.openedAt);
      stderrWindows.delete(oldestKey);
    }
  }
  stderrWindows.set(key, { openedAt: clock(), suppressed: 0, head, sev });
}

function writeAudit(d: Diagnostic): void {
  const entry: AuditDiagnosticEntry = {
    event: 'diagnostic',
    timestamp: new Date().toISOString(),
    ...d,
  };
  try {
    const path = resolveAuditPath();
    ensureParentDir(path);
    appendFileSync(path, JSON.stringify(entry) + '\n');
  } catch {
    // Best-effort — never let audit-log IO swallow a primary failure.
  }
}

/**
 * Fire-and-forget reporter. Use for diagnostics not tied to an evaluation
 * scope (config-load, collector OTLP failures, library callers).
 */
export function reportDiagnostic(d: Diagnostic): void {
  writeStderr(d);
  writeAudit(d);
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
