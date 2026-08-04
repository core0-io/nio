// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

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
  const home = mkdtempSync(join(tmpdir(), 'nio-monitor-e2e-'));
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
    const home = mkdtempSync(join(tmpdir(), 'nio-monitor-e2e-all-'));
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
