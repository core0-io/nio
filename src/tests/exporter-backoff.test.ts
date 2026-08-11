// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Export backoff + honest failure text.
 *
 * Context (measured on a live Pi session, `~/.nio/audit.jsonl`, 845
 * diagnostics): the two most common OTLP export failures were
 * `Concurrent export limit reached` (61 %) and `Request timed out`
 * (26 %). NEITHER means the endpoint is unreachable — the first never
 * touches the network at all, because `otlp-exporter-base` caps in-flight
 * exports at 30 per exporter and rejects the overflow itself. The old
 * code printed a "check endpoint reachability" hint for all of them and
 * never printed `detail`, so the true cause was invisible.
 *
 * Nothing here may weaken the rule that telemetry cannot affect the
 * guard: the breaker only ever changes what the exporter returns.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';

import {
  instrumentExporter,
  errMessage,
  OPEN_AFTER_FAILURES,
  _setExporterBackoffClockForTests,
} from '../scripts/lib/exporter-diagnostics.js';
import {
  _setDiagnosticsAuditPathForTests,
  _setDiagnosticsThrottleForTests,
} from '../adapters/diagnostics.js';
import { trackTempDir } from './helpers/tmp-dirs.js';

let auditDir: string;
let auditPath: string;
let nowMs = 5_000_000;

before(() => {
  auditDir = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-exporter-backoff-test-')));
  auditPath = join(auditDir, 'audit.jsonl');
  _setDiagnosticsAuditPathForTests(auditPath);
});

