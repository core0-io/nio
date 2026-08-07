// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * A DENIED tool call's arguments, and how many times they reach the wire.
 *
 * The block path is the one place where the tool span is emitted by the
 * guard process rather than by the collector's PostToolUse branch: the
 * tool never runs, so PostToolUse never fires and nothing downstream will
 * ever say anything about this call again. That makes guard-hook.ts the
 * OWNER of these arguments — and the arguments of a call nio refused are
 * the ones a reviewer most wants to read back.
 *
 * Two things are pinned here:
 *
 *  1. The span attribute is built by the same `buildSpanContent`
 *     pipeline as every other content-bearing attribute, so an
 *     over-budget payload is FLAGGED `nio.content.truncated` instead of
 *     being clipped silently. It used to go through `redactAndTruncate`,
 *     which caps at the same size and says nothing — and the documented
 *     consumer rule ("attribute present, no truncated flag ⇒ the span has
 *     all of it") therefore read a clipped 5 KB payload as complete.
 *  2. When the span could not take the whole body, this site emits the
 *     full-fidelity `tool_input` record itself. Before, a denied call's
 *     only full copy was the `tool_use` content record `endTurn` built —
 *     which no longer exists (it was the third copy of the arguments for
 *     every non-denied call; see tool-input-dedup.test.ts).
 *
 * Runs the real bundled hook as a subprocess against a real local OTLP
 * sink, because the block path lives inside guard-hook.ts's `main()` and
 * has no importable seam.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { trackTempDir } from './helpers/tmp-dirs.js';
import { runHermesHookAsync } from './helpers/hermes-hook.js';
import { SPAN_CONTENT_LIMIT } from '../scripts/lib/content/span-content.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..', '..', 'plugins', 'claude-code', 'skills', 'nio', 'scripts');
const MONITOR = join(SCRIPTS, 'monitor-cli.js');
const GUARD = join(SCRIPTS, 'guard-hook.js');

const EXEC_TIMEOUT_MS = 45000;

interface OtlpAttr { key: string; value: Record<string, unknown> }
interface OtlpSpan { name: string; attributes: OtlpAttr[] }
interface OtlpLogRecord { body?: { stringValue?: string }; attributes: OtlpAttr[] }

interface Sink {
  url: string;
  spans: () => OtlpSpan[];
  logRecords: () => OtlpLogRecord[];
  close: () => Promise<void>;
}

/**
 * Collects every /v1/traces and /v1/logs POST, not just the first: the
 * span and the record under test are exported by two different providers
 * and arrive as separate requests.
 */
function startSink(): Promise<Sink> {
  return new Promise((resolve, reject) => {
    const traceBodies: string[] = [];
    const logBodies: string[] = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        if (req.url === '/v1/traces') traceBodies.push(body);
        else if (req.url === '/v1/logs') logBodies.push(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('sink failed to bind to a port'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        spans: () => traceBodies.flatMap((b) => {
          const parsed = JSON.parse(b) as {
            resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: OtlpSpan[] }> }>;
          };
          return (parsed.resourceSpans ?? []).flatMap(
            (rs) => (rs.scopeSpans ?? []).flatMap((ss) => ss.spans ?? []),
          );
        }),
        logRecords: () => logBodies.flatMap((b) => {
          const parsed = JSON.parse(b) as {
            resourceLogs?: Array<{ scopeLogs?: Array<{ logRecords?: OtlpLogRecord[] }> }>;
          };
          return (parsed.resourceLogs ?? []).flatMap(
            (rl) => (rl.scopeLogs ?? []).flatMap((sl) => sl.logRecords ?? []),
          );
        }),
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

function findAttr(holder: { attributes: OtlpAttr[] }, key: string): unknown {
  const found = holder.attributes.find((a) => a.key === key);
  if (!found) return undefined;
  const v = found.value;
  return v['stringValue'] ?? v['intValue'] ?? v['boolValue'] ?? v;
}

/**
 * Async spawn, not execFileSync: a sync spawn blocks this process's event
 * loop, which is where the sink's HTTP server lives — the child would
 * never get its export serviced. Same reason monitor-e2e.test.ts has its
 * own async runner.
 */
function runGuardHookAsync(home: string, payload: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [GUARD], { env: { ...process.env, NIO_HOME: home } });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error('guard-hook timed out'));
    }, EXEC_TIMEOUT_MS);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    child.on('error', (e) => finish(() => reject(e)));
    child.on('close', (code) => finish(() => resolve(code ?? -1)));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

