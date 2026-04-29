// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  dispatchCollectorEvent,
  toolSummary,
  spanKey,
  type HookStdinPayload,
} from '../scripts/lib/collector-core.js';
import type { ResolvedMetricsConfig, CollectorLogsConfig } from '../adapters/common.js';

// Each test gets its own tmpdir + audit file; we never delete — OS reaps
// /tmp. Keeps the test file free of fs-destructive calls that Nio's own
// Phase 4 behavioural analyser would (correctly) flag.

function freshFixture(): { auditPath: string; logsConfig: CollectorLogsConfig } {
  const dir = mkdtempSync(join(tmpdir(), 'nio-collector-core-'));
  const auditPath = join(dir, 'audit.jsonl');
  return {
    auditPath,
    logsConfig: { enabled: true, local: true, path: auditPath, max_size_mb: 100 },
  };
}

const baseConfig: ResolvedMetricsConfig = {
  endpoint: '',
  api_key: '',
  timeout: 5000,
  protocol: 'http',
  enabled: true,
};

function readEntries(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ── toolSummary — cross-platform tool-name recognition ────────────────

describe('collector-core: toolSummary', () => {
  it('extracts command for Claude Code Bash', () => {
    assert.equal(toolSummary('Bash', { command: 'ls /tmp' }), 'ls /tmp');
  });

  it('extracts file_path for Claude Code Write / Edit', () => {
    assert.equal(toolSummary('Write', { file_path: '/x.js' }), '/x.js');
    assert.equal(toolSummary('Edit', { path: '/y.js' }), '/y.js');
  });

  it('extracts url for Claude Code WebFetch / WebSearch', () => {
    assert.equal(toolSummary('WebFetch', { url: 'https://example.com' }), 'https://example.com');
    assert.equal(toolSummary('WebSearch', { query: 'nio' }), 'nio');
  });

  it('extracts command for Hermes terminal / exec / shell', () => {
    assert.equal(toolSummary('terminal', { command: 'ls' }), 'ls');
    assert.equal(toolSummary('exec', { command: 'ls' }), 'ls');
    assert.equal(toolSummary('shell', { command: 'ls' }), 'ls');
  });

  it('extracts path for Hermes write_file / patch / read_file', () => {
    assert.equal(toolSummary('write_file', { path: '/x.py' }), '/x.py');
    assert.equal(toolSummary('patch', { file_path: '/y.py' }), '/y.py');
    assert.equal(toolSummary('read_file', { path: '/z.py' }), '/z.py');
  });

  it('extracts url for Hermes fetch / http_request', () => {
    assert.equal(toolSummary('fetch', { url: 'https://api.example.com' }), 'https://api.example.com');
  });

  it('falls back to JSON for unknown tools', () => {
    const s = toolSummary('mystery_tool', { foo: 'bar', n: 1 });
    assert.ok(s.includes('foo') && s.includes('bar'));
  });

  it('truncates long summaries to 300 chars', () => {
    const long = 'x'.repeat(500);
    assert.equal(toolSummary('Bash', { command: long }).length, 300);
  });
});

// ── spanKey ────────────────────────────────────────────────────────────

describe('collector-core: spanKey', () => {
  it('prefers tool_use_id when provided', () => {
    const key = spanKey({ tool_use_id: 'tc-123', tool_name: 'Bash' } as HookStdinPayload);
    assert.equal(key, 'tc-123');
  });

  it('falls back to tool_name:timestamp when tool_use_id absent', () => {
    const k1 = spanKey({ tool_name: 'Bash' } as HookStdinPayload);
    assert.ok(k1.startsWith('Bash:'));
  });

  it('handles fully empty input', () => {
    const k = spanKey({} as HookStdinPayload);
    assert.ok(k.startsWith('unknown:'));
  });
});

// ── dispatchCollectorEvent — audit routing (no OTLP) ───────────────────

describe('collector-core: dispatchCollectorEvent → audit.jsonl', () => {
  it('writes a PreToolUse audit entry tagged with platform', async () => {
    const { auditPath, logsConfig } = freshFixture();
    await dispatchCollectorEvent({
      event: 'PreToolUse',
      input: {
        tool_name: 'terminal',
        tool_input: { command: 'ls' },
        session_id: 'sess-a',
        tool_use_id: 'call-1',
        cwd: '/tmp',
      },
      platform: 'hermes',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: null,
      logsConfig,
    });
    const entries = readEntries(auditPath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!['platform'], 'hermes');
    assert.equal(entries[0]!['event'], 'PreToolUse');
    assert.equal(entries[0]!['tool_name'], 'terminal');
    assert.equal(entries[0]!['tool_summary'], 'ls');
    assert.equal(entries[0]!['session_id'], 'sess-a');
    assert.equal(entries[0]!['tool_use_id'], 'call-1');
  });

  it('writes a PostToolUse audit entry', async () => {
    const { auditPath, logsConfig } = freshFixture();
    await dispatchCollectorEvent({
      event: 'PostToolUse',
      input: {
        tool_name: 'terminal',
        tool_input: { command: 'ls' },
        session_id: 'sess-a',
        tool_use_id: 'call-1',
        tool_response: { output: 'ok' },
      },
      platform: 'hermes',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: null,
      logsConfig,
    });
    const entries = readEntries(auditPath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!['event'], 'PostToolUse');
  });

  it('writes a TaskCreated audit entry with task_id and task_summary', async () => {
    const { auditPath, logsConfig } = freshFixture();
    await dispatchCollectorEvent({
      event: 'TaskCreated',
      input: {
        session_id: 'sess-a',
        task_id: 'task-1',
        task_input: { prompt: 'do a thing' },
      },
      platform: 'claude-code',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: null,
      logsConfig,
    });
    const entries = readEntries(auditPath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!['event'], 'TaskCreated');
    assert.equal(entries[0]!['task_id'], 'task-1');
    assert.equal(entries[0]!['task_summary'], 'do a thing');
  });

  it('writes a TaskCompleted audit entry with task_id', async () => {
    const { auditPath, logsConfig } = freshFixture();
    await dispatchCollectorEvent({
      event: 'TaskCompleted',
      input: { session_id: 'sess-a', task_id: 'task-1' },
      platform: 'claude-code',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: null,
      logsConfig,
    });
    const entries = readEntries(auditPath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!['event'], 'TaskCompleted');
    assert.equal(entries[0]!['task_id'], 'task-1');
  });

  it('writes a Stop audit entry with session_id', async () => {
    const { auditPath, logsConfig } = freshFixture();
    await dispatchCollectorEvent({
      event: 'Stop',
      input: { session_id: 'sess-stop', cwd: '/tmp' },
      platform: 'hermes',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: null,
      logsConfig,
    });
    const entries = readEntries(auditPath);
    assert.equal(entries[0]!['event'], 'Stop');
    assert.equal(entries[0]!['session_id'], 'sess-stop');
    assert.equal(entries[0]!['platform'], 'hermes');
  });

  it('SessionEnd is accepted as a canonical event (Hermes-driven)', async () => {
    const { auditPath, logsConfig } = freshFixture();
    await dispatchCollectorEvent({
      event: 'SessionEnd',
      input: { session_id: 'sess-end' },
      platform: 'hermes',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: null,
      logsConfig,
    });
    const entries = readEntries(auditPath);
    assert.equal(entries[0]!['event'], 'SessionEnd');
  });

  it('SessionStart is accepted as a canonical event', async () => {
    const { auditPath, logsConfig } = freshFixture();
    await dispatchCollectorEvent({
      event: 'SessionStart',
      input: { session_id: 'sess-start' },
      platform: 'claude-code',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: null,
      logsConfig,
    });
    const entries = readEntries(auditPath);
    assert.equal(entries[0]!['event'], 'SessionStart');
  });

  it('silently ignores unknown event names (forward-compat)', async () => {
    const { auditPath, logsConfig } = freshFixture();
    await dispatchCollectorEvent({
      event: 'HypotheticalFutureEvent',
      input: { session_id: 'sess-x' },
      platform: 'hermes',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: null,
      logsConfig,
    });
    const entries = readEntries(auditPath);
    assert.equal(entries.length, 0, 'unknown event must not be persisted');
  });

  it('never throws on malformed input', async () => {
    const { auditPath, logsConfig } = freshFixture();
    await dispatchCollectorEvent({
      event: 'PreToolUse',
      input: {} as HookStdinPayload,
      platform: 'hermes',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: null,
      logsConfig,
    });
    const entries = readEntries(auditPath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!['session_id'], 'unknown');
  });

  it('does not create a sibling metrics.jsonl (regression: writeToLog removed)', async () => {
    const { auditPath, logsConfig } = freshFixture();
    const legacyMetrics = join(dirname(auditPath), 'metrics.jsonl');
    await dispatchCollectorEvent({
      event: 'PreToolUse',
      input: { tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 's1' },
      platform: 'claude-code',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: null,
      logsConfig,
    });
    assert.equal(existsSync(legacyMetrics), false,
      'hook events must not flow into the misnamed metrics.jsonl any more');
    assert.ok(existsSync(auditPath));
  });
});
