// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
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
        emitAuditLog(provider, { event: 'guard', platform: 'test', risk_level: risk, decision: 'deny' });
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
      emitAuditLog(provider, { event: 'SessionStart', platform: 'test' });
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
    emitAuditLog(provider, { event: 'guard', platform: 'test', timestamp,
      evaluation_id: 'evaluation', decision: 'error', risk_level: null, risk_score: null,
      termination: { kind: 'engine_error', blocked_gate: null },
      phases: [{ score: null, duration_ms: null, finding_count: 0 }] });
    await provider.forceFlush();
    const [record] = exporter.getFinishedLogRecords();
    assert.equal(record.attributes['nio.guard.evaluation_id'], 'evaluation');
    assert.equal(record.attributes['nio.guard.decision'], 'error');
    assert.equal(record.attributes['nio.guard.termination'], 'engine_error');
    assert.equal(record.attributes['nio.guard.risk_score'], undefined);
    assert.equal(record.attributes['nio.phases.0.score'], undefined);
    assert.equal(record.attributes['nio.phases.0.duration_ms'], undefined);
    assert.equal(record.hrTime[0] * 1000 + record.hrTime[1] / 1e6, Date.parse(timestamp));
    await provider.shutdown();
  });
});
