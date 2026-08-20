// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Audit-leg flood control for diagnostics.
 *
 * THE DEFECT, measured on a live machine
 *
 * `~/.nio/audit.jsonl` reached 13.9 MB holding 34 689 `otlp_export_failed`
 * entries — 97 % of the file — against ~1 500 real agent events. The
 * previous 100 MB generation had already been filled the same way and
 * rotated over. Across 23 hours those 34 689 lines carried exactly SIX
 * distinct (component, detail) pairs:
 *
 *     31641  metrics  'AggregateError'
 *      2618  metrics  'connect ECONNREFUSED ::1:4318…'
 *       290  logs     'AggregateError'
 *       130  traces   'AggregateError'
 *         8  metrics  'Request timed out'
 *         2  metrics  'read ECONNRESET'
 *
 * WHY THE OLD CONTRACT HAD TO GO
 *
 * `diagnostics.ts` used to state that "the AUDIT leg never dedupes — it is
 * the forensic record", and two tests in diagnostics-throttle.test.ts
 * pinned it (205 reports had to produce 205 lines). The intent was
 * forensic completeness. The measured effect was the opposite: rotation
 * keeps ONE generation (`renameSync(path, path + '.1')` overwrites), so a
 * diagnostic flood evicts the guard decisions and lifecycle records that
 * are the reason an audit log exists, permanently.
 *
 * Completeness of the diagnostic COUNT and completeness of the agent
 * RECORD were in direct conflict, and the record has to win.
 *
 * THE REPLACEMENT CONTRACT — information is conserved, not lines
 *
 *   1. the FIRST occurrence of a distinct diagnostic is written in full;
 *   2. repeats inside the window are collapsed and counted, not written;
 *   3. when the window closes, ONE summary entry records how many were
 *      suppressed and over what span, so the exact original count remains
 *      recoverable from the log;
 *   4. therefore: reports in == occurrences accounted for in the log.
 *      Property 4 is the invariant the flood fix must never break.
 */

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  reportDiagnostic,
  flushSuppressedDiagnostics,
  _setDiagnosticsAuditPathForTests,
  _setDiagnosticsThrottleForTests,
  type Diagnostic,
} from '../adapters/diagnostics.js';
import { trackTempDir } from './helpers/tmp-dirs.js';

let auditDir: string;
let auditPath: string;

/** Movable clock so the window can be crossed without sleeping. */
let nowMs = 1_000_000;

/** stderr is not under test here — swallow it so the run stays readable. */
let originalWrite: typeof process.stderr.write;

before(() => {
  auditDir = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-diag-flood-test-')));
  auditPath = join(auditDir, 'audit.jsonl');
  _setDiagnosticsAuditPathForTests(auditPath);
});

after(() => {
  _setDiagnosticsAuditPathForTests(null);
  _setDiagnosticsThrottleForTests({ now: null, windowMs: null });
  try { rmSync(auditDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  writeFileSync(auditPath, '');
  nowMs = 1_000_000;
  _setDiagnosticsThrottleForTests({ now: () => nowMs, windowMs: 60_000 });
  originalWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: unknown }).write = (): boolean => true;
});

afterEach(() => {
  (process.stderr as unknown as { write: unknown }).write = originalWrite;
});

interface AuditLine {
  event: string;
  kind: string;
  component?: string;
  detail?: string;
  message: string;
  suppressed_count?: number;
  window_started_at?: string;
}

function auditLines(): AuditLine[] {
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as AuditLine);
}

/**
 * Every occurrence the log accounts for. A first occurrence stands for
 * itself (one); a summary entry stands for the repeats it collapsed and
 * NOT for itself — it is metadata about a run, not another instance of
 * the fault. Hence `suppressed_count ?? 1`, which is the rule any reader
 * tallying this log has to apply.
 */
function occurrencesAccountedFor(): number {
  return auditLines().reduce((n, l) => n + (l.suppressed_count ?? 1), 0);
}

const exportFailure: Diagnostic = {
  severity: 'warning',
  source: 'collector',
  kind: 'otlp_export_failed',
  component: 'metrics',
  message: 'Failed to export metrics to the OTLP endpoint',
  detail: 'AggregateError',
  hint: 'Check collector.endpoint reachability, auth, and protocol.',
};

