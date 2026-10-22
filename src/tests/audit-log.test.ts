// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { writeAuditLog, resolveAuditPath } from '../adapters/common.js';
import { guardAuditFixture } from './helpers/guard-audit.js';
import type { AuditHookEntry, AuditGuardEntry } from '../adapters/audit-types.js';
import type { CollectorLogsConfig } from '../adapters/config-schema.js';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'nio-audit-log-'));
}

function readEntries(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const sampleHookEntry = (): AuditHookEntry => ({
  event: 'PreToolUse',
  timestamp: '2026-04-29T12:00:00.000Z',
  platform: 'claude-code',
  session_id: 'test-session',
  tool_name: 'Bash',
  tool_summary: 'ls /tmp',
});

const sampleGuardEntry = guardAuditFixture;

// ── resolveAuditPath ────────────────────────────────────────────────────

describe('resolveAuditPath', () => {
  it('returns logsConfig.path verbatim when absolute', () => {
    const cfg: CollectorLogsConfig = { path: '/tmp/x/audit.jsonl' };
    assert.equal(resolveAuditPath(cfg), '/tmp/x/audit.jsonl');
  });

  it('expands ~/ to homedir', () => {
    const cfg: CollectorLogsConfig = { path: '~/.custom/audit.jsonl' };
    assert.equal(resolveAuditPath(cfg), join(homedir(), '.custom/audit.jsonl'));
  });

  it('falls back to NIO_HOME default when logsConfig is undefined', () => {
    const resolved = resolveAuditPath(undefined);
    // Default points inside whichever home dir is active in this process
    // (NIO_HOME if set, else homedir/.nio); just assert the basename.
    assert.ok(resolved.endsWith('/audit.jsonl'), `expected default path, got ${resolved}`);
  });

  it('falls back to default when logsConfig.path is missing', () => {
    const cfg: CollectorLogsConfig = { enabled: true, local: true };
    const resolved = resolveAuditPath(cfg);
    assert.ok(resolved.endsWith('/audit.jsonl'));
  });
});

// ── writeAuditLog: local JSONL ──────────────────────────────────────────

describe('writeAuditLog: local JSONL', () => {
  it('writes a hook entry to logsConfig.path', () => {
    const dir = freshDir();
    const path = join(dir, 'audit.jsonl');
    writeAuditLog(sampleHookEntry(), { logsConfig: { path } });
    const entries = readEntries(path);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!['event'], 'PreToolUse');
    assert.equal(entries[0]!['tool_name'], 'Bash');
  });

  it('writes a guard entry to logsConfig.path', () => {
    const dir = freshDir();
    const path = join(dir, 'audit.jsonl');
    writeAuditLog(sampleGuardEntry(), { logsConfig: { path } });
    const entries = readEntries(path);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!['event'], 'guard');
  });

  it('creates parent directory if missing', () => {
    const dir = freshDir();
    const path = join(dir, 'a', 'b', 'c', 'audit.jsonl');
    writeAuditLog(sampleHookEntry(), { logsConfig: { path } });
    assert.ok(existsSync(path));
  });

  it('does not write when logsConfig.local === false', () => {
    const dir = freshDir();
    const path = join(dir, 'audit.jsonl');
    writeAuditLog(sampleHookEntry(), { logsConfig: { path, local: false } });
    assert.equal(existsSync(path), false);
  });

  it('appends without truncating prior entries', () => {
    const dir = freshDir();
    const path = join(dir, 'audit.jsonl');
    writeAuditLog(sampleHookEntry(), { logsConfig: { path } });
    writeAuditLog({ ...sampleHookEntry(), event: 'PostToolUse' }, { logsConfig: { path } });
    const entries = readEntries(path);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]!['event'], 'PreToolUse');
    assert.equal(entries[1]!['event'], 'PostToolUse');
  });
});

// ── writeAuditLog: rotation ─────────────────────────────────────────────

