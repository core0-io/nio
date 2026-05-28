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
  metrics_enabled: true,
  traces_enabled: true,
  logs_enabled: true,
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

  it('falls back to tool_name:tool_summary when tool_use_id absent', () => {
    const k = spanKey({ tool_name: 'Bash', tool_input: { command: 'ls /tmp' } } as HookStdinPayload);
    assert.equal(k, 'Bash:ls /tmp');
  });

  it('fallback is DETERMINISTIC — same inputs produce the same key', () => {
    // Pre/post bridge depends on this. Old impl used Date.now() so the
    // fallback diverged between pre and post invocations.
    const a = spanKey({ tool_name: 'terminal', tool_input: { command: 'date -u' } } as HookStdinPayload);
    const b = spanKey({ tool_name: 'terminal', tool_input: { command: 'date -u' } } as HookStdinPayload);
    assert.equal(a, b);
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

// ── PostToolUse drains pending_guard_attrs onto the closing span ────────

describe('collector-core: PostToolUse drains pending_guard_attrs', () => {
  it('merges guard attrs parked by the guard-hook process into the tool span', async () => {
    const { makeInMemoryTracer } = await import('./helpers/tracer.js');
    const { setPendingGuardAttrs, ensureTurn } = await import('../scripts/lib/traces-collector.js');
    const { loadState, saveState } = await import('../scripts/lib/traces-state-store.js');
    const { spanKey: spanKeyFn } = await import('../scripts/lib/collector-core.js');

    const { auditPath, logsConfig } = freshFixture();
    const tracer = makeInMemoryTracer();

    const sessionId = 'sess-guard-bridge';
    const toolUseId = 'tc-guard-1';
    const preInput: HookStdinPayload = {
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
      session_id: sessionId,
      tool_use_id: toolUseId,
      cwd: '/tmp',
    };

    // Pre: open the pending span via the real collector path.
    await dispatchCollectorEvent({
      event: 'PreToolUse',
      input: preInput,
      platform: 'claude-code',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: tracer.provider,
      logsConfig,
    });

    // Simulate the separate guard-hook process parking guard attrs.
    const key = spanKeyFn(preInput);
    let s = ensureTurn(loadState(logsConfig), sessionId);
    s = setPendingGuardAttrs(s, key, {
      'nio.guard.decision': 'allow',
      'nio.guard.risk_level': 'medium',
      'nio.guard.risk_score': 0.4,
      'nio.guard.eval_ms': 7,
    });
    saveState(logsConfig, s);

    // Post: close the span. Guard attrs should be drained + merged in.
    await dispatchCollectorEvent({
      event: 'PostToolUse',
      input: {
        ...preInput,
        tool_response: { output: 'hi' },
      },
      platform: 'claude-code',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: tracer.provider,
      logsConfig,
    });

    const spans = tracer.finished();
    assert.equal(spans.length, 1, 'exactly one tool span exported');
    const attrs = spans[0]!.attributes as Record<string, unknown>;
    assert.equal(attrs['nio.guard.decision'], 'allow');
    assert.equal(attrs['nio.guard.risk_level'], 'medium');
    assert.equal(attrs['nio.guard.risk_score'], 0.4);
    assert.equal(attrs['nio.guard.eval_ms'], 7);

    // And the state file should no longer carry the drained entry.
    const after = loadState(logsConfig);
    assert.equal(after?.pending_guard_attrs?.[key], undefined);

    // Do NOT shutdown — the global tracer is shared across tests, and
    // shutting it down here would break later tests that re-register.

    void auditPath;
  });

  it('PostToolUse falls back to composite key when pre saved without tool_use_id (Hermes asymmetry)', async () => {
    // Hermes ships `pre_tool_call` without `tool_call_id` (its
    // invoke_tool() path forgets to thread it). post_tool_call DOES
    // include the real tool_call_id. Without composite-fallback, the
    // post side computes spanKey(tool_use_id="call_xyz") and misses
    // the pre's entry under spanKey="terminal:date -u".
    const { makeInMemoryTracer } = await import('./helpers/tracer.js');
    const { auditPath, logsConfig } = freshFixture();
    const tracer = makeInMemoryTracer();

    const sessionId = 'hermes-async-sess';

    // PRE: simulate Hermes payload — has tool_name + tool_input but NO tool_use_id.
    await dispatchCollectorEvent({
      event: 'PreToolUse',
      input: {
        tool_name: 'terminal',
        tool_input: { command: 'date -u' },
        session_id: sessionId,
        // tool_use_id intentionally absent
      },
      platform: 'hermes',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: tracer.provider,
      logsConfig,
    });

    // POST: simulate Hermes post_tool_call payload — now WITH tool_use_id.
    await dispatchCollectorEvent({
      event: 'PostToolUse',
      input: {
        tool_name: 'terminal',
        tool_input: { command: 'date -u' },
        session_id: sessionId,
        tool_use_id: 'call_LLMassigned',  // present here but not in pre
        tool_response: { output: '2026-05-28T11:00:00Z' },
      },
      platform: 'hermes',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: tracer.provider,
      logsConfig,
    });

    const spans = tracer.finished();
    assert.equal(spans.length, 1, 'one execute_tool span should be emitted via composite fallback');
    assert.equal(spans[0]!.name, 'execute_tool terminal');

    void auditPath;
  });
});

// ── Deny-path one-shot emit (guard-hook / hermes hook-cli pattern) ─────

describe('deny-path one-shot span emit', () => {
  it('emits a complete tool span with ERROR status, deny attrs, guard.eval_ms, and a real start time', async () => {
    const { makeInMemoryTracer } = await import('./helpers/tracer.js');
    const {
      ensureTurn, recordPreToolUse, recordPostToolUse,
      nioGuardAttributes, genAiToolCallInputAttributes,
    } = await import('../scripts/lib/traces-collector.js');

    const tracer = makeInMemoryTracer();

    // Simulate what guard-hook does on deny: time eval, build guardAttrs,
    // open + close + flush a single span with the real eval-start time.
    const evalStartMs = Date.now() - 50;  // pretend eval took ~50 ms
    const evalMs = Date.now() - evalStartMs;
    const guardAttrs = {
      ...nioGuardAttributes('deny', 'critical', 1.0, ['BASH_RMRF'], 2, 'BASH_RMRF'),
      'nio.guard.eval_ms': evalMs,
    };

    let state = ensureTurn(null, 'sess-deny');
    const key = 'tc-deny-1';
    state = recordPreToolUse(
      state, key, 'Bash', 'rm -rf /',
      genAiToolCallInputAttributes({ command: 'rm -rf /' }, key),
      evalStartMs,
    );
    const r = await recordPostToolUse(
      tracer.provider, state, key, 'claude-code', '/tmp',
      guardAttrs,
      'Blocked by Nio: critical risk',
    );
    state = r.state;

    const spans = tracer.finished();
    assert.equal(spans.length, 1);
    const span = spans[0]!;
    assert.equal(span.name, 'execute_tool Bash');
    assert.equal(span.status.code, 2, 'span status should be ERROR (SpanStatusCode.ERROR=2)');
    assert.match(String(span.status.message), /Blocked by Nio/);

    const attrs = span.attributes as Record<string, unknown>;
    assert.equal(attrs['nio.guard.decision'], 'deny');
    assert.equal(attrs['nio.guard.risk_level'], 'critical');
    assert.equal(attrs['nio.guard.risk_score'], 1.0);
    assert.equal(attrs['nio.guard.risk_tags'], 'BASH_RMRF');
    assert.equal(attrs['nio.guard.phase_stopped'], 2);
    assert.equal(attrs['nio.guard.top_finding_rule'], 'BASH_RMRF');
    assert.ok(typeof attrs['nio.guard.eval_ms'] === 'number' && (attrs['nio.guard.eval_ms'] as number) >= 0);

    // Wall-clock should reflect the real eval window (start at evalStartMs).
    // hrTime is [sec, nanos] — convert to ms.
    const spanStartMs = span.startTime[0] * 1000 + Math.round(span.startTime[1] / 1_000_000);
    assert.ok(
      Math.abs(spanStartMs - evalStartMs) <= 5,
      `span start (${spanStartMs}) should be within ~5ms of evalStartMs (${evalStartMs})`,
    );

    // Pending entry should have been drained.
    assert.equal(state.pending_spans[key], undefined);

    // Do NOT shutdown — the global tracer is shared across tests, and
    // shutting it down here would break later tests that re-register.
  });
});
