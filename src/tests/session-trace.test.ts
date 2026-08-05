// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Task 4: sessions get their own trace, and every turn root links back
 * to it.
 *
 * Design recap (see traces-collector.ts docs on startSessionTrace /
 * emitSessionSpan / endTurn): a session is NOT a span tree wrapping
 * every turn — it's a single (trace id, span id) pair minted at
 * SessionStart, held in state, exported as its own root span at
 * SessionEnd. Every turn's root span carries a span LINK to that pair.
 * Missing session fields (platform never fires SessionStart) must
 * degrade to "turn exports with no link", never an error.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchCollectorEvent, type HookStdinPayload } from '../scripts/lib/collector-core.js';
import { loadState } from '../scripts/lib/traces-state-store.js';
import type { ResolvedMetricsConfig, CollectorLogsConfig } from '../adapters/common.js';
import { makeInMemoryTracer } from './helpers/tracer.js';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-node';

function freshFixture(): { logsConfig: CollectorLogsConfig } {
  const dir = mkdtempSync(join(tmpdir(), 'nio-session-trace-'));
  const auditPath = join(dir, 'audit.jsonl');
  return { logsConfig: { enabled: true, local: true, path: auditPath, max_size_mb: 100 } };
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

function preInput(sessionId: string, toolUseId: string): HookStdinPayload {
  return {
    tool_name: 'Bash',
    tool_input: { command: 'echo hi' },
    session_id: sessionId,
    tool_use_id: toolUseId,
    cwd: '/tmp',
  };
}

async function runOneTurn(
  sessionId: string,
  logsConfig: CollectorLogsConfig,
  tracerProvider: unknown,
): Promise<void> {
  await dispatchCollectorEvent({
    event: 'PreToolUse', input: preInput(sessionId, 'tc-1'), platform: 'claude-code',
    config: baseConfig, meterProvider: null, tracerProvider: tracerProvider as never, logsConfig,
  });
  await dispatchCollectorEvent({
    event: 'PostToolUse',
    input: { ...preInput(sessionId, 'tc-1'), tool_response: { output: 'hi' } },
    platform: 'claude-code',
    config: baseConfig, meterProvider: null, tracerProvider: tracerProvider as never, logsConfig,
  });
  await dispatchCollectorEvent({
    event: 'Stop', input: { session_id: sessionId, cwd: '/tmp' }, platform: 'claude-code',
    config: baseConfig, meterProvider: null, tracerProvider: tracerProvider as never, logsConfig,
  });
}

function turnRoot(spans: readonly ReadableSpan[]): ReadableSpan | undefined {
  return spans.find((s) => s.name === 'invoke_agent UserPromptSubmit');
}

// ── SessionStart mints the three session fields ────────────────────────

describe('session-trace: SessionStart mints session_trace_id/session_span_id/session_start_ms', () => {
  it('persists a 32-hex trace id and a 16-hex span id onto state', async () => {
    const { logsConfig } = freshFixture();
    const tracer = makeInMemoryTracer();
    const sessionId = 'sess-mint-1';

    await dispatchCollectorEvent({
      event: 'SessionStart', input: { session_id: sessionId }, platform: 'claude-code',
      config: baseConfig, meterProvider: null, tracerProvider: tracer.provider, logsConfig,
    });

    const state = loadState(logsConfig);
    assert.ok(state, 'state file should exist after SessionStart');
    assert.match(state!.session_trace_id ?? '', /^[0-9a-f]{32}$/, 'session_trace_id must be 32 hex chars');
    assert.match(state!.session_span_id ?? '', /^[0-9a-f]{16}$/, 'session_span_id must be 16 hex chars');
    assert.equal(typeof state!.session_start_ms, 'number');
  });
});

// ── Turn root carries a span link to the session ────────────────────────

describe('session-trace: turn root links to the session span', () => {
  it('the root span of a turn started after SessionStart carries a link to (session_trace_id, session_span_id)', async () => {
    const { logsConfig } = freshFixture();
    const tracer = makeInMemoryTracer();
    const sessionId = 'sess-link-1';

    await dispatchCollectorEvent({
      event: 'SessionStart', input: { session_id: sessionId }, platform: 'claude-code',
      config: baseConfig, meterProvider: null, tracerProvider: tracer.provider, logsConfig,
    });
    const afterStart = loadState(logsConfig);
    assert.ok(afterStart?.session_trace_id && afterStart?.session_span_id);

    await runOneTurn(sessionId, logsConfig, tracer.provider);

    const root = turnRoot(tracer.finished());
    assert.ok(root, 'turn root span must be exported');
    assert.equal(root!.links.length, 1, 'turn root must carry exactly one span link');
    assert.equal(root!.links[0]!.context.traceId, afterStart!.session_trace_id);
    assert.equal(root!.links[0]!.context.spanId, afterStart!.session_span_id);
  });

  it('a SECOND turn in the same session still links to the session span (link is not a one-shot)', async () => {
    const { logsConfig } = freshFixture();
    const tracer = makeInMemoryTracer();
    const sessionId = 'sess-link-2';

    await dispatchCollectorEvent({
      event: 'SessionStart', input: { session_id: sessionId }, platform: 'claude-code',
      config: baseConfig, meterProvider: null, tracerProvider: tracer.provider, logsConfig,
    });
    const afterStart = loadState(logsConfig);

    await runOneTurn(sessionId, logsConfig, tracer.provider);
    await runOneTurn(sessionId, logsConfig, tracer.provider);

    const roots = tracer.finished().filter((s) => s.name === 'invoke_agent UserPromptSubmit');
    assert.equal(roots.length, 2, 'both turns must export a root span');
    for (const root of roots) {
      assert.equal(root.links.length, 1, 'every turn root must carry the session link, not just the first');
      assert.equal(root.links[0]!.context.traceId, afterStart!.session_trace_id);
      assert.equal(root.links[0]!.context.spanId, afterStart!.session_span_id);
    }
  });
});

// ── SessionEnd emits the session span ───────────────────────────────────

describe('session-trace: SessionEnd emits the session span', () => {
  it('emits a span at (session_trace_id, session_span_id) and clears the session fields from state', async () => {
    const { logsConfig } = freshFixture();
    const tracer = makeInMemoryTracer();
    const sessionId = 'sess-end-1';

    await dispatchCollectorEvent({
      event: 'SessionStart', input: { session_id: sessionId }, platform: 'claude-code',
      config: baseConfig, meterProvider: null, tracerProvider: tracer.provider, logsConfig,
    });
    const afterStart = loadState(logsConfig);

    await dispatchCollectorEvent({
      event: 'SessionEnd', input: { session_id: sessionId, cwd: '/tmp' }, platform: 'claude-code',
      config: baseConfig, meterProvider: null, tracerProvider: tracer.provider, logsConfig,
    });

    const sessionSpan = tracer.finished().find(
      (s) => s.spanContext().traceId === afterStart!.session_trace_id
        && s.spanContext().spanId === afterStart!.session_span_id,
    );
    assert.ok(sessionSpan, 'a span at the minted (trace id, span id) pair must be exported');
    assert.equal(sessionSpan!.name, 'session');
    assert.equal(sessionSpan!.attributes['session.id'], sessionId);

    const afterEnd = loadState(logsConfig);
    assert.equal(afterEnd?.session_trace_id, undefined, 'session_trace_id must be cleared after SessionEnd');
    assert.equal(afterEnd?.session_span_id, undefined, 'session_span_id must be cleared after SessionEnd');
  });
});

// ── Degradation: no session fields → turn exports, no link, no throw ───

describe('session-trace: degrades cleanly when session fields are absent', () => {
  it('a turn started WITHOUT a prior SessionStart exports normally with zero links', async () => {
    const { logsConfig } = freshFixture();
    const tracer = makeInMemoryTracer();
    const sessionId = 'sess-no-session-start';

    // No SessionStart dispatched for this session at all.
    await assert.doesNotReject(runOneTurn(sessionId, logsConfig, tracer.provider));

    const root = turnRoot(tracer.finished());
    assert.ok(root, 'turn root must still export without a session link');
    assert.deepEqual(root!.links, [], 'no session fields means no link, not a broken one');
  });
});
