// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';

import {
  instrumentExporter,
  reportFlushFailure,
} from '../scripts/lib/exporter-diagnostics.js';
import { _setDiagnosticsAuditPathForTests } from '../adapters/diagnostics.js';
import { trackTempDir } from './helpers/tmp-dirs.js';

// Mirror the diagnostics tests: point the diagnostics audit-log writer at a
// temp file so we can assert on what landed in audit.jsonl.
let auditDir: string;
let auditPath: string;

before(() => {
  auditDir = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-exporter-diag-test-')));
  auditPath = join(auditDir, 'audit.jsonl');
  _setDiagnosticsAuditPathForTests(auditPath);
});

after(() => {
  _setDiagnosticsAuditPathForTests(null);
  try { rmSync(auditDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  // Truncate between tests so assertions on "last line" are unambiguous.
  writeFileSync(auditPath, '');
});

function readAuditLines(): Array<Record<string, unknown>> {
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as Record<string, unknown>);
}

/** Minimal exporter stub matching the OTEL push-exporter `export()` shape. */
function fakeExporter(behaviour: 'success' | 'fail' | 'throw') {
  return {
    export(_items: unknown, resultCallback: (r: ExportResult) => void): void {
      if (behaviour === 'throw') throw new Error('socket hang up');
      if (behaviour === 'fail') {
        resultCallback({ code: ExportResultCode.FAILED, error: new Error('ECONNREFUSED 127.0.0.1:4318') });
      } else {
        resultCallback({ code: ExportResultCode.SUCCESS });
      }
    },
  };
}

describe('instrumentExporter', () => {
  it('records a collector diagnostic when export() reports FAILED', () => {
    const exporter = instrumentExporter(fakeExporter('fail'), 'traces', 'http://localhost:4318');

    let received: ExportResult | undefined;
    exporter.export([], (r) => { received = r; });

    const lines = readAuditLines();
    assert.equal(lines.length, 1, 'one diagnostic written');
    const entry = lines[0];
    assert.equal(entry.event, 'diagnostic');
    assert.equal(entry.source, 'collector');
    assert.equal(entry.kind, 'otlp_export_failed');
    assert.equal(entry.severity, 'warning');
    assert.equal(entry.component, 'traces');
    assert.match(String(entry.detail), /ECONNREFUSED/);

    // Original callback still fires with the unaltered result.
    assert.equal(received?.code, ExportResultCode.FAILED);
  });

  it('writes nothing when export() succeeds', () => {
    const exporter = instrumentExporter(fakeExporter('success'), 'metrics', 'http://localhost:4318');

    let received: ExportResult | undefined;
    exporter.export([], (r) => { received = r; });

    assert.equal(readAuditLines().length, 0, 'no diagnostic on success');
    assert.equal(received?.code, ExportResultCode.SUCCESS);
  });

  it('records a diagnostic and reports failure when export() throws synchronously', () => {
    const exporter = instrumentExporter(fakeExporter('throw'), 'logs', 'http://localhost:4318');

    let received: ExportResult | undefined;
    // A synchronous throw is surfaced to the caller as a FAILED result, never rethrown,
    // so the OTEL processor's flush promise resolves instead of crashing the hook.
    assert.doesNotThrow(() => exporter.export([], (r) => { received = r; }));

    const lines = readAuditLines();
    assert.equal(lines.length, 1);
    assert.equal(lines[0].kind, 'otlp_export_failed');
    assert.equal(lines[0].component, 'logs');
    assert.match(String(lines[0].detail), /socket hang up/);

    assert.equal(received?.code, ExportResultCode.FAILED);
  });

  it('returns the same exporter instance (mutating wrap, preserves other methods)', () => {
    const original = { ...fakeExporter('success'), shutdown: () => Promise.resolve() };
    const wrapped = instrumentExporter(original, 'metrics', 'http://x');
    assert.equal(wrapped, original, 'same reference');
    assert.equal(typeof wrapped.shutdown, 'function', 'sibling methods preserved');
  });
});

describe('reportFlushFailure', () => {
  it('records a collector diagnostic for a rejected forceFlush', () => {
    reportFlushFailure('traces', 'http://localhost:4318', new Error('flush timed out'));

    const lines = readAuditLines();
    assert.equal(lines.length, 1);
    const entry = lines[0];
    assert.equal(entry.source, 'collector');
    assert.equal(entry.kind, 'otlp_flush_failed');
    assert.equal(entry.component, 'traces');
    assert.match(String(entry.detail), /flush timed out/);
  });
});
