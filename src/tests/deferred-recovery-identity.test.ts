// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Review finding I1: a shard swept by `takeAbandonedShards` used to be
 * re-emitted under the RECOVERING process's platform identity.
 *
 * Since 9da6c81, `nio.platform` / `service.name` / `gen_ai.agent.name`
 * live only on the OTEL Resource, and a Resource belongs to a provider.
 * `recoverDeferredTree(tracerProvider, shard.state)` therefore labelled a
 * dead Codex session's tree `nio.platform=claude-code` /
 * `service.name=nio-claude-code` while the spans inside still carried the
 * Codex `session.id`. All four platforms share `$NIO_HOME` by default and
 * Claude Code and Codex are the same scripts behind a different
 * `--platform` flag, so this is a routine configuration.
 *
 * No mutation was needed to produce it — the unmutated code did. Nothing
 * observed the resource of a recovered tree: `deferred-recovery.test.ts`
 * asserts only `traceId` and `nio.turn.incomplete`, and drives everything
 * through a single `platform: 'claude-code'` dispatch.
 *
 * These tests read the RESOURCE off the raw OTLP/HTTP JSON body, the same
 * technique `openclaw-span-hierarchy.test.ts` uses — an in-memory
 * exporter cannot show it, because the whole point is which provider (and
 * therefore which Resource) the tree went out on.
 */

