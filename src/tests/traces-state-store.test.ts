// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  statePath,
  loadState,
  saveState,
  type CollectorState,
  type DeferredSpan,
} from '../scripts/lib/traces-state-store.js';
import type { CollectorLogsConfig } from '../adapters/config-schema.js';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'nio-collector-state-'));
}

const sample = (overrides: Partial<CollectorState> = {}): CollectorState => ({
  session_id: 'sess-1',
  turn_number: 3,
  turn_trace_id: 'a'.repeat(32),
  turn_start_ms: 1700000000000,
  pending_spans: {
    toolu_x: {
      tool_name: 'Bash',
      tool_summary: 'ls /tmp',
      start_ms: 1700000001000,
      span_id: 'b'.repeat(16),
    },
  },
  pending_task_spans: {
    'task-1': {
      task_summary: 'do thing',
      start_ms: 1700000002000,
      span_id: 'c'.repeat(16),
    },
  },
  turn_attributes: { 'nio.turn.user_prompt': 'hello' },
  ...overrides,
});

// ── statePath ─────────────────────────────────────────────────────────

describe('statePath', () => {
  it('derives state file from dirname(logsConfig.path)', () => {
    const cfg: CollectorLogsConfig = { path: '/tmp/x/audit.jsonl' };
    assert.equal(statePath(cfg), '/tmp/x/traces-state-store.json');
  });

  it('expands ~/ in logsConfig.path before deriving', () => {
    const cfg: CollectorLogsConfig = { path: '~/.custom/audit.jsonl' };
    assert.equal(statePath(cfg), join(homedir(), '.custom', 'traces-state-store.json'));
  });

  it('falls back to NIO_HOME default when no logsConfig', () => {
    const resolved = statePath(undefined);
    assert.ok(resolved.endsWith('/traces-state-store.json'),
      `expected default state path, got ${resolved}`);
  });

  it('falls back to default when logsConfig has no path', () => {
    const cfg: CollectorLogsConfig = { enabled: true, local: true };
    const resolved = statePath(cfg);
    assert.ok(resolved.endsWith('/traces-state-store.json'));
  });

  it('places state file next to audit log when both customised', () => {
    const dir = freshDir();
    const cfg: CollectorLogsConfig = { path: join(dir, 'sub', 'audit.jsonl') };
    assert.equal(dirname(statePath(cfg)), join(dir, 'sub'));
  });
});

// ── loadState ─────────────────────────────────────────────────────────

describe('loadState', () => {
  it('returns null when the file is missing', () => {
    const dir = freshDir();
    const cfg: CollectorLogsConfig = { path: join(dir, 'audit.jsonl') };
    assert.equal(loadState(cfg), null);
  });

  it('returns null on JSON parse error (does not throw)', () => {
    const dir = freshDir();
    const cfg: CollectorLogsConfig = { path: join(dir, 'audit.jsonl') };
    writeFileSync(statePath(cfg), 'not-json{');
    assert.equal(loadState(cfg), null);
  });
});

// ── saveState + loadState round-trip ──────────────────────────────────

describe('saveState ↔ loadState', () => {
  it('round-trips a full CollectorState verbatim', () => {
    const dir = freshDir();
    const cfg: CollectorLogsConfig = { path: join(dir, 'audit.jsonl') };
    const state = sample();
    saveState(cfg, state);
    const loaded = loadState(cfg);
    assert.deepEqual(loaded, state);
  });

  it('saveState creates parent directory if missing', () => {
    const dir = freshDir();
    const cfg: CollectorLogsConfig = { path: join(dir, 'a', 'b', 'c', 'audit.jsonl') };
    saveState(cfg, sample());
    assert.ok(existsSync(statePath(cfg)));
  });

  it('latest write wins (serial saves both observable via load)', () => {
    const dir = freshDir();
    const cfg: CollectorLogsConfig = { path: join(dir, 'audit.jsonl') };

    saveState(cfg, sample({ turn_number: 1 }));
    assert.equal(loadState(cfg)!.turn_number, 1);

    saveState(cfg, sample({ turn_number: 2 }));
    assert.equal(loadState(cfg)!.turn_number, 2);
  });
});

// ── deferred spans + session trace fields ──────────────────────────────

describe('saveState ↔ loadState — deferred spans and session trace', () => {
  const deferredSpan = (overrides: Partial<DeferredSpan> = {}): DeferredSpan => ({
    kind: 'tool',
    name: 'Bash',
    span_id: 'd'.repeat(16),
    start_ms: 1700000003000,
    end_ms: 1700000003500,
    attributes: { 'nio.tool.name': 'Bash' },
    ...overrides,
  });

  it('round-trips a state with populated deferred_spans', () => {
    const dir = freshDir();
    const cfg: CollectorLogsConfig = { path: join(dir, 'audit.jsonl') };
    const state = sample({
      deferred_spans: [
        deferredSpan(),
        deferredSpan({ kind: 'task', name: 'subagent', tool_use_id: 'toolu_x', error: 'boom' }),
      ],
    });

    saveState(cfg, state);
    const loaded = loadState(cfg);

    assert.deepEqual(loaded, state);
  });

  it('round-trips a state with session_trace_id / session_span_id / session_start_ms', () => {
    const dir = freshDir();
    const cfg: CollectorLogsConfig = { path: join(dir, 'audit.jsonl') };
    const state = sample({
      session_trace_id: 'e'.repeat(32),
      session_span_id: 'f'.repeat(16),
      session_start_ms: 1700000000500,
    });

    saveState(cfg, state);
    const loaded = loadState(cfg);

    assert.deepEqual(loaded, state);
  });

  it('loads an old-format state (no new fields) without throwing, leaving new fields undefined', () => {
    const dir = freshDir();
    const cfg: CollectorLogsConfig = { path: join(dir, 'audit.jsonl') };
    // Simulate a pre-upgrade on-disk file: write only the legacy shape,
    // bypassing saveState/CollectorState entirely.
    const legacy = {
      session_id: 'sess-legacy',
      turn_number: 1,
      turn_trace_id: 'a'.repeat(32),
      turn_start_ms: 1700000000000,
      pending_spans: {},
      pending_task_spans: {},
    };
    writeFileSync(statePath(cfg), JSON.stringify(legacy, null, 2), 'utf-8');

    const loaded = loadState(cfg);

    assert.ok(loaded);
    assert.equal(loaded!.session_id, 'sess-legacy');
    assert.equal(loaded!.deferred_spans, undefined);
    assert.equal(loaded!.session_trace_id, undefined);
    assert.equal(loaded!.session_span_id, undefined);
    assert.equal(loaded!.session_start_ms, undefined);
  });

  it('distinguishes deferred_spans as an empty array from deferred_spans left undefined', () => {
    const dir = freshDir();
    const cfg: CollectorLogsConfig = { path: join(dir, 'audit.jsonl') };

    const emptyState = sample({ deferred_spans: [] });
    saveState(cfg, emptyState);
    const loadedEmpty = loadState(cfg);
    assert.deepEqual(loadedEmpty!.deferred_spans, []);
    assert.notEqual(loadedEmpty!.deferred_spans, undefined);

    const undefinedState = sample();
    delete undefinedState.deferred_spans;
    saveState(cfg, undefinedState);
    const loadedUndefined = loadState(cfg);
    assert.equal(loadedUndefined!.deferred_spans, undefined);
  });
});
