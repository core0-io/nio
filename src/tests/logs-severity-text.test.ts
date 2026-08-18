// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * `severityText` must be an OTel severity name, not a nio risk level.
 *
 * The defect this file pins was found on a live SigNoz backend: traces
 * looked fine, and the Logs panel showed nothing at all — while ClickHouse
 * held 834 rows the whole time. Every row read
 * `severity_text = 'low'` with `severity_number = 9`.
 *
 * `emitAuditLog` wrote nio's RISK LEVEL into `severityText`:
 *
 *     const severityLevel = ('risk_level' in entry ? entry.risk_level : 'low');
 *     severityNumber: RISK_TO_SEVERITY[severityLevel] ?? INFO,   // correct
 *     severityText: severityLevel,                               // 'low'
 *
 * Two separate problems in three lines:
 *
 *  1. `low` / `medium` / `high` / `critical` are not severity names. The
 *     OTel logs data model defines the 1–24 severity range with the names
 *     TRACE / DEBUG / INFO / WARN / ERROR / FATAL (+ numbered variants),
 *     and backends build their severity facets from that vocabulary.
 *     SigNoz's Logs UI is one of them, so the whole signal fell out of the
 *     severity-driven views.
 *  2. The `: 'low'` default hit EVERY entry without a risk level —
 *     lifecycle, hook and diagnostic entries, i.e. most of them — so the
 *     majority of records claimed a risk verdict nio never reached.
 *
 * Why the old suite could not see it: nothing asserted `severityText` at
 * all, and a test that merely pinned it to the string `'low'` would have
 * been just as blind. The assertions below therefore check what the value
 * MEANS to a backend — membership in the OTel-defined vocabulary, and
 * agreement with the record's own `severityNumber` — rather than equality
 * with a literal chosen by the implementation.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ReadableLogRecord } from '@opentelemetry/sdk-logs';

import { emitAuditLog, emitContentRecords } from '../scripts/lib/logs-collector.js';
import type { ContentRecord } from '../scripts/lib/content/emit.js';
import { makeInMemoryLogger, type InMemoryLogger } from './helpers/logger.js';

// ---------------------------------------------------------------------------
// The OTel vocabulary, transcribed from the spec — NOT imported from the
// module under test. Importing nio's own table would make every assertion
// below a tautology: the code would be checked against itself.
//
// OpenTelemetry Logs Data Model, "Field: SeverityNumber" / "Field:
// SeverityText": severity numbers 1–24 form six bands of four; the first
// number of each band carries the bare name, the rest are suffixed 2/3/4.
// ---------------------------------------------------------------------------

const OTEL_SEVERITY_BANDS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] as const;

const OTEL_NAME_BY_NUMBER: ReadonlyMap<number, string> = new Map(
  OTEL_SEVERITY_BANDS.flatMap((band, bandIndex) =>
    [0, 1, 2, 3].map((offset): [number, string] => [
      1 + bandIndex * 4 + offset,
      offset === 0 ? band : `${band}${offset + 1}`,
    ])),
);

const OTEL_SEVERITY_NAMES: ReadonlySet<string> = new Set(OTEL_NAME_BY_NUMBER.values());

/** Nio's risk vocabulary — a business dimension, never a log level. */
const NIO_RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;

/**
 * The two checks that make this a real assertion rather than a string
 * comparison:
 *
 *  - the text is a name the OTel data model actually defines, so a backend
 *    can bucket it;
 *  - it is the name for THIS record's `severityNumber`, so the two fields
 *    cannot contradict each other (the live rows had `'low'` / `9`).
 */
function assertOtelSeverity(record: ReadableLogRecord, what: string): void {
  const text = record.severityText;
  const number = record.severityNumber;

  assert.equal(typeof text, 'string', `${what}: severityText must be set`);
  assert.ok(
    OTEL_SEVERITY_NAMES.has(text as string),
    `${what}: severityText ${JSON.stringify(text)} is not one of the severity names the `
    + `OTel logs data model defines (${[...OTEL_SEVERITY_NAMES].join(', ')}). A backend `
    + 'that facets on severity cannot bucket it, which is how SigNoz showed "no logs data" '
    + 'for 834 rows that were in ClickHouse all along.',
  );
  assert.equal(
    text,
    OTEL_NAME_BY_NUMBER.get(number as number),
    `${what}: severityText ${JSON.stringify(text)} contradicts severityNumber ${number} — `
    + `the data model names that number ${JSON.stringify(OTEL_NAME_BY_NUMBER.get(number as number))}`,
  );
}

