// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end: a collector pointed at an unreachable endpoint must record the
 * send failure to the audit log rather than failing silently. Uses
 * 127.0.0.1:1 (connection refused, no real network) so the OTLP exporter's
 * FAILED result fires fast.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMeterProvider, recordToolUse } from '../scripts/lib/metrics-collector.js';
import { createTracerProvider } from '../scripts/lib/traces-collector.js';
import { createLoggerProvider, emitAuditLog } from '../scripts/lib/logs-collector.js';
import type { CollectorConfig } from '../scripts/lib/config-loader.js';
import { _setDiagnosticsAuditPathForTests } from '../adapters/diagnostics.js';

const unreachable: CollectorConfig = {
  endpoint: 'http://127.0.0.1:1',
  api_key: '',
  headers: {},
  timeout: 1000,
  protocol: 'http',
  enabled: true,
  metrics_enabled: true,
  traces_enabled: true,
  logs_enabled: true,
};

let auditDir: string;
let auditPath: string;

before(() => {
  auditDir = mkdtempSync(join(tmpdir(), 'nio-export-fail-test-'));
  auditPath = join(auditDir, 'audit.jsonl');
  _setDiagnosticsAuditPathForTests(auditPath);
});

after(() => {
  _setDiagnosticsAuditPathForTests(null);
  try { rmSync(auditDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  writeFileSync(auditPath, '');
});

function exportFailures(signal: string): Array<Record<string, unknown>> {
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as Record<string, unknown>)
    .filter(e => e.kind === 'otlp_export_failed' && e.component === signal);
}

describe('collector export failures land in the audit log', () => {
  it('traces: failed span export is audited', async () => {
    const provider = createTracerProvider(unreachable, 'test');
    assert.ok(provider);
    const span = provider!.getTracer('t').startSpan('s');
    span.end();
    await provider!.forceFlush();
    await provider!.shutdown();

    assert.ok(exportFailures('traces').length >= 1, 'a traces export failure was recorded');
  });

  it('metrics: failed metric export is audited', async () => {
    const provider = createMeterProvider(unreachable, 'test');
    assert.ok(provider);
    await recordToolUse(provider!, 'Bash', 'PreToolUse');
    await provider!.forceFlush();
    await provider!.shutdown();

    assert.ok(exportFailures('metrics').length >= 1, 'a metrics export failure was recorded');
  });

  it('logs: failed log export is audited', async () => {
    const provider = createLoggerProvider(unreachable, 'test');
    assert.ok(provider);
    emitAuditLog(provider!, { event: 'SessionStart', platform: 'test' });
    await provider!.forceFlush();
    await provider!.shutdown();

    assert.ok(exportFailures('logs').length >= 1, 'a logs export failure was recorded');
  });
});
