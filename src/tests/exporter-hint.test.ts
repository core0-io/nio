// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * The hint on an `otlp_export_failed` diagnostic has to be TRUE for the
 * failure it is attached to.
 *
 * A single unconditional "check collector.endpoint reachability" was
 * wrong for 86 % of the diagnostics in a live audit log, and the largest
 * single class — 61 % — was `Concurrent export limit reached`: nio's own
 * exporter refusing to send because its 30-slot in-flight queue was full.
 * No request leaves the process on that path, so the endpoint's health is
 * irrelevant to it. Sending a user to debug a healthy collector is worse
 * than saying nothing, and it is the exact misdirection the printed
 * `detail` field (see diagnostics-throttle.test.ts) exists to end.
 *
 * Driven through `instrumentExporter` with a stub exporter rather than a
 * real OTLP one: the branch under test is chosen by the failure TEXT, and
 * a stub is the only way to produce all three texts deterministically —
 * a real concurrency rejection needs 30 simultaneous in-flight exports,
 * and a real timeout needs a stalled socket held for `collector.timeout`.
 * The wiring from a real exporter to this code is covered separately by
 * collector-export-failure.test.ts.
 *
 * MUTATION: replace `exportHint(endpoint, detail)` in
 * `reportExportFailure` with the old unconditional
 * `Check collector.endpoint (…) reachability, auth, and protocol.` — the
 * concurrency and timeout cases below go red, and the connect-error case
 * stays green (it is the one the old hint happened to be right about).
 */

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';

import { instrumentExporter } from '../scripts/lib/exporter-diagnostics.js';
import {
  _setDiagnosticsAuditPathForTests,
  _setDiagnosticsThrottleForTests,
} from '../adapters/diagnostics.js';
import { trackTempDir } from './helpers/tmp-dirs.js';

const ENDPOINT = 'http://collector.internal:4318';

let auditDir: string;
let auditPath: string;

before(() => {
  auditDir = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-export-hint-')));
  auditPath = join(auditDir, 'audit.jsonl');
  _setDiagnosticsAuditPathForTests(auditPath);
});

after(() => {
  _setDiagnosticsAuditPathForTests(null);
  try { rmSync(auditDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

beforeEach(() => {
  writeFileSync(auditPath, '');
  // Each case emits a distinct diagnostic, but they share a `message`, so
  // clear the stderr windows to keep one case from suppressing another's
  // audit-side sibling. (The audit leg is never throttled; this only
  // keeps the run's stderr honest.)
  _setDiagnosticsThrottleForTests({});
});

afterEach(() => {
  _setDiagnosticsThrottleForTests({});
});

/** The single `otlp_export_failed` entry this case produced. */
function reported(): { detail?: string; hint?: string } {
  if (!existsSync(auditPath)) return {};
  const entries = readFileSync(auditPath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e.kind === 'otlp_export_failed');
  assert.equal(entries.length, 1, `expected exactly one export failure, got ${entries.length}`);
  return entries[0] as { detail?: string; hint?: string };
}

/** Run one failed export through the instrumented wrapper. */
function failWith(message: string): { detail?: string; hint?: string } {
  const exporter = {
    export(_items: unknown, resultCallback: (result: ExportResult) => void): void {
      resultCallback({ code: ExportResultCode.FAILED, error: new Error(message) });
    },
  };
  instrumentExporter(exporter, 'metrics', ENDPOINT);
  exporter.export([], () => { /* the wrapper reports; the caller ignores */ });
  return reported();
}

describe('otlp_export_failed hints match the failure', () => {
  it('does not blame the endpoint when the exporter refused to send', () => {
    const entry = failWith('Concurrent export limit reached');

    assert.match(
      entry.hint ?? '', /in-flight limit \(30\) was full/,
      'the hint must name the exporter\'s own queue as the cause',
    );
    assert.match(
      entry.hint ?? '', /nothing reached the network/,
      'and must say the request was never sent',
    );
    assert.doesNotMatch(
      entry.hint ?? '', /reachability/,
      'sending the user to check a collector that was never contacted is the defect',
    );
    assert.equal(entry.detail, 'Concurrent export limit reached');
  });

  it('points a timeout at collector.timeout, not at reachability', () => {
    const entry = failWith('Request timed out');

    assert.match(entry.hint ?? '', /collector\.timeout/);
    assert.match(
      entry.hint ?? '', /sent but not answered/,
      'a timeout means the endpoint WAS reached — it just did not answer in time',
    );
    assert.doesNotMatch(entry.hint ?? '', /reachability/);
  });

  it('still blames reachability for a genuine connect failure', () => {
    // The control. Without it, a hint that said "check collector.timeout"
    // for everything would pass the two cases above.
    const entry = failWith('connect ECONNREFUSED 127.0.0.1:4318');

    assert.match(entry.hint ?? '', /reachability, auth, and protocol/);
    assert.match(entry.hint ?? '', /collector\.internal:4318/, 'and names the configured endpoint');
  });
});
