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
 * Writers do NOT dedupe; readers (`/nio report`, `/nio doctor`) aggregate.
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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
  // Avoid circular import with common.ts — re-derive the default path inline.
  // Mirrors common.ts: ${NIO_HOME ?? ~/.nio}/audit.jsonl.
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const root = process.env.NIO_HOME || (home ? `${home}/.nio` : '.nio');
  return `${root}/audit.jsonl`;
}

function ensureParentDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
  }
}

function writeStderr(d: Diagnostic): void {
  const sev = d.severity === 'error' ? '!' : d.severity === 'warning' ? '~' : 'i';
  const head = `[nio:${d.source}:${d.kind}]${d.component ? ' ' + d.component + ':' : ''} ${d.message}`;
  process.stderr.write(`${sev} ${head}\n`);
  if (d.hint) process.stderr.write(`  hint: ${d.hint}\n`);
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
