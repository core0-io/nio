// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { trackTempDir } from './helpers/tmp-dirs.js';

// Bundled by bun into plugins/claude-code/skills/nio/scripts/, not
// dist/scripts/ — see hook-cli.test.ts for the same resolution.
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..', '..', 'plugins', 'claude-code', 'skills', 'nio', 'scripts');
const COLLECTOR = join(SCRIPTS, 'collector-hook.js');
const MONITOR = join(SCRIPTS, 'monitor-cli.js');
const GUARD = join(SCRIPTS, 'guard-hook.js');

// Every fixture in this file points collector.endpoint at a closed port
// (127.0.0.1:19999). collector-hook.ts and guard-hook.ts both only avoid
// hanging forever against a refused connection because main() calls an
// explicit process.exit() after forceFlush() resolves — see the Hermes
// hang this project already shipped once (hermes-exit.test.ts): a
// PeriodicExportingMetricReader retry timer kept the event loop alive
// past forceFlush() with no explicit exit, so the subprocess never
// returned. That fix lives in a different file than this test suite, so
// if it's ever refactored away, execFileSync's *default* (no timeout —
// wait forever) would turn CI into an indefinite hang instead of a fast,
// legible failure. Every execFileSync call below sets this explicitly.
// Sized like hermes-exit.test.ts's EXIT_TIMEOUT_MS: generous enough to
// absorb a real retry/backoff cycle against a refused connection
// (observed here in the 9-11s range for a single flush), while still
// failing fast if the exit-on-flush guarantee regresses.
const EXEC_TIMEOUT_MS = 45000;

function freshHome(): string {
  const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-monitor-e2e-')));
  // Point at a closed port. The state-file-existence assertions below
  // are the actual judge of whether the gate leaked (saveState() and
  // tracerProvider creation are strictly co-conditioned on
  // isSessionMonitored() — see collector-hook.ts); the closed port just
  // makes sure any leaked exporter fails fast via EXEC_TIMEOUT_MS rather
  // than the test silently depending on a real OTLP collector.
  writeFileSync(join(home, 'config.yaml'),
    'collector:\n  endpoint: "http://127.0.0.1:19999"\n', 'utf-8');
  return home;
}

function fireHook(home: string, payload: unknown): void {
  execFileSync('node', [COLLECTOR, '--platform', 'claude-code'], {
    env: { ...process.env, NIO_HOME: home },
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    timeout: EXEC_TIMEOUT_MS,
  });
}

/** Runs guard-hook.js and returns its exit code without throwing on a
 * non-zero (deny) exit — execFileSync throws by default in that case. */
function runGuardHook(home: string, payload: unknown): number {
  try {
    execFileSync('node', [GUARD], {
      env: { ...process.env, NIO_HOME: home },
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
    });
    return 0;
  } catch (err) {
    const status = (err as { status?: number | null }).status;
    if (typeof status === 'number') return status;
    throw err;
  }
}

function preToolUse(sessionId: string, cwd: string): unknown {
  return {
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    cwd,
    tool_name: 'Bash',
    tool_input: { command: 'echo hi' },
    tool_use_id: 'toolu_e2e_1',
  };
}

describe('monitor gate end-to-end', () => {
  it('writes local audit but no trace state when unmonitored', () => {
    const home = freshHome();
    fireHook(home, preToolUse('sess-e2e-off', home));

    assert.equal(existsSync(join(home, 'audit.jsonl')), true,
      'local audit log must be written even when unmonitored');
    assert.equal(existsSync(join(home, 'traces-state-store.json')), false,
      'no tracer provider means no pending span state');
  });

  it('creates trace state once the session is armed', () => {
    const home = freshHome();
    execFileSync('node', [MONITOR, 'on'], {
      env: { ...process.env, NIO_HOME: home, CLAUDE_CODE_SESSION_ID: 'sess-e2e-on' },
      cwd: home,
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
    });

    fireHook(home, preToolUse('sess-e2e-on', home));

    assert.equal(existsSync(join(home, 'traces-state-store.json')), true,
      'armed session must open a pending span');
    const state = JSON.parse(
      readFileSync(join(home, 'traces-state-store.json'), 'utf-8'),
    ) as { session_id: string; pending_spans: Record<string, unknown> };
    assert.equal(state.session_id, 'sess-e2e-on');
    assert.equal('toolu_e2e_1' in state.pending_spans, true);
  });

  it('stops creating trace state after off', () => {
    const home = freshHome();
    const env = { ...process.env, NIO_HOME: home, CLAUDE_CODE_SESSION_ID: 'sess-e2e-toggle' };
    execFileSync('node', [MONITOR, 'on'], { env, cwd: home, encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS });
    execFileSync('node', [MONITOR, 'off'], { env, cwd: home, encoding: 'utf-8', timeout: EXEC_TIMEOUT_MS });

    fireHook(home, preToolUse('sess-e2e-toggle', home));
    assert.equal(existsSync(join(home, 'traces-state-store.json')), false);
  });

  it('monitor_all_sessions captures without arming', () => {
    const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-monitor-e2e-all-')));
    writeFileSync(join(home, 'config.yaml'),
      'collector:\n  endpoint: "http://127.0.0.1:19999"\n  monitor_all_sessions: true\n',
      'utf-8');

    fireHook(home, preToolUse('sess-e2e-all', home));
    assert.equal(existsSync(join(home, 'traces-state-store.json')), true);
  });

  it('guard still blocks rm -rf / while a session is armed', () => {
    const home = freshHome();
    execFileSync('node', [MONITOR, 'on'], {
      env: { ...process.env, NIO_HOME: home, CLAUDE_CODE_SESSION_ID: 'sess-e2e-guard' },
      cwd: home,
      encoding: 'utf-8',
      timeout: EXEC_TIMEOUT_MS,
    });

    const exitCode = runGuardHook(home, {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-e2e-guard',
      cwd: home,
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
      tool_use_id: 'toolu_e2e_guard',
    });

    // Arming affects only telemetry export, never guard enforcement —
    // Phase 0-6 evaluation in guard-hook.ts runs unconditionally,
    // outside the isSessionMonitored() gate. Mirrors the deny-path
    // assertion in smoke.test.ts ('should deny rm -rf / (exit 2)'), but
    // against an armed session instead of an unconfigured one.
    assert.equal(exitCode, 2, 'guard must still deny rm -rf / while monitoring is armed');
  });
});

