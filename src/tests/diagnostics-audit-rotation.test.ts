// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Rotation on the diagnostics leg.
 *
 * THE DEFECT
 *
 * `writeAuditLog()` in common.ts rotates before appending — it calls
 * `rotateIfNeeded(auditPath, logsConfig?.max_size_mb)`. `reportDiagnostic`
 * writes to the SAME file through its own `appendFileSync` and never
 * rotated at all. So the size ceiling only ever applied to real agent
 * events: a host emitting nothing but diagnostics (an in-process session
 * whose collector endpoint is down does exactly that) grew the file
 * without bound until the next real event happened to check.
 *
 * WHY THE LIMIT MUST BE SHARED, NOT RE-DERIVED
 *
 * Both writers rotate the same path, so the smaller ceiling wins: if the
 * diagnostics leg rotated at the 10 MB built-in default while the user
 * configured `collector.logs.max_size_mb: 100`, the file would be renamed
 * at 10 MB every time and the configured 100 MB window would silently
 * never exist — losing ten times more history than before the fix.
 * `setDiagnosticsAuditLimitMb()` is how the configured value reaches this
 * leg; common.ts calls it as it loads the same config.
 */

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  reportDiagnostic,
  setDiagnosticsAuditLimitMb,
  _setDiagnosticsAuditPathForTests,
  _setDiagnosticsThrottleForTests,
  type Diagnostic,
} from '../adapters/diagnostics.js';
import { trackTempDir } from './helpers/tmp-dirs.js';

let auditDir: string;
let auditPath: string;
let originalWrite: typeof process.stderr.write;

before(() => {
  auditDir = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-diag-rotate-test-')));
  auditPath = join(auditDir, 'audit.jsonl');
});

after(() => {
  _setDiagnosticsAuditPathForTests(null);
  setDiagnosticsAuditLimitMb(undefined);
  try { rmSync(auditDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  writeFileSync(auditPath, '');
  try { rmSync(auditPath + '.1'); } catch { /* not there yet */ }
  _setDiagnosticsAuditPathForTests(auditPath);
  _setDiagnosticsThrottleForTests();
  originalWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: unknown }).write = (): boolean => true;
});

afterEach(() => {
  (process.stderr as unknown as { write: unknown }).write = originalWrite;
  setDiagnosticsAuditLimitMb(undefined);
});

/** A distinct diagnostic each time, so flood control never collapses them. */
function distinctFailure(n: number): Diagnostic {
  return {
    severity: 'warning',
    source: 'collector',
    kind: 'otlp_export_failed',
    component: 'metrics',
    message: 'Failed to export metrics to the OTLP endpoint',
    detail: `failure #${n}`,
  };
}

describe('diagnostics audit rotation', () => {
  it('rotates the audit file once it passes the limit', () => {
    setDiagnosticsAuditLimitMb(0.001); // 1 KB — a handful of entries

    for (let i = 0; i < 40; i++) reportDiagnostic(distinctFailure(i));

    assert.ok(existsSync(auditPath + '.1'), 'the previous generation was rolled over');
    const live = readFileSync(auditPath, 'utf-8');
    assert.ok(live.length < 1024 * 2, `the live file was truncated by rotation, got ${live.length}B`);
  });

  it('keeps writing after a rotation', () => {
    setDiagnosticsAuditLimitMb(0.001);
    for (let i = 0; i < 40; i++) reportDiagnostic(distinctFailure(i));

    reportDiagnostic(distinctFailure(999));

    const live = readFileSync(auditPath, 'utf-8');
    assert.match(live, /failure #999/, 'the newest diagnostic is in the live file');
  });

  // Same 40 writes as the first case, only the configured ceiling
  // differs — which is what shows the limit is read from configuration
  // rather than from a constant baked into this leg.
  it('does not rotate below the limit', () => {
    setDiagnosticsAuditLimitMb(100);

    for (let i = 0; i < 40; i++) reportDiagnostic(distinctFailure(i));

    assert.equal(existsSync(auditPath + '.1'), false, 'nothing was rolled over');
    const lines = readFileSync(auditPath, 'utf-8').split('\n').filter(Boolean);
    assert.equal(lines.length, 40, 'all 40 distinct diagnostics are still here');
  });
});