import { describe, it, before as beforeHook, after as afterHook, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { dispatchCollectorEvent } from '../scripts/lib/collector-core.js';
import { createTracerProvider } from '../scripts/lib/traces-collector.js';
import {
  statePath, saveState, loadState,
  type CollectorState, type DeferredSpan,
} from '../scripts/lib/traces-state-store.js';
import type { ResolvedMetricsConfig, CollectorLogsConfig } from '../adapters/common.js';
import { trackTempDir } from './helpers/tmp-dirs.js';

interface WireSpan { name: string; traceId: string; attributes?: unknown[] }
interface WireKV { key: string; value?: { stringValue?: string } }

/** A resource + the spans that were exported under it, as one batch. */
interface WireBatch { resource: Record<string, string>; spans: WireSpan[] }

function orphanTool(spanId: string): DeferredSpan {
  return {
    kind: 'tool',
    name: 'execute_tool Bash',
    span_id: spanId,
    start_ms: Date.now() - 20_000,
    end_ms: Date.now() - 19_500,
    attributes: { 'gen_ai.tool.name': 'Bash' },
  };
}

describe('deferred recovery keeps the DEAD session\'s platform identity', () => {
  let sink: Server;
  const bodies: string[] = [];
  let port = 0;

  beforeHook(async () => {
    sink = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.url === '/v1/traces') bodies.push(Buffer.concat(chunks).toString('utf-8'));
        res.writeHead(200);
        res.end('{}');
      });
    });
    await new Promise<void>((r) => sink.listen(0, '127.0.0.1', r));
    port = (sink.address() as { port: number }).port;
  });

  afterHook(async () => { await new Promise<void>((r) => sink.close(() => r())); });
  beforeEach(() => { bodies.length = 0; });

  /** Every exported batch, resource attributes flattened to a map. */
  function batches(): WireBatch[] {
    const out: WireBatch[] = [];
    for (const body of bodies) {
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { continue; }
      for (const rs of (parsed as { resourceSpans?: unknown[] }).resourceSpans ?? []) {
        const resource: Record<string, string> = {};
        const attrs = ((rs as { resource?: { attributes?: WireKV[] } }).resource?.attributes) ?? [];
        for (const a of attrs) resource[a.key] = a.value?.stringValue ?? '';
        const spans: WireSpan[] = [];
        for (const ss of (rs as { scopeSpans?: unknown[] }).scopeSpans ?? []) {
          for (const s of (ss as { spans?: WireSpan[] }).spans ?? []) spans.push(s);
        }
        out.push({ resource, spans });
      }
    }
    return out;
  }

  function batchFor(spanName: string): WireBatch | undefined {
    return batches().find((b) => b.spans.some((s) => s.name === spanName));
  }

  function fixture(): { logsConfig: CollectorLogsConfig; config: ResolvedMetricsConfig } {
    const dir = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-recovery-identity-')));
    return {
      logsConfig: {
        enabled: true, local: true, path: join(dir, 'audit.jsonl'), max_size_mb: 100,
      },
      config: {
        endpoint: `http://127.0.0.1:${port}`,
        api_key: '', timeout: 5000, protocol: 'http',
        enabled: true, metrics_enabled: false, traces_enabled: true, logs_enabled: false,
      },
    };
  }

  function crashedShard(
    logsConfig: CollectorLogsConfig,
    sessionId: string,
    identity: { platform?: string; agent_name?: string },
  ): void {
    const stale: CollectorState = {
      session_id: sessionId,
      ...identity,
      turn_number: 1,
      turn_trace_id: 'a'.repeat(32),
      turn_start_ms: Date.now() - 30_000,
      pending_spans: {},
      pending_task_spans: {},
      turn_attributes: {},
      deferred_spans: [orphanTool('1'.repeat(16))],
    };
    saveState(logsConfig, stale, sessionId);
    const when = new Date(Date.now() - 2 * 60 * 60 * 1000);   // 2h: past SHARD_STALE_MS
    utimesSync(statePath(logsConfig, sessionId), when, when);
  }

  /** Give SimpleSpanProcessor's export a moment to reach the sink. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 40 && bodies.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  it('a Codex shard swept by a Claude Code SessionStart goes out as nio-codex, not nio-claude-code', async () => {
    const { logsConfig, config } = fixture();
    crashedShard(logsConfig, 'sess-codex-dead', { platform: 'codex' });

    const provider = createTracerProvider(
      { ...config, headers: {} }, 'claude-code', '',
    );
    assert.ok(provider, 'the test needs a real OTLP provider to observe the wire resource');

    await dispatchCollectorEvent({
      event: 'SessionStart',
      input: { session_id: 'sess-cc-new' },
      platform: 'claude-code',
      config, meterProvider: null, tracerProvider: provider, logsConfig,
    });
    await settle();
    await provider.shutdown();

    const tool = batchFor('execute_tool Bash');
    assert.ok(tool, 'the abandoned Codex tree must still be recovered and exported');
    assert.equal(
      tool.resource['nio.platform'], 'codex',
      'the recovered tree carries the RECOVERING process\'s platform — a dead Codex session\'s ' +
      'spans are being reported as Claude Code work while still carrying the Codex session.id',
    );
    assert.equal(
      tool.resource['service.name'], 'nio-codex',
      'service.name splits the platforms into separate services; a recovered tree must not ' +
      'land in the sweeper\'s service',
    );

    const root = batchFor('invoke_agent UserPromptSubmit');
    assert.ok(root, 'the synthetic incomplete root must be exported too');
    assert.equal(
      root.resource['nio.platform'], 'codex',
      'the incomplete turn root must carry the same identity as its children',
    );
  });

  it('carries the dead session\'s configured agent_name, not the sweeper\'s', async () => {
    const { logsConfig, config } = fixture();
    crashedShard(logsConfig, 'sess-codex-dead-2', {
      platform: 'codex', agent_name: 'nightly-refactorer',
    });

    const provider = createTracerProvider(
      { ...config, headers: {} }, 'claude-code', 'interactive-dev',
    );
    assert.ok(provider);

    await dispatchCollectorEvent({
      event: 'SessionStart',
      input: { session_id: 'sess-cc-new-2' },
      platform: 'claude-code', agentName: 'interactive-dev',
      config, meterProvider: null, tracerProvider: provider, logsConfig,
    });
    await settle();
    await provider.shutdown();

    const tool = batchFor('execute_tool Bash');
    assert.ok(tool);
    assert.equal(
      tool.resource['gen_ai.agent.name'], 'nightly-refactorer',
      'gen_ai.agent.name is Resource-level identity too — a recovered tree must not be ' +
      'attributed to the agent that happened to sweep it',
    );
  });

  it('a same-platform shard still rides the process\'s own provider', async () => {
    const { logsConfig, config } = fixture();
    crashedShard(logsConfig, 'sess-cc-dead', { platform: 'claude-code' });

    const provider = createTracerProvider({ ...config, headers: {} }, 'claude-code', '');
    assert.ok(provider);

    await dispatchCollectorEvent({
      event: 'SessionStart',
      input: { session_id: 'sess-cc-new-3' },
      platform: 'claude-code',
      config, meterProvider: null, tracerProvider: provider, logsConfig,
    });
    await settle();
    await provider.shutdown();

    const tool = batchFor('execute_tool Bash');
    assert.ok(tool, 'a same-platform abandoned tree must still be recovered');
    assert.equal(tool.resource['nio.platform'], 'claude-code');
    assert.equal(tool.resource['service.name'], 'nio-claude-code');
  });

  it('a pre-upgrade shard with no recorded platform falls back to the sweeper\'s identity', async () => {
    // Shards written before the identity fields existed carry neither.
    // Emitting them under the sweeper's Resource is the old behaviour and
    // is strictly better than dropping the tree.
    const { logsConfig, config } = fixture();
    crashedShard(logsConfig, 'sess-legacy-dead', {});

    const provider = createTracerProvider({ ...config, headers: {} }, 'hermes', '');
    assert.ok(provider);

    await dispatchCollectorEvent({
      event: 'SessionStart',
      input: { session_id: 'sess-hermes-new' },
      platform: 'hermes',
      config, meterProvider: null, tracerProvider: provider, logsConfig,
    });
    await settle();
    await provider.shutdown();

    const tool = batchFor('execute_tool Bash');
    assert.ok(tool, 'a shard with no recorded identity must still be recovered');
    assert.equal(tool.resource['nio.platform'], 'hermes');
  });
});

describe('collector state records the platform that owns the shard', () => {
  function fixture(): CollectorLogsConfig {
    const dir = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-recovery-stamp-')));
    return { enabled: true, local: true, path: join(dir, 'audit.jsonl'), max_size_mb: 100 };
  }

  const noExport: ResolvedMetricsConfig = {
    endpoint: '', api_key: '', timeout: 5000, protocol: 'http',
    enabled: true, metrics_enabled: true, traces_enabled: true, logs_enabled: true,
  };

  it('every dispatch that writes state stamps platform + agent_name onto it', async () => {
    const logsConfig = fixture();
    const { makeInMemoryTracer } = await import('./helpers/tracer.js');
    const tracer = makeInMemoryTracer();

    await dispatchCollectorEvent({
      event: 'SessionStart',
      input: { session_id: 'sess-stamp' },
      platform: 'codex', agentName: 'my-agent',
      config: noExport, meterProvider: null, tracerProvider: tracer.provider, logsConfig,
    });

    const state = loadState(logsConfig, 'sess-stamp');
    assert.equal(
      state?.platform, 'codex',
      'without a recorded platform the sweep on another platform cannot label the recovered ' +
      'tree correctly — this is the field the whole fix rests on',
    );
    assert.equal(state?.agent_name, 'my-agent');
  });

  it('leaves agent_name off when none is configured, rather than writing an empty string', async () => {
    const logsConfig = fixture();
    const { makeInMemoryTracer } = await import('./helpers/tracer.js');
    const tracer = makeInMemoryTracer();

    await dispatchCollectorEvent({
      event: 'SessionStart',
      input: { session_id: 'sess-stamp-2' },
      platform: 'claude-code',
      config: noExport, meterProvider: null, tracerProvider: tracer.provider, logsConfig,
    });

    const state = loadState(logsConfig, 'sess-stamp-2');
    assert.equal(state?.platform, 'claude-code');
    assert.equal(state?.agent_name, undefined);
  });
});