function attrs(record: ReadableLogRecord): Record<string, unknown> {
  return record.attributes as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Fixtures — one per audit entry family, so the "no risk_level" majority is
// represented and not just the guard entry that happens to have one.
// ---------------------------------------------------------------------------

interface Fixture {
  what: string;
  entry: Record<string, unknown>;
  /** Expected `nio.risk_level` attribute, or undefined when it must be absent. */
  riskLevel?: string;
  /** Expected severity number (the mapping this fix must NOT change). */
  severityNumber: number;
}

const FIXTURES: readonly Fixture[] = [
  {
    what: 'guard entry, risk low',
    entry: { event: 'guard', platform: 'claude-code', decision: 'allow', risk_level: 'low', risk_score: 0.1 },
    riskLevel: 'low',
    severityNumber: 9,
  },
  {
    what: 'guard entry, risk medium',
    entry: { event: 'guard', platform: 'claude-code', decision: 'ask', risk_level: 'medium', risk_score: 0.5 },
    riskLevel: 'medium',
    severityNumber: 13,
  },
  {
    what: 'guard entry, risk high',
    entry: { event: 'guard', platform: 'claude-code', decision: 'deny', risk_level: 'high', risk_score: 0.8 },
    riskLevel: 'high',
    severityNumber: 17,
  },
  {
    what: 'guard entry, risk critical',
    entry: { event: 'guard', platform: 'claude-code', decision: 'deny', risk_level: 'critical', risk_score: 1 },
    riskLevel: 'critical',
    severityNumber: 21,
  },
  {
    what: 'session_scan entry (risk level, no decision)',
    entry: { event: 'session_scan', platform: 'claude-code', skill_name: 'demo', risk_level: 'high' },
    riskLevel: 'high',
    severityNumber: 17,
  },
  {
    what: 'PreToolUse hook entry (no risk level)',
    entry: { event: 'PreToolUse', platform: 'claude-code', tool_name: 'Bash', session_id: 's1' },
    severityNumber: 9,
  },
  {
    what: 'lifecycle entry (no risk level)',
    entry: { event: 'lifecycle', platform: 'claude-code', lifecycle_type: 'session_start' },
    severityNumber: 9,
  },
  {
    what: 'diagnostic entry (no risk level)',
    entry: { event: 'diagnostic', platform: 'claude-code', source: 'collector', kind: 'otlp_export_failed', message: 'boom' },
    severityNumber: 9,
  },
  {
    what: 'entry with an unrecognised risk level',
    entry: { event: 'guard', platform: 'claude-code', decision: 'allow', risk_level: 'unknown' },
    riskLevel: 'unknown',
    severityNumber: 9,
  },
  {
    what: 'entry whose risk_level is not a string',
    entry: { event: 'guard', platform: 'claude-code', decision: 'allow', risk_level: 42 },
    severityNumber: 9,
  },
];

function contentRecord(index: number): ContentRecord {
  return {
    traceId: '0af7651916cd43dd8448eb211c80319c',
    spanId: 'b7ad6b7169203331',
    body: `body ${index}`,
    attributes: {
      'nio.content.type': 'thinking',
      'nio.content.index': index,
      'nio.trace_id': '0af7651916cd43dd8448eb211c80319c',
      'nio.span_id': 'b7ad6b7169203331',
    },
  };
}

// ---------------------------------------------------------------------------

describe('logs severity — severityText is an OTel severity name', () => {
  let logger: InMemoryLogger;
  let records: readonly ReadableLogRecord[];

  before(async () => {
    logger = makeInMemoryLogger();
    for (const f of FIXTURES) {
      emitAuditLog(logger.provider, f.entry as never);
    }
    emitContentRecords(logger.provider, [contentRecord(0), contentRecord(1)]);
    records = await logger.flushed();
  });

  after(async () => {
    await logger.shutdown();
  });

  it('emits one record per audit entry plus the content records', () => {
    assert.equal(records.length, FIXTURES.length + 2);
  });

  it('every emitted record carries a severityText the OTel data model defines', () => {
    records.forEach((record, i) => {
      assertOtelSeverity(record, `record ${i} (${FIXTURES[i]?.what ?? 'content record'})`);
    });
  });

  it('never puts a nio risk level in severityText — the two vocabularies are disjoint', () => {
    // Guards against re-introducing the exact defect: the risk levels are
    // the values that used to land here, and none of them is a severity
    // name. Asserted explicitly (rather than left implicit in the set
    // membership above) because this disjointness IS the bug.
    for (const level of NIO_RISK_LEVELS) {
      assert.equal(
        OTEL_SEVERITY_NAMES.has(level), false,
        `${level} must not be a severity name — it is a risk classification`,
      );
    }
    for (const [i, record] of records.entries()) {
      assert.equal(
        (NIO_RISK_LEVELS as readonly string[]).includes(record.severityText ?? ''), false,
        `record ${i}: severityText is nio risk level ${JSON.stringify(record.severityText)}`,
      );
    }
  });

  it('keeps the risk → severityNumber mapping unchanged', () => {
    // The numeric side was always right; this pins it so the text fix
    // cannot silently move it. low→INFO(9), medium→WARN(13),
    // high→ERROR(17), critical→FATAL(21), anything else→INFO(9).
    FIXTURES.forEach((f, i) => {
      assert.equal(records[i]!.severityNumber, f.severityNumber, `${f.what}: severityNumber`);
    });
  });

  it('gives records with no risk level plain INFO, not "low risk"', () => {
    const noRisk = FIXTURES
      .map((f, i) => ({ f, record: records[i]! }))
      .filter(({ f }) => f.riskLevel === undefined);
    assert.ok(noRisk.length >= 4, 'fixtures must cover the no-risk-level majority');
    for (const { f, record } of noRisk) {
      assert.equal(record.severityNumber, 9, `${f.what}: severityNumber`);
      assert.equal(record.severityText, 'INFO', `${f.what}: severityText`);
    }
  });

  it('emits content records as INFO — content is not a verdict', () => {
    const content = records.slice(FIXTURES.length);
    assert.equal(content.length, 2);
    for (const record of content) {
      assert.equal(record.severityNumber, 9);
      assert.equal(record.severityText, 'INFO');
    }
  });
});

describe('logs severity — risk level travels as nio.risk_level', () => {
  let logger: InMemoryLogger;
  let records: readonly ReadableLogRecord[];

  before(async () => {
    logger = makeInMemoryLogger();
    for (const f of FIXTURES) {
      emitAuditLog(logger.provider, f.entry as never);
    }
    emitContentRecords(logger.provider, [contentRecord(0)]);
    records = await logger.flushed();
  });

  after(async () => {
    await logger.shutdown();
  });

  it('sets nio.risk_level to the entry\'s own risk level', () => {
    FIXTURES.forEach((f, i) => {
      if (f.riskLevel === undefined) return;
      assert.equal(
        attrs(records[i]!)['nio.risk_level'], f.riskLevel,
        `${f.what}: risk level must survive the move out of severityText`,
      );
    });
  });

  it('omits nio.risk_level entirely when the entry has no risk level', () => {
    FIXTURES.forEach((f, i) => {
      if (f.riskLevel !== undefined) return;
      assert.equal(
        'nio.risk_level' in attrs(records[i]!), false,
        `${f.what}: must not invent a risk level — the old code defaulted these to 'low'`,
      );
    });
  });

  it('carries a scan entry\'s risk level even though it has no guard decision', () => {
    // `nio.guard.*` needs both a decision and a risk level, so before this
    // attribute existed a `session_scan` entry's risk level reached no
    // attribute at all — it lived only in the (invalid) severityText and
    // the JSON body.
    const i = FIXTURES.findIndex((f) => f.entry['event'] === 'session_scan');
    const a = attrs(records[i]!);
    assert.equal(a['nio.risk_level'], 'high');
    assert.equal('nio.guard.risk_level' in a, false, 'fixture must have no guard decision');
  });

  it('leaves nio.guard.risk_level in place for guard entries', () => {
    const i = FIXTURES.findIndex((f) => f.entry['event'] === 'guard' && f.entry['risk_level'] === 'critical');
    const a = attrs(records[i]!);
    assert.equal(a['nio.guard.risk_level'], 'critical');
    assert.equal(a['nio.risk_level'], 'critical');
  });

  it('never puts nio.risk_level on a content record', () => {
    const content = records[FIXTURES.length]!;
    assert.equal('nio.risk_level' in attrs(content), false);
  });
});
