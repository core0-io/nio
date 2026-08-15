// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMcpToolName, dispatchCollectorEvent } from '../scripts/lib/collector-core.js';
import type { ResolvedMetricsConfig, CollectorLogsConfig } from '../adapters/common.js';
import { trackTempDir } from './helpers/tmp-dirs.js';

describe('parseMcpToolName', () => {
  it('splits a well-formed mcp tool name', () => {
    assert.deepEqual(parseMcpToolName('mcp__github__create_issue'),
      { server: 'github', tool: 'create_issue' });
  });

  it('keeps underscores inside the tool name', () => {
    assert.deepEqual(parseMcpToolName('mcp__my_server__do_a_thing'),
      { server: 'my_server', tool: 'do_a_thing' });
  });

  it('returns null for non-mcp tools', () => {
    for (const n of ['Bash', 'Read', 'terminal', 'exec_command']) {
      assert.equal(parseMcpToolName(n), null, `${n} must not parse as mcp`);
    }
  });

  it('returns null for malformed mcp-looking names', () => {
    for (const n of ['mcp__', 'mcp__onlyserver', 'mcp____empty']) {
      assert.equal(parseMcpToolName(n), null, `${n} must not parse`);
    }
  });
});

// ── Wiring: MCP dimension lands on the exported execute_tool span ──────

function freshFixture(): { logsConfig: CollectorLogsConfig } {
  const dir = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-mcp-dimension-')));
  const auditPath = join(dir, 'audit.jsonl');
  return {
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

/**
 * Close the turn so the deferred tool span is exported. Tool spans are
 * held back until end of turn — see `deferPostToolUse`.
 */
async function flushTurn(
  sessionId: string,
  logsConfig: CollectorLogsConfig,
  tracerProvider: unknown,
): Promise<void> {
  await dispatchCollectorEvent({
    event: 'Stop',
    input: { session_id: sessionId },
    platform: 'claude-code',
    config: baseConfig,
    meterProvider: null,
    tracerProvider: tracerProvider as never,
    logsConfig,
  });
}

/** Exported tool spans only — drops the turn root emitted by `flushTurn`. */
function toolSpans<T extends { name: string }>(spans: readonly T[]): T[] {
  return spans.filter((s) => s.name.startsWith('execute_tool '));
}

describe('MCP tool dimension on execute_tool span', () => {
  it('tags an mcp__<server>__<tool> call with gen_ai.tool.type=mcp and nio.mcp.server', async () => {
    const { makeInMemoryTracer } = await import('./helpers/tracer.js');
    const { logsConfig } = freshFixture();
    const tracer = makeInMemoryTracer();

    const sessionId = 'mcp-dim-sess';

    await dispatchCollectorEvent({
      event: 'PreToolUse',
      input: {
        tool_name: 'mcp__github__create_issue',
        tool_input: { title: 'bug' },
        tool_use_id: 'toolu_mcp1',
        session_id: sessionId,
      },
      platform: 'claude-code',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: tracer.provider,
      logsConfig,
    });

    await dispatchCollectorEvent({
      event: 'PostToolUse',
      input: {
        tool_name: 'mcp__github__create_issue',
        tool_input: { title: 'bug' },
        tool_use_id: 'toolu_mcp1',
        session_id: sessionId,
        tool_response: { output: 'ok' },
      },
      platform: 'claude-code',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: tracer.provider,
      logsConfig,
    });

    await flushTurn(sessionId, logsConfig, tracer.provider);

    const spans = toolSpans(tracer.finished());
    assert.equal(spans.length, 1);
    assert.equal(spans[0]!.attributes['gen_ai.tool.type'], 'mcp');
    assert.equal(spans[0]!.attributes['nio.mcp.server'], 'github');
    assert.equal(spans[0]!.attributes['nio.mcp.tool'], 'create_issue');
  });

  it('leaves non-mcp tools without the mcp dimension', async () => {
    const { makeInMemoryTracer } = await import('./helpers/tracer.js');
    const { logsConfig } = freshFixture();
    const tracer = makeInMemoryTracer();

    const sessionId = 'non-mcp-sess';

    await dispatchCollectorEvent({
      event: 'PreToolUse',
      input: {
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_use_id: 'toolu_bash1',
        session_id: sessionId,
      },
      platform: 'claude-code',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: tracer.provider,
      logsConfig,
    });

    await dispatchCollectorEvent({
      event: 'PostToolUse',
      input: {
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_use_id: 'toolu_bash1',
        session_id: sessionId,
        tool_response: { output: 'ok' },
      },
      platform: 'claude-code',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: tracer.provider,
      logsConfig,
    });

    await flushTurn(sessionId, logsConfig, tracer.provider);

    const spans = toolSpans(tracer.finished());
    assert.equal(spans.length, 1);
    assert.equal(spans[0]!.attributes['gen_ai.tool.type'], undefined);
    assert.equal(spans[0]!.attributes['nio.mcp.server'], undefined);
  });
});