describe('diagnostics audit-leg flood control', () => {
  it('writes the FIRST occurrence in full', () => {
    reportDiagnostic(exportFailure);

    const lines = auditLines();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].kind, 'otlp_export_failed');
    assert.equal(lines[0].detail, 'AggregateError');
    assert.equal(lines[0].suppressed_count, undefined, 'a first occurrence stands for itself');
  });

  it('collapses a flood of identical diagnostics to a single audit line', () => {
    for (let i = 0; i < 205; i++) reportDiagnostic(exportFailure);

    assert.equal(auditLines().length, 1, '205 identical reports must not be 205 lines');
  });

  it('records the suppressed count once the window closes', () => {
    for (let i = 0; i < 205; i++) reportDiagnostic(exportFailure);

    nowMs += 60_001;
    flushSuppressedDiagnostics();

    const summary = auditLines().find(l => l.suppressed_count !== undefined);
    assert.ok(summary, 'a summary entry must be written when the window closes');
    assert.equal(summary.suppressed_count, 204, 'the 204 collapsed repeats are still counted');
    assert.equal(summary.kind, 'otlp_export_failed', 'the summary names the diagnostic it stands for');
    assert.equal(summary.component, 'metrics');
  });

  it('conserves the occurrence count across a flood', () => {
    for (let i = 0; i < 205; i++) reportDiagnostic(exportFailure);
    nowMs += 60_001;
    flushSuppressedDiagnostics();

    assert.equal(occurrencesAccountedFor(), 205, 'every report is still accounted for');
  });

  it('conserves the count across several windows', () => {
    for (let i = 0; i < 30; i++) reportDiagnostic(exportFailure);
    nowMs += 60_001;
    for (let i = 0; i < 30; i++) reportDiagnostic(exportFailure);
    nowMs += 60_001;
    flushSuppressedDiagnostics();

    assert.equal(occurrencesAccountedFor(), 60);
  });

  it('dates the summary so the flood can be located in time', () => {
    reportDiagnostic(exportFailure);
    const firstAt = auditLines()[0].window_started_at ?? (auditLines()[0] as unknown as { timestamp: string }).timestamp;
    for (let i = 0; i < 40; i++) reportDiagnostic(exportFailure);

    nowMs += 60_001;
    flushSuppressedDiagnostics();

    const summary = auditLines().find(l => l.suppressed_count !== undefined);
    assert.ok(summary?.window_started_at, 'the summary says when the run began');
    assert.ok(summary.window_started_at <= (summary as unknown as { timestamp: string }).timestamp,
      'the window opened no later than it closed');
    assert.ok(firstAt, 'sanity: the first entry is dated too');
  });

  it('never collapses a DIFFERENT failure into an open window', () => {
    for (let i = 0; i < 50; i++) reportDiagnostic(exportFailure);
    // A different cause needs a different fix — it must reach the log
    // straight away, not wait behind an older fault's window.
    reportDiagnostic({ ...exportFailure, detail: 'Request timed out' });

    const details = auditLines().map(l => l.detail);
    assert.ok(details.includes('Request timed out'), 'the new fault is written immediately');
  });

  it('keeps unrelated diagnostics out of one another\'s windows', () => {
    for (let i = 0; i < 20; i++) reportDiagnostic(exportFailure);
    reportDiagnostic({
      severity: 'error', source: 'config', kind: 'schema_invalid',
      message: 'guard.protection_level is not one of strict|balanced|permissive',
    });

    assert.ok(auditLines().some(l => l.kind === 'schema_invalid'));
  });

  it('does not carry a window across a change of audit file', () => {
    // Windows are keyed by the diagnostic, not by the file it lands in.
    // Repointing the audit log must therefore reset them: otherwise the
    // first report against the NEW file is silently swallowed by a window
    // opened against the old one, and that window's summary is eventually
    // written into a file it never described.
    reportDiagnostic(exportFailure);
    assert.equal(auditLines().length, 1);

    const second = join(auditDir, 'audit-2.jsonl');
    writeFileSync(second, '');
    _setDiagnosticsAuditPathForTests(second);
    try {
      reportDiagnostic(exportFailure);
      const lines = readFileSync(second, 'utf-8').split('\n').filter(Boolean);
      assert.equal(lines.length, 1, 'the new file gets its own first occurrence');
    } finally {
      _setDiagnosticsAuditPathForTests(auditPath);
    }
  });

  it('reproduces the measured flood: 34 689 reports, six distinct faults', () => {
    const faults: Array<[string, string, number]> = [
      ['metrics', 'AggregateError', 31641],
      ['metrics', 'connect ECONNREFUSED ::1:4318', 2618],
      ['logs', 'AggregateError', 290],
      ['traces', 'AggregateError', 130],
      ['metrics', 'Request timed out', 8],
      ['metrics', 'read ECONNRESET', 2],
    ];
    let reported = 0;
    for (const [component, detail, count] of faults) {
      for (let i = 0; i < count; i++) {
        reportDiagnostic({ ...exportFailure, component, detail });
        reported++;
      }
    }
    nowMs += 60_001;
    flushSuppressedDiagnostics();

    assert.equal(reported, 34_689, 'sanity: the flood was reproduced');
    // Six faults × (first line + summary line) — the 13.9 MB file becomes
    // twelve lines, and none of the count is lost.
    assert.equal(auditLines().length, 12, '34 689 lines collapse to 12');
    assert.equal(occurrencesAccountedFor(), 34_689, 'every one is still counted');
  });
});
