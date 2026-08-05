// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveMonitorStore, loadMonitorStore } from '../scripts/lib/monitor-store.js';
import { _setDiagnosticsAuditPathForTests } from '../adapters/diagnostics.js';
import type { CollectorLogsConfig } from '../adapters/config-schema.js';

function freshDir(): { dir: string; logsConfig: CollectorLogsConfig } {
  const dir = mkdtempSync(join(tmpdir(), 'nio-store-dur-'));
  return { dir, logsConfig: { path: join(dir, 'audit.jsonl') } as CollectorLogsConfig };
}

/**
 * The corruption diagnostic is fired via a non-awaited dynamic import (it
 * must not turn loadMonitorStore's hot-path return async), so it lands on
 * the audit log some microtasks/ticks later. Poll instead of a fixed
 * sleep — fast on the happy path, bounded on failure.
 */
async function pollForAuditEntry(auditPath: string, kind: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(auditPath)) {
      const content = readFileSync(auditPath, 'utf-8');
      if (content.includes(`"kind":"${kind}"`)) return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

describe('saveMonitorStore atomicity', () => {
  it('leaves no temp file behind on success', () => {
    const { dir, logsConfig } = freshDir();
    saveMonitorStore(logsConfig, { sessions: { s1: { armed_at: 1, cwd: '/w' } } });
    const stray = readdirSync(dir).filter(f => f !== 'monitored-sessions.json');
    assert.deepEqual(stray, [], `unexpected leftovers: ${stray.join(',')}`);
  });

  it('never leaves a partially written store readable', () => {
    // A reader must see either the old content or the new one, never a
    // truncated file. Writing via temp+rename is what guarantees this.
    const { dir, logsConfig } = freshDir();
    saveMonitorStore(logsConfig, { sessions: { old: { armed_at: 1, cwd: '/w' } } });
    saveMonitorStore(logsConfig, { sessions: { neu: { armed_at: 2, cwd: '/w' } } });
    const loaded = loadMonitorStore(logsConfig);
    assert.equal('neu' in loaded.sessions, true);
    assert.equal('old' in loaded.sessions, false);
  });

  it('leaves no .tmp- residue when the rename step fails', () => {
    // Serial tests can't distinguish "completed atomic write" from
    // "completed truncating write" — both converge on the same final
    // file. What they CAN observe is a failure path where a tmp file
    // was genuinely created and then had to be cleaned up.
    //
    // A read-only target directory (the obvious first attempt) does NOT
    // work for this: writeFileSync(tmp, …) fails at file-*creation*
    // time, before any tmp file exists, so there is nothing for
    // unlinkSync to remove either way — verified by hand, this makes
    // that scenario unable to discriminate the mutation below regardless
    // of platform. Instead, pre-create the store's target path *as a
    // directory*: the tmp write still succeeds (the parent dir is
    // writable), but renameSync(tmp, path) then fails with EISDIR/
    // ENOTEMPTY — after the tmp file is already on disk — which is
    // exactly the failure shape unlinkSync exists to clean up after.
    const { dir, logsConfig } = freshDir();
    mkdirSync(join(dir, 'monitored-sessions.json'));

    assert.throws(() => saveMonitorStore(logsConfig, { sessions: { s1: { armed_at: 1, cwd: '/w' } } }));

    const stray = readdirSync(dir).filter(f => f.includes('.tmp-'));
    assert.deepEqual(stray, [], `unexpected temp residue after failed rename: ${stray.join(',')}`);
  });
});

describe('loadMonitorStore corruption reporting', () => {
  it('still returns an empty store on corrupt JSON', async () => {
    // Isolate + drain this test's own (fire-and-forget, unawaited) corrupt-
    // JSON diagnostic before returning. loadMonitorStore's diagnostic write
    // happens via a delayed dynamic import (see pollForAuditEntry's doc
    // comment) — without draining it here, the write can land AFTER this
    // test has finished, racing against whatever the NEXT test sets
    // `_setDiagnosticsAuditPathForTests` to, and landing in that test's
    // audit file instead of this one's. That exact leak previously produced
    // a false positive in "does not report a diagnostic when the file is
    // simply absent" below.
    const { dir, logsConfig } = freshDir();
    const auditPath = join(dir, 'audit.jsonl');
    _setDiagnosticsAuditPathForTests(auditPath);
    try {
      writeFileSync(join(dir, 'monitored-sessions.json'), '{not json', 'utf-8');
      assert.deepEqual(loadMonitorStore(logsConfig), { sessions: {} });
      await pollForAuditEntry(auditPath, 'monitor_store_corrupt', 2000);
    } finally {
      _setDiagnosticsAuditPathForTests(null);
    }
  });

  it('does not report a diagnostic when the file is simply absent', async () => {
    // Diagnostics are redirected to a temp path here (mirroring the
    // positive-case test below) precisely BECAUSE the assertion needs to be
    // meaningful: loadMonitorStore never writes to logsConfig's directory at
    // all, so asserting against `join(dir, 'audit.jsonl')` would pass
    // whether or not the missing-file branch reports — it's asserting
    // against a path diagnostics never targets in the first place. With the
    // redirect in place, this test actually exercises the "did NOT call
    // reportDiagnostic" path — see review I2.
    const { dir, logsConfig } = freshDir();
    const auditPath = join(dir, 'audit.jsonl');
    _setDiagnosticsAuditPathForTests(auditPath);
    try {
      const result = loadMonitorStore(logsConfig);
      assert.deepEqual(result, { sessions: {} });

      const found = await pollForAuditEntry(auditPath, 'monitor_store_corrupt', 300);
      assert.equal(found, false,
        'a missing store is normal — this must NOT report monitor_store_corrupt (that would spam every never-armed session)');
    } finally {
      _setDiagnosticsAuditPathForTests(null);
    }
  });

  it('reports a monitor_store_corrupt diagnostic when the file exists but fails to parse', async () => {
    const { dir, logsConfig } = freshDir();
    const auditPath = join(dir, 'audit.jsonl');
    _setDiagnosticsAuditPathForTests(auditPath);
    try {
      writeFileSync(join(dir, 'monitored-sessions.json'), '{not json', 'utf-8');

      const result = loadMonitorStore(logsConfig);
      assert.deepEqual(result, { sessions: {} }, 'existing safe-fallback behavior must be unchanged');

      const found = await pollForAuditEntry(auditPath, 'monitor_store_corrupt', 2000);
      assert.equal(found, true, 'expected a monitor_store_corrupt diagnostic in the audit log within 2s');
    } finally {
      _setDiagnosticsAuditPathForTests(null);
    }
  });
});