// ── Deny-path MCP dimension on the one-shot span (review I3) ──────────
//
// guard-hook.ts's block path emits a complete one-shot span (open + close
// + export) since PostToolUse never fires for a denied call — see the
// `isBlock` branch there. It merges `mcpAttrs` (gen_ai.tool.type /
// nio.mcp.server / nio.mcp.tool) onto that span's closing attrs so a
// blocked MCP call still carries the MCP dimension. Nothing exercised
// that merge before: the parseMcpToolName -> null mutation drill only
// ever caught collector-hook's PostToolUse (allow) path.
//
// Verifying this requires actually inspecting the exported span's
// attributes, not just the exit code — so this stands up a real local
// OTLP/HTTP sink (mirrors monitor-hermes.test.ts's `startSink`) and reads
// the OTLP/JSON body of the /v1/traces POST.

interface TraceSink {
  url: string;
  firstTraceBody: () => string | null;
  close: () => Promise<void>;
}

function startTraceSink(): Promise<TraceSink> {
  return new Promise((resolve, reject) => {
    let body: string | null = null;
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.url === '/v1/traces' && body === null) {
          body = Buffer.concat(chunks).toString('utf-8');
        }
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
        firstTraceBody: () => body,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

/**
 * Async equivalent of runGuardHook(), required (not just preferred) here
 * for the same reason monitor-hermes.test.ts's runHookAsync exists:
 * execFileSync/spawnSync blocks the calling process's entire event loop
 * until the child exits — including the in-process http.createServer
 * sink this test stands up. Since guard-hook.js needs to connect back to
 * that same parent process's HTTP server to export its deny-path span, a
 * sync spawn starves the sink's connections until the child gives up and
 * exits, by which point there's nothing left to service them. Confirmed
 * empirically: swapping this in for the sync runGuardHook() is what
 * turned "sink never receives the span" into a passing test.
 */
function runGuardHookAsync(home: string, payload: unknown, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [GUARD], {
      env: { ...process.env, NIO_HOME: home },
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`guard-hook timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code ?? -1);
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

interface OtlpAttr { key: string; value: Record<string, unknown> }
interface OtlpSpan { name: string; attributes: OtlpAttr[] }

function findAttr(span: OtlpSpan, key: string): unknown {
  const attr = span.attributes.find((a) => a.key === key);
  if (!attr) return undefined;
  const v = attr.value;
  return v.stringValue ?? v.intValue ?? v.boolValue ?? v;
}

describe('guard-hook deny path: MCP dimension on the one-shot span', () => {
  it('a denied mcp__<server>__<tool> call carries gen_ai.tool.type / nio.mcp.server / nio.mcp.tool', async () => {
    const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-monitor-e2e-mcp-deny-')));
    const sink = await startTraceSink();
    try {
      writeFileSync(join(home, 'config.yaml'), [
        'guard:',
        '  blocked_tools:',
        '    mcp:',
        '      - blockedtool',
        'collector:',
        `  endpoint: "${sink.url}"`,
        '',
      ].join('\n'), 'utf-8');

      // Arm the session — same MONITOR-CLI path as the existing
      // 'guard still blocks rm -rf /' test above.
      execFileSync('node', [MONITOR, 'on'], {
        env: { ...process.env, NIO_HOME: home, CLAUDE_CODE_SESSION_ID: 'sess-e2e-mcp-deny' },
        cwd: home,
        encoding: 'utf-8',
        timeout: EXEC_TIMEOUT_MS,
      });

      const exitCode = await runGuardHookAsync(home, {
        hook_event_name: 'PreToolUse',
        session_id: 'sess-e2e-mcp-deny',
        cwd: home,
        tool_name: 'mcp__someserver__blockedtool',
        tool_input: {},
        tool_use_id: 'toolu_e2e_mcp_deny',
      }, EXEC_TIMEOUT_MS);
      assert.equal(exitCode, 2, 'blocked_tools.mcp must deny the call');

      const body = sink.firstTraceBody();
      assert.ok(body, 'expected the one-shot deny span to reach the OTLP sink');
      const parsed = JSON.parse(body!) as {
        resourceSpans: Array<{ scopeSpans: Array<{ spans: OtlpSpan[] }> }>;
      };
      const span = parsed.resourceSpans[0]?.scopeSpans[0]?.spans[0];
      assert.ok(span, 'expected exactly one exported span');
      assert.equal(span!.name, 'execute_tool mcp__someserver__blockedtool');

      assert.equal(findAttr(span!, 'gen_ai.tool.type'), 'mcp');
      assert.equal(findAttr(span!, 'nio.mcp.server'), 'someserver');
      assert.equal(findAttr(span!, 'nio.mcp.tool'), 'blockedtool');
      // And the ordinary deny attrs are still present alongside it.
      assert.equal(findAttr(span!, 'nio.guard.decision'), 'deny');
    } finally {
      await sink.close();
    }
  });
});