async function denyOnce(command: string, sessionId: string): Promise<{
  spans: OtlpSpan[];
  logRecords: OtlpLogRecord[];
  argsJson: string;
  close: () => Promise<void>;
}> {
  const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-guard-deny-args-')));
  const sink = await startSink();
  writeFileSync(join(home, 'config.yaml'), [
    'guard:',
    '  blocked_tools:',
    '    claude_code:',
    '      - Bash',
    'collector:',
    `  endpoint: "${sink.url}"`,
    '',
  ].join('\n'), 'utf-8');

  execFileSync('node', [MONITOR, 'on'], {
    env: { ...process.env, NIO_HOME: home, CLAUDE_CODE_SESSION_ID: sessionId },
    cwd: home,
    encoding: 'utf-8',
    timeout: EXEC_TIMEOUT_MS,
  });

  const toolInput = { command, timeout: 120000 };
  const exitCode = await runGuardHookAsync(home, {
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    cwd: home,
    tool_name: 'Bash',
    tool_input: toolInput,
    tool_use_id: 'toolu_denied_1',
  });
  assert.equal(exitCode, 2, 'blocked_tools must deny the call — otherwise no one-shot span exists');

  return {
    spans: sink.spans(),
    logRecords: sink.logRecords(),
    argsJson: JSON.stringify(toolInput),
    close: sink.close,
  };
}

describe('a denied tool call keeps its arguments, exactly once', () => {
  it('arguments within the span budget ride the one-shot span alone', async () => {
    const { spans, logRecords, argsJson, close } = await denyOnce('rm -rf /tmp/x', 'sess-deny-small');
    try {
      const tool = spans.find((s) => s.name.startsWith('execute_tool'));
      assert.ok(tool, 'the deny path must export a one-shot tool span');
      assert.equal(findAttr(tool, 'gen_ai.tool.call.arguments'), argsJson);
      assert.equal(
        findAttr(tool, 'nio.content.truncated'), undefined,
        'a payload that fits is complete on the span, and says so by omission',
      );
      assert.deepEqual(
        logRecords.filter((r) => findAttr(r, 'nio.content.type') === 'tool_input'), [],
        'a log copy would be the same bytes twice',
      );
    } finally {
      await close();
    }
  });

  it('arguments past the span budget keep a full copy in logs, flagged on the span', async () => {
    const command = `echo "${'y'.repeat(SPAN_CONTENT_LIMIT * 2)}"`;
    const { spans, logRecords, argsJson, close } = await denyOnce(command, 'sess-deny-big');
    try {
      const tool = spans.find((s) => s.name.startsWith('execute_tool'));
      assert.ok(tool, 'the deny path must export a one-shot tool span');
      const onSpan = findAttr(tool, 'gen_ai.tool.call.arguments') as string;
      assert.ok(
        Buffer.byteLength(onSpan, 'utf-8') <= SPAN_CONTENT_LIMIT,
        `span copy must respect the ${SPAN_CONTENT_LIMIT}-byte budget`,
      );
      assert.equal(
        findAttr(tool, 'nio.content.truncated'), true,
        'without this the clipped preview reads as the whole command',
      );

      const inputs = logRecords.filter((r) => findAttr(r, 'nio.content.type') === 'tool_input');
      assert.equal(inputs.length, 1, 'exactly one full copy, from the site that emitted the span');
      assert.equal(
        inputs[0]!.body?.stringValue, argsJson,
        'the denied command must survive in full — this is the record a reviewer reads',
      );
      assert.equal(findAttr(inputs[0]!, 'gen_ai.tool.call.id'), 'toolu_denied_1');
    } finally {
      await close();
    }
  });
});

/**
 * Hermes runs the same block path from `hook-cli.ts` rather than
 * `guard-hook.ts`, and it was worse off: its pending entry comes from
 * collector-core's PreToolUse branch, which parks IDENTITY ONLY, so the
 * one-shot span went out with no `gen_ai.tool.call.arguments` at all.
 * Whatever the payload's size, a denied Hermes call could only be read
 * back through the 300-char `nio.tool_summary`.
 */
describe('a denied tool call on hermes keeps its arguments too', () => {
  it('puts them on the one-shot span, and in logs only when they did not fit', async () => {
    const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-hermes-deny-args-')));
    const sink = await startSink();
    try {
      writeFileSync(join(home, 'config.yaml'), [
        'guard:',
        '  blocked_tools:',
        '    hermes:',
        '      - terminal',
        'collector:',
        `  endpoint: "${sink.url}"`,
        '',
      ].join('\n'), 'utf-8');
      writeFileSync(join(home, 'monitored-sessions.json'), JSON.stringify({
        sessions: { 'sess-hermes-deny': { armed_at: Date.now(), cwd: home } },
      }), 'utf-8');

      const toolInput = { command: 'rm -rf /tmp/hermes-x' };
      await runHermesHookAsync(home, {
        hook_event_name: 'pre_tool_call',
        tool_name: 'terminal',
        tool_input: toolInput,
        tool_call_id: 'toolu_hermes_denied',
        session_id: 'sess-hermes-deny',
        cwd: home,
        extra: {},
      });

      const tool = sink.spans().find((s) => s.name.startsWith('execute_tool'));
      assert.ok(tool, 'the hermes block path must export a one-shot tool span');
      assert.equal(
        findAttr(tool, 'gen_ai.tool.call.arguments'), JSON.stringify(toolInput),
        'the denied command must be on the span — it used to be nowhere',
      );
      assert.deepEqual(
        sink.logRecords().filter((r) => findAttr(r, 'nio.content.type') === 'tool_input'), [],
        'it fits the span budget, so a log copy would be the same bytes twice',
      );
    } finally {
      await sink.close();
    }
  });
});