describe('writeAuditLog: rotation', () => {
  it('rotates the file once it exceeds max_size_mb threshold', () => {
    const dir = freshDir();
    const path = join(dir, 'audit.jsonl');
    // Pre-populate the audit file to exceed 1 MB so rotation triggers on
    // the next write.
    writeFileSync(path, 'x'.repeat(2 * 1024 * 1024));
    writeAuditLog(sampleHookEntry(), {
      logsConfig: { path, max_size_mb: 1 },
    });
    assert.ok(existsSync(path + '.1'), 'rotated archive should exist');
    // The new file gets the latest entry only.
    const entries = readEntries(path);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!['event'], 'PreToolUse');
  });

  it('does not rotate when below threshold', () => {
    const dir = freshDir();
    const path = join(dir, 'audit.jsonl');
    writeAuditLog(sampleHookEntry(), {
      logsConfig: { path, max_size_mb: 100 },
    });
    assert.equal(existsSync(path + '.1'), false);
  });
});

// ── writeAuditLog: OTEL emission ────────────────────────────────────────

describe('writeAuditLog: OTEL emit', () => {
  it('skips OTEL emit when logsConfig.enabled === false', async () => {
    const { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } = await import('@opentelemetry/sdk-logs');
    const path = join(freshDir(), 'audit.jsonl');
    const exporter = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor(exporter)] });
    try {
      writeAuditLog(sampleHookEntry(), {
        logsConfig: { path, enabled: false, local: true }, loggerProvider: provider,
      });
      await provider.forceFlush();
      assert.equal(readEntries(path).length, 1);
      assert.equal(exporter.getFinishedLogRecords().length, 0);
    } finally { await provider.shutdown(); }
  });

  it('skips OTEL emit when loggerProvider is null', () => {
    const dir = freshDir();
    const path = join(dir, 'audit.jsonl');
    writeAuditLog(sampleHookEntry(), {
      logsConfig: { path, enabled: true, local: true },
      loggerProvider: null,
    });
    // Local write succeeds; OTEL silently no-ops.
    const entries = readEntries(path);
    assert.equal(entries.length, 1);
  });
});

describe('canonical Guard write boundary', () => {
  for (const missing of ['evaluation_id', 'phases'] as const) {
    it(`rejects Guard missing ${missing} before either destination and diagnoses it`, async () => {
      const { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } = await import('@opentelemetry/sdk-logs');
      const { _setDiagnosticsAuditPathForTests } = await import('../adapters/diagnostics.js');
      const { guardAuditFixture } = await import('./helpers/guard-audit.js');
      const dir = freshDir();
      const path = join(dir, 'audit.jsonl');
      const diagnostics = join(dir, 'diagnostics.jsonl');
      const exporter = new InMemoryLogRecordExporter();
      const provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor(exporter)] });
      const malformed: Record<string, unknown> = { ...guardAuditFixture() };
      delete malformed[missing];
      _setDiagnosticsAuditPathForTests(diagnostics);
      try {
        writeAuditLog(malformed as unknown as AuditGuardEntry, { loggerProvider: provider, logsConfig: { path } });
        await provider.forceFlush();
        assert.equal(readEntries(path).length, 0);
        assert.equal(exporter.getFinishedLogRecords().length, 0);
        assert.equal(readEntries(diagnostics)[0]?.kind, 'guard_audit_invalid');
      } finally {
        _setDiagnosticsAuditPathForTests(null);
        await provider.shutdown();
      }
    });
  }
  it('dual-writes valid Guard and non-Guard entries without changing their event identities', async () => {
    const { InMemoryLogRecordExporter, LoggerProvider, SimpleLogRecordProcessor } = await import('@opentelemetry/sdk-logs');
    const { guardAuditFixture } = await import('./helpers/guard-audit.js');
    const dir = freshDir();
    const path = join(dir, 'audit.jsonl');
    const exporter = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor(exporter)] });
    try {
      const expected = [guardAuditFixture(), sampleHookEntry()];
      for (const entry of expected) writeAuditLog(entry, { loggerProvider: provider, logsConfig: { path } });
      await provider.forceFlush();
      assert.deepEqual(readEntries(path), expected);
      assert.deepEqual(exporter.getFinishedLogRecords().map(record => JSON.parse(String(record.body))), expected);
    } finally { await provider.shutdown(); }
  });
});
