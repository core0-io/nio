// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DiagnosticCollector,
  flushSuppressedDiagnostics,
  formatDiagnosticsForUser,
  reportDiagnostic,
  _setDiagnosticsAuditPathForTests,
  _setDiagnosticsThrottleForTests,
  type Diagnostic,
} from '../adapters/diagnostics.js';

// Each test run gets a fresh tmpdir for the audit log so concurrent test
// files / repeated runs don't bleed state.
let auditDir: string;
let auditPath: string;

before(() => {
  auditDir = mkdtempSync(join(tmpdir(), 'nio-diagnostics-test-'));
  auditPath = join(auditDir, 'audit.jsonl');
  _setDiagnosticsAuditPathForTests(auditPath);
});

after(() => {
  _setDiagnosticsAuditPathForTests(null);
  try { rmSync(auditDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function readAuditLines(): Array<Record<string, unknown>> {
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as Record<string, unknown>);
}

describe('reportDiagnostic', () => {
  it('appends a single line per call to the audit log', () => {
    const before = readAuditLines().length;
    reportDiagnostic({
      severity: 'error',
      source: 'oauth',
      kind: 'token_failed',
      component: 'scoring.example.com',
      message: 'client_credentials grant failed',
      detail: 'HTTP 401',
      hint: 'Check client_id.',
    });
    const after = readAuditLines();
    assert.equal(after.length, before + 1);

    const entry = after[after.length - 1];
    assert.equal(entry.event, 'diagnostic');
    assert.equal(entry.source, 'oauth');
    assert.equal(entry.kind, 'token_failed');
    assert.equal(entry.severity, 'error');
    assert.equal(entry.message, 'client_credentials grant failed');
    assert.equal(entry.hint, 'Check client_id.');
    assert.ok(typeof entry.timestamp === 'string', 'timestamp is set');
  });

  // This used to assert the opposite — three identical reports had to
  // produce three lines, "reader-side dedup". That contract is what let a
  // live audit.jsonl reach 34 689 export-failure entries (97 % of the
  // file) and evict the guard records it exists to hold. Repeats are now
  // collapsed on both legs; see diagnostics-audit-flood.test.ts for the
  // full replacement contract. What must NOT change is that no occurrence
  // is lost, which is what this test now pins.
  it('collapses identical entries while conserving the count', () => {
    _setDiagnosticsThrottleForTests();
    const before = readAuditLines().length;
    const d: Diagnostic = {
      severity: 'warning',
      source: 'collector',
      kind: 'otlp_export_failed',
      message: 'export failed',
    };
    reportDiagnostic(d);
    reportDiagnostic(d);
    reportDiagnostic(d);

    assert.equal(readAuditLines().length, before + 1, 'three reports, one line');

    flushSuppressedDiagnostics(true);
    const written = readAuditLines().slice(before);
    const accounted = written.reduce(
      (n, l) => n + ((l.suppressed_count as number | undefined) ?? 1), 0,
    );
    assert.equal(accounted, 3, 'all three occurrences are still accounted for');
  });
});

describe('DiagnosticCollector', () => {
  it('collect() stores and audits; take() returns and clears', () => {
    const c = new DiagnosticCollector();
    c.collect({ severity: 'error', source: 'llm', kind: 'api_key_missing', message: 'no key' });
    c.collect({ severity: 'error', source: 'llm', kind: 'api_call_failed', message: 'boom' });
    const taken = c.take();
    assert.equal(taken.length, 2);
    assert.equal(taken[0].kind, 'api_key_missing');
    assert.equal(c.peek().length, 0, 'buffer is empty after take');
  });

  it('addCollected() merges without re-writing to audit/stderr', () => {
    const beforeCount = readAuditLines().length;
    const seed: Diagnostic[] = [
      { severity: 'error', source: 'oauth', kind: 'token_failed', message: 'seeded' },
    ];
    const c = new DiagnosticCollector();
    c.addCollected(seed);

    assert.equal(c.peek().length, 1);
    // No audit lines added — addCollected is purely in-memory.
    assert.equal(readAuditLines().length, beforeCount);
  });

  it('absorb(other) moves entries from another collector', () => {
    const a = new DiagnosticCollector();
    const b = new DiagnosticCollector();
    b.collect({ severity: 'info', source: 'config', kind: 'schema_invalid', message: 'b1' });
    b.collect({ severity: 'info', source: 'config', kind: 'schema_invalid', message: 'b2' });

    a.absorb(b);
    assert.equal(a.peek().length, 2, 'a got both entries');
    assert.equal(b.peek().length, 0, 'b drained');
  });
});

describe('formatDiagnosticsForUser', () => {
  it('returns empty string for empty input', () => {
    assert.equal(formatDiagnosticsForUser([]), '');
  });

  it('renders count summary + per-diag bullets with hints', () => {
    const out = formatDiagnosticsForUser([
      {
        severity: 'error', source: 'oauth', kind: 'token_failed',
        component: 'scorer_primary', message: 'HTTP 401 at /token',
        hint: 'Check client_id.',
      },
      {
        severity: 'warning', source: 'collector', kind: 'otlp_export_failed',
        message: 'export failed',
      },
    ]);
    assert.match(out, /1 error/);
    assert.match(out, /1 warning/);
    assert.match(out, /\[oauth token_failed\] scorer_primary: HTTP 401 at \/token/);
    assert.match(out, /hint: Check client_id\./);
    assert.match(out, /\[collector otlp_export_failed\] export failed/);
    assert.match(out, /Run \/nio doctor/);
  });
});