after(() => {
  _setDiagnosticsAuditPathForTests(null);
  _setExporterBackoffClockForTests(null);
  _setDiagnosticsThrottleForTests({ now: null, windowMs: null });
  try { rmSync(auditDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  writeFileSync(auditPath, '');
  nowMs = 5_000_000;
  _setExporterBackoffClockForTests(() => nowMs);
  // Keep the stderr limiter out of the way: these assertions are about the
  // audit leg, which is deliberately never throttled.
  _setDiagnosticsThrottleForTests({ now: () => nowMs, windowMs: 60_000 });
});

function auditEntries(): Array<Record<string, unknown>> {
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, 'utf-8')
    .split('\n').filter(Boolean)
    .map(l => JSON.parse(l) as Record<string, unknown>);
}

function ofKind(kind: string): Array<Record<string, unknown>> {
  return auditEntries().filter(e => e.kind === kind);
}

/** Exporter whose outcome the test flips between calls. */
function switchableExporter() {
  const state = { fail: true, attempts: 0, error: new Error('Concurrent export limit reached') };
  const exporter = {
    export(_items: unknown, cb: (r: ExportResult) => void): void {
      state.attempts++;
      if (state.fail) cb({ code: ExportResultCode.FAILED, error: state.error });
      else cb({ code: ExportResultCode.SUCCESS });
    },
  };
  return { state, exporter };
}

describe('export backoff', () => {
  it('lets the first failures through untouched, then pauses', () => {
    const { state, exporter } = switchableExporter();
    const wrapped = instrumentExporter(exporter, 'metrics', 'http://localhost:4318');

    for (let i = 0; i < 40; i++) wrapped.export([], () => {});

    assert.equal(state.attempts, OPEN_AFTER_FAILURES,
      'only the pre-pause attempts reached the exporter');
    assert.equal(ofKind('otlp_export_failed').length, OPEN_AFTER_FAILURES,
      'the fault was reported before nio stopped retrying');
    assert.equal(ofKind('otlp_export_backoff').length, 1,
      'exactly one diagnostic announces the pause');
  });

  it('short-circuited exports still report FAILED to the caller', () => {
    const { exporter } = switchableExporter();
    const wrapped = instrumentExporter(exporter, 'traces', 'http://localhost:4318');

    for (let i = 0; i < OPEN_AFTER_FAILURES; i++) wrapped.export([], () => {});

    let result: ExportResult | undefined;
    wrapped.export([], r => { result = r; });
    assert.equal(result?.code, ExportResultCode.FAILED);
    assert.match(String(result?.error?.message), /paused/);
  });

  it('retries once the pause elapses, and backs off further if it fails again', () => {
    const { state, exporter } = switchableExporter();
    const wrapped = instrumentExporter(exporter, 'metrics', 'http://localhost:4318');

    for (let i = 0; i < 10; i++) wrapped.export([], () => {});
    assert.equal(state.attempts, OPEN_AFTER_FAILURES);

    nowMs += 1_001;             // first pause is 1s
    wrapped.export([], () => {});
    assert.equal(state.attempts, OPEN_AFTER_FAILURES + 1, 'a live probe was allowed through');

    // It failed again, so the next pause is longer: still paused at +1.5s.
    nowMs += 1_500;
    wrapped.export([], () => {});
    assert.equal(state.attempts, OPEN_AFTER_FAILURES + 1, 'still paused — the delay doubled');

    nowMs += 1_000;             // now past the 2s pause
    wrapped.export([], () => {});
    assert.equal(state.attempts, OPEN_AFTER_FAILURES + 2);
  });

  it('resumes at full rate after a success and says what was dropped', () => {
    const { state, exporter } = switchableExporter();
    const wrapped = instrumentExporter(exporter, 'logs', 'http://localhost:4318');

    for (let i = 0; i < 12; i++) wrapped.export([], () => {});
    const droppedSoFar = 12 - OPEN_AFTER_FAILURES;

    state.fail = false;
    nowMs += 1_001;
    wrapped.export([], () => {});

    const recovered = ofKind('otlp_export_recovered');
    assert.equal(recovered.length, 1);
    assert.match(String(recovered[0].detail), new RegExp(`${droppedSoFar} export`));

    const before = state.attempts;
    for (let i = 0; i < 5; i++) wrapped.export([], () => {});
    assert.equal(state.attempts, before + 5, 'no pause remains after recovery');
  });

  it('a recovered exporter starts its next backoff from the base delay', () => {
    // Without a full state reset on success, `consecutiveFailures` keeps
    // climbing across outages: the second outage would open straight at
    // the 30s ceiling, so a signal that recovered once effectively stops
    // reporting for the rest of the session.
    const { state, exporter } = switchableExporter();
    const wrapped = instrumentExporter(exporter, 'metrics', 'http://localhost:4318');

    for (let i = 0; i < 12; i++) wrapped.export([], () => {});   // deep backoff
    state.fail = false;
    nowMs += 30_001;
    wrapped.export([], () => {});                                 // recovered

    state.fail = true;
    for (let i = 0; i < OPEN_AFTER_FAILURES; i++) wrapped.export([], () => {});
    const attemptsAtPause = state.attempts;

    nowMs += 1_001;   // only the BASE delay has elapsed
    wrapped.export([], () => {});
    assert.equal(state.attempts, attemptsAtPause + 1,
      'the new outage backed off by 1s, not by the previous outage\'s delay');
  });

  it('counts dropped exports per outage, not cumulatively', () => {
    const { state, exporter } = switchableExporter();
    const wrapped = instrumentExporter(exporter, 'logs', 'http://localhost:4318');

    for (let i = 0; i < 10; i++) wrapped.export([], () => {});     // 7 dropped
    state.fail = false;
    nowMs += 30_001;
    wrapped.export([], () => {});

    state.fail = true;
    for (let i = 0; i < OPEN_AFTER_FAILURES + 2; i++) wrapped.export([], () => {});
    state.fail = false;
    nowMs += 30_001;
    wrapped.export([], () => {});

    const recovered = ofKind('otlp_export_recovered');
    assert.equal(recovered.length, 2);
    assert.match(String(recovered[1].detail), /^2 export/,
      'the second outage reports its own drops, not 7 + 2');
  });

  it('worded identically once the delay is capped, so stderr can collapse it', () => {
    // A capped pause repeats for as long as the outage lasts. If its text
    // carried the ever-incrementing failure count, every repeat would look
    // like a NEW diagnostic to the stderr limiter and an eight-hour outage
    // would print one line every 30s all night.
    const { exporter } = switchableExporter();
    const wrapped = instrumentExporter(exporter, 'metrics', 'http://localhost:4318');

    for (let i = 0; i < 200; i++) {
      wrapped.export([], () => {});
      nowMs += 31_000;   // step past each pause so the next probe runs
    }

    const messages = ofKind('otlp_export_backoff').map(e => String(e.message));
    const capped = messages.filter(m => /for 30s/.test(m));
    assert.ok(capped.length > 5, `expected several capped pauses, saw ${capped.length}`);
    assert.equal(new Set(capped).size, 1,
      `capped pauses must all read the same; saw ${new Set(capped).size} variants`);
  });

  it('a healthy exporter is never paused and never reports anything', () => {
    const { state, exporter } = switchableExporter();
    state.fail = false;
    const wrapped = instrumentExporter(exporter, 'traces', 'http://localhost:4318');

    for (let i = 0; i < 50; i++) wrapped.export([], () => {});

    assert.equal(state.attempts, 50);
    assert.equal(auditEntries().length, 0);
  });
});

describe('failure text', () => {
  it('names the exporter-side refusal instead of blaming the endpoint', () => {
    const { exporter } = switchableExporter();
    const wrapped = instrumentExporter(exporter, 'metrics', 'http://localhost:4318');
    wrapped.export([], () => {});

    const entry = ofKind('otlp_export_failed')[0];
    assert.equal(entry.detail, 'Concurrent export limit reached');
    assert.match(String(entry.hint), /in-flight limit/);
    assert.doesNotMatch(String(entry.hint), /reachability/,
      'this failure never touched the network, so reachability is not the diagnosis');
  });

  it('points a timeout at collector.timeout, not at reachability', () => {
    const { state, exporter } = switchableExporter();
    state.error = new Error('Request timed out');
    const wrapped = instrumentExporter(exporter, 'metrics', 'http://localhost:4318');
    wrapped.export([], () => {});

    const entry = ofKind('otlp_export_failed')[0];
    assert.match(String(entry.hint), /collector\.timeout/);
  });

  it('keeps the reachability hint for a genuine connect failure', () => {
    const { state, exporter } = switchableExporter();
    state.error = new Error('connect ECONNREFUSED 127.0.0.1:4318');
    const wrapped = instrumentExporter(exporter, 'logs', 'http://localhost:4318');
    wrapped.export([], () => {});

    assert.match(String(ofKind('otlp_export_failed')[0].hint), /reachability/);
  });

  it('unwraps an AggregateError instead of rendering the bare class name', () => {
    // Node's happy-eyeballs connect failures arrive like this: an empty
    // `message`, with the real causes in `.errors`. 115 lines in the real
    // audit log said only "AggregateError".
    const agg = new AggregateError(
      [new Error('connect ECONNREFUSED ::1:4318'), new Error('connect ECONNREFUSED 127.0.0.1:4318')],
      '',
    );
    const rendered = errMessage(agg);
    assert.match(rendered, /ECONNREFUSED ::1:4318/);
    assert.match(rendered, /ECONNREFUSED 127\.0\.0\.1:4318/);
    assert.notEqual(rendered, 'AggregateError');
  });

  it('falls back to the error code when message and errors are both empty', () => {
    const err = Object.assign(new Error(''), { code: 'EMFILE' });
    assert.match(errMessage(err), /EMFILE/);
  });
});
