// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * stderr rate limiting for diagnostics.
 *
 * The defect this pins: on an in-process host (Pi / opencode / OpenClaw)
 * ONE process serves the whole session, so a collector fault repeats for
 * as long as it lasts. A live Pi session produced 205 identical
 * `otlp_export_failed` lines in six minutes and buried the user's work.
 *
 * The three properties that must hold together — losing any one of them
 * turns the fix into a different bug:
 *
 *   1. the FIRST occurrence still reaches stderr immediately and in full
 *      (a silent telemetry fault is worse than a loud one);
 *   2. repeats inside the window are collapsed and COUNTED, and the count
 *      is reported — not silently dropped;
 *   3. the audit log still gets every single occurrence.
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

/** Captured stderr for the duration of one test. */
let captured: string[] = [];
let originalWrite: typeof process.stderr.write;

/** Movable clock so the window can be crossed without sleeping. */
let nowMs = 1_000_000;

before(() => {
  auditDir = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-diag-throttle-test-')));
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
  captured = [];
  originalWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: unknown }).write = (chunk: unknown): boolean => {
    captured.push(String(chunk));
    return true;
  };
});

afterEach(() => {
  (process.stderr as unknown as { write: unknown }).write = originalWrite;
});

function stderrText(): string { return captured.join(''); }

function stderrLines(): string[] {
  return stderrText().split('\n').filter(Boolean);
}

function auditCount(): number {
  if (!existsSync(auditPath)) return 0;
  return readFileSync(auditPath, 'utf-8').split('\n').filter(Boolean).length;
}

const exportFailure: Diagnostic = {
  severity: 'warning',
  source: 'collector',
  kind: 'otlp_export_failed',
  component: 'metrics',
  message: 'Failed to export metrics to the OTLP endpoint',
  detail: 'Concurrent export limit reached',
  hint: 'The OTLP exporter refused to send.',
};

describe('diagnostics stderr rate limiting', () => {
  it('prints the FIRST occurrence immediately and in full', () => {
    reportDiagnostic(exportFailure);

    const text = stderrText();
    assert.match(text, /\[nio:collector:otlp_export_failed\] metrics: Failed to export metrics/);
    assert.match(text, /detail: Concurrent export limit reached/);
    assert.match(text, /hint: The OTLP exporter refused to send\./);
  });

  it('collapses a flood of the same diagnostic to one stderr line', () => {
    for (let i = 0; i < 205; i++) reportDiagnostic(exportFailure);

    const headers = stderrLines().filter(l => l.includes('[nio:collector:otlp_export_failed]'));
    assert.equal(headers.length, 1, `205 identical reports produced ${headers.length} stderr headers`);
  });

  it('keeps every occurrence in the audit log while stderr is collapsed', () => {
    for (let i = 0; i < 205; i++) reportDiagnostic(exportFailure);

    assert.equal(auditCount(), 205, 'the forensic record is complete');
  });

  it('reports how many were suppressed once the window closes', () => {
    for (let i = 0; i < 100; i++) reportDiagnostic(exportFailure);
    assert.equal(stderrText().includes('suppressed'), false, 'nothing summarised yet');

    nowMs += 60_001;
    reportDiagnostic(exportFailure);

    assert.match(stderrText(), /suppressed 99 more identical in the last 60s/);
    // …and the new window prints in full again, so the fault stays visible.
    const headers = stderrLines().filter(l => l.includes('[nio:collector:otlp_export_failed]'));
    assert.equal(headers.length, 3, 'first line, summary header, new-window line');
  });

  it('flushSuppressedDiagnostics(true) surfaces a trailing count early', () => {
    for (let i = 0; i < 7; i++) reportDiagnostic(exportFailure);
    assert.equal(stderrText().includes('suppressed'), false);

    flushSuppressedDiagnostics(true);

    assert.match(stderrText(), /suppressed 6 more identical/);
  });

  it('a DIFFERENT failure is never hidden behind an open window', () => {
    for (let i = 0; i < 50; i++) reportDiagnostic(exportFailure);
    // Same signal, same kind — but a different cause, which needs a
    // different fix and so must reach the user straight away.
    reportDiagnostic({ ...exportFailure, detail: 'Request timed out' });

    assert.match(stderrText(), /detail: Request timed out/);
  });

  it('a different severity/source/component is tracked separately', () => {
    reportDiagnostic(exportFailure);
    reportDiagnostic({ ...exportFailure, component: 'traces' });
    reportDiagnostic({ ...exportFailure, severity: 'error' });

    const headers = stderrLines().filter(l => l.includes('otlp_export_failed'));
    assert.equal(headers.length, 3);
  });

  it('a suppressed run does not stop the audit leg from being complete', () => {
    for (let i = 0; i < 30; i++) reportDiagnostic(exportFailure);
    nowMs += 60_001;
    for (let i = 0; i < 30; i++) reportDiagnostic(exportFailure);

    assert.equal(auditCount(), 60);
  });

  it('windows are per-diagnostic, so an unrelated diagnostic still prints', () => {
    for (let i = 0; i < 20; i++) reportDiagnostic(exportFailure);
    reportDiagnostic({
      severity: 'error', source: 'config', kind: 'schema_invalid',
      message: 'guard.protection_level is not one of strict|balanced|permissive',
    });

    assert.match(stderrText(), /\[nio:config:schema_invalid\]/);
  });
});
