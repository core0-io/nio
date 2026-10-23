// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { guardAuditFixture } from './helpers/guard-audit.js';
import { emitAuditLog } from '../scripts/lib/logs-collector.js';

describe('audit log severity', () => {
  for (const [risk, number, text] of [
    ['low', 9, 'INFO'],
    ['medium', 13, 'WARN'],
    ['high', 17, 'ERROR'],
    ['critical', 21, 'FATAL'],
  ] as const) {
    it(`emits ${risk} risk as standard ${text} severity`, async () => {
      const exporter = new InMemoryLogRecordExporter();
      const provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor(exporter)] });
      try {
        emitAuditLog(provider, { ...guardAuditFixture(), risk_level: risk });
        await provider.forceFlush();
        const [record] = exporter.getFinishedLogRecords();
        assert.equal(record.severityNumber, number);
        assert.equal(record.severityText, text);
        assert.equal(record.attributes['nio.guard.risk_level'], risk);
        assert.equal(JSON.parse(String(record.body)).risk_level, risk);
      } finally {
        await provider.shutdown();
      }
    });
  }
  it('emits ordinary events as INFO', async () => {
    const exporter = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor(exporter)] });
    try {
      emitAuditLog(provider, { event: 'SessionStart', platform: 'test', timestamp: '2026-10-22T00:00:00.000Z' });
      await provider.forceFlush();
      const [record] = exporter.getFinishedLogRecords();
      assert.equal(record.severityNumber, 9);
      assert.equal(record.severityText, 'INFO');
      assert.equal(record.attributes['nio.guard.risk_level'], undefined);
    } finally {
      await provider.shutdown();
    }
  });
});

describe('guard audit projection', () => {
  it('exports evaluation identity, termination, nullable scores and event time', async () => {
    const exporter = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor(exporter)] });
    const timestamp = '2026-10-22T01:02:03.000Z';
    const entry = guardAuditFixture();
    Object.assign(entry, { timestamp, decision: 'error', risk_level: null, risk_score: null,
      error: { kind: 'Error', message: 'Engine failed' },
      termination: { kind: 'engine_error', blocked_gate: null, trigger_finding_ids: [], reason: 'Engine failed' } });
    Object.assign(entry.phases[0], { status: 'failed', error: entry.error, score: null, duration_ms: null });
    emitAuditLog(provider, entry);
    await provider.forceFlush();
    const [record] = exporter.getFinishedLogRecords();
    assert.equal(record.attributes['nio.guard.evaluation_id'], entry.evaluation_id);
    assert.equal(record.attributes['nio.guard.decision'], 'error');
    assert.equal(record.attributes['nio.guard.termination'], 'engine_error');
    assert.equal(record.attributes['nio.guard.risk_score'], undefined);
    assert.equal(record.attributes['nio.phases.0.score'], undefined);
    assert.equal(record.attributes['nio.phases.0.duration_ms'], undefined);
    assert.equal(record.hrTime[0] * 1000 + record.hrTime[1] / 1e6, Date.parse(timestamp));
    await provider.shutdown();
  });
});
