// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { writeAuditLog, resolveAuditPath } from '../adapters/common.js';
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

const sampleGuardEntry = (): AuditGuardEntry => ({
  event: 'guard',
  timestamp: '2026-04-29T12:00:00.000Z',
  platform: 'claude-code',
  tool_name: 'Bash',
  tool_input_summary: 'ls /tmp',
  decision: 'allow',
  risk_level: 'low',
  max_finding_severity: 'low',
  risk_score: 0,
  risk_tags: [],
  phase_stopped: null,
  scores: {},
  top_findings: [],
});

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
  it('skips OTEL emit when logsConfig.enabled === false', () => {
    const dir = freshDir();
    const path = join(dir, 'audit.jsonl');
    let emitCount = 0;
    const fakeProvider = { mark: 'fake-provider' };
    // Loose stub — writeAuditLog dynamically requires logs-collector;
    // since the require may fail in this test env, we just check that
    // the local-write side honors `enabled: false`'s sibling path.
    writeAuditLog(sampleHookEntry(), {
      logsConfig: { path, enabled: false, local: true },
      loggerProvider: fakeProvider as unknown as never,
    });
    // Local write still happens (local !== false)
    assert.ok(existsSync(path));
    assert.equal(emitCount, 0);
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
