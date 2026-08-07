// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Hermes fires `on_session_end` at the END OF EVERY TURN, not at the end
 * of the session.
 *
 * Measured on the owner's live install (`~/.nio/audit.jsonl`, session
 * `20260807_170230_014938`, one continuous Hermes run): **1 SessionStart,
 * 6 SessionEnd**, interleaved with 7 UserPromptSubmit and 134 PreToolUse
 * / PostToolUse pairs — all under the *same* `session_id`, all from the
 * same cwd. The host keeps using the session after each `on_session_end`.
 *
 * `dispatchCollectorEvent`'s `SessionEnd` branch ends in
 * `forgetSession(sessionId)`, which deletes the session's arm record from
 * `monitored-sessions.json`. On Claude Code that is correct — SessionEnd
 * really is the end. On Hermes it disarms a session that is still very
 * much alive, so `/nio monitor on` buys at most ONE turn of capture and
 * then goes silent for the rest of the session, with the store left
 * looking as though the user had never armed anything. That is exactly
 * what the owner saw: `/nio monitor` reported `mode: pending`, and
 * afterwards `monitored-sessions.json` contained no Hermes session at all
 * while 400+ of its hook events went unexported.
 *
 * The suite drives the BUNDLED `plugins/hermes/scripts/hook-cli.js` —
 * the binary Hermes actually executes — rather than the library, because
 * the defect is in what a *sequence of separate hook processes* leaves on
 * disk, which is not observable from a single in-process call.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { trackTempDir } from './helpers/tmp-dirs.js';
import { runHermesHookAsync } from './helpers/hermes-hook.js';
import {
  saveMonitorStore, loadMonitorStore, type MonitorStore,
} from '../scripts/lib/monitor-store.js';
import { dispatchCollectorEvent } from '../scripts/lib/collector-core.js';
import type { CollectorLogsConfig, ResolvedMetricsConfig } from '../adapters/common.js';

function freshHome(): string {
  return trackTempDir(mkdtempSync(join(tmpdir(), 'nio-hermes-sessend-')));
}

/**
 * A working directory distinct from NIO_HOME, so a cwd match is a real
 * match and not an artefact of everything sharing one path.
 *
 * `realpathSync` is not cosmetic: on macOS `os.tmpdir()` is `/var/...`,
 * a symlink to `/private/var/...`. The gate canonicalises the cwd off the
 * hook payload but stores `pending_arm.cwd` exactly as
 * `runMonitorCommand` wrote it — and there it comes from `process.cwd()`,
 * which POSIX always reports resolved. Handing the fixture the resolved
 * form is what makes it model production instead of a shape production
 * can never produce.
 */
function freshCwd(): string {
  return realpathSync(trackTempDir(mkdtempSync(join(tmpdir(), 'nio-hermes-proj-'))));
}

/** The store as it is on disk. A missing file is the empty store — that
 * is the default state, and `loadMonitorStore` reads it the same way. */
function readStore(home: string): MonitorStore {
  const path = join(home, 'monitored-sessions.json');
  if (!existsSync(path)) return { sessions: {} };
  return JSON.parse(readFileSync(path, 'utf-8')) as MonitorStore;
}

/**
 * Write the exact store `/nio monitor on` leaves behind on Hermes: no
 * session id was resolvable from the environment, so `runMonitorCommand`
 * persists a `pending_arm` for the next hook event from this cwd to
 * claim. Written raw so the test depends only on the on-disk contract.
 */
function armPending(home: string, cwd: string): void {
  writeFileSync(
    join(home, 'monitored-sessions.json'),
    JSON.stringify({ sessions: {}, pending_arm: { at: Date.now(), cwd } }),
    'utf-8',
  );
}

/** The real session id shape Hermes emits — a local timestamp, not a UUID. */
const HERMES_SESSION = '20260807_170230_014938';

function preToolCall(sessionId: string, cwd: string, id: string): unknown {
  return {
    hook_event_name: 'pre_tool_call',
    session_id: sessionId,
    cwd,
    tool_name: 'terminal',
    tool_input: { command: 'ls' },
    extra: { tool_call_id: id },
  };
}

function postToolCall(sessionId: string, cwd: string, id: string): unknown {
  return {
    hook_event_name: 'post_tool_call',
    session_id: sessionId,
    cwd,
    tool_name: 'terminal',
    tool_input: { command: 'ls' },
    extra: { tool_call_id: id, result: 'ok' },
  };
}

function sessionEnd(sessionId: string, cwd: string): unknown {
  return { hook_event_name: 'on_session_end', session_id: sessionId, cwd, extra: {} };
}

// ── The event shape the defect report was written against ──────────────
//
// Hermes's `pre_tool_call` frequently carries `session_id: ""` while the
// PAIRED `post_tool_call` carries the real id (verified in the owner's
// audit log at 06:47:58/06:47:59 and three more times). This block pins
// what that sequence does to the store.

describe('hermes pending arm: empty-id pre, real-id post', () => {
  it('an empty-id pre_tool_call neither claims nor consumes the pending arm', async () => {
    const home = freshHome();
    const cwd = freshCwd();
    armPending(home, cwd);

    await runHermesHookAsync(home, preToolCall('', cwd, 'call-empty'));

    const store = readStore(home);
    assert.deepEqual(store.sessions, {},
      'an untrusted (empty) session id must never become a store key');
    assert.notEqual(store.pending_arm, undefined,
      'the arm must survive an event that could not claim it');
    assert.equal(store.pending_arm?.cwd, cwd);
  });

  it('the paired real-id post_tool_call then claims that same arm', async () => {
    const home = freshHome();
    const cwd = freshCwd();
    armPending(home, cwd);

    await runHermesHookAsync(home, preToolCall('', cwd, 'call-1'));
    await runHermesHookAsync(home, postToolCall(HERMES_SESSION, cwd, 'call-1'));

    const store = readStore(home);
    assert.ok(store.sessions[HERMES_SESSION],
      'post_tool_call runs through the same isSessionMonitored entry as '
      + 'pre_tool_call, so a real id claims the arm even when the pre was id-less');
    assert.equal(store.pending_arm, undefined, 'a claimed arm is consumed');
  });
});

// ── The actual defect ──────────────────────────────────────────────────

describe('hermes per-turn on_session_end must not disarm the session', () => {
  it('keeps the arm after the turn-boundary session_end', async () => {
    const home = freshHome();
    const cwd = freshCwd();
    armPending(home, cwd);

    // Turn 1 — a tool call claims the arm.
    await runHermesHookAsync(home, preToolCall('', cwd, 'call-1'));
    await runHermesHookAsync(home, postToolCall(HERMES_SESSION, cwd, 'call-1'));
    assert.ok(readStore(home).sessions[HERMES_SESSION], 'precondition: armed');

    // Hermes ends the TURN by firing on_session_end. The session_id is
    // unchanged and the session keeps running (7 more turns, in the
    // recorded trace this fixture is modelled on).
    await runHermesHookAsync(home, sessionEnd(HERMES_SESSION, cwd));

    assert.ok(readStore(home).sessions[HERMES_SESSION],
      'Hermes fires on_session_end once per turn — forgetting the arm there '
      + 'silently disarms a session that is still running');
  });

  it('still exports telemetry on the turn AFTER a session_end', async () => {
    const home = freshHome();
    const cwd = freshCwd();
    const sink = await startSink();
    try {
      writeFileSync(join(home, 'config.yaml'),
        `collector:\n  endpoint: "${sink.url}"\n`, 'utf-8');
      armPending(home, cwd);

      // Turn 1: claim, then Hermes's turn-boundary session_end.
      await runHermesHookAsync(home, preToolCall('', cwd, 'call-1'));
      await runHermesHookAsync(home, postToolCall(HERMES_SESSION, cwd, 'call-1'));
      await runHermesHookAsync(home, sessionEnd(HERMES_SESSION, cwd));
      const afterTurn1 = sink.requestCount();
      assert.ok(afterTurn1 > 0, 'sanity: the armed turn exported something');

      // Turn 2: same session id, same cwd — the user never disarmed.
      await runHermesHookAsync(home, preToolCall(HERMES_SESSION, cwd, 'call-2'));
      await runHermesHookAsync(home, postToolCall(HERMES_SESSION, cwd, 'call-2'));

      assert.ok(sink.requestCount() > afterTurn1,
        'the second turn of an armed Hermes session must still reach the wire');
    } finally {
      await sink.close();
    }
  });
});

// ── The properties the fix must NOT break ──────────────────────────────

describe('hermes session_end: gating invariants hold', () => {
  it('a session_end never arms anything by itself', async () => {
    const home = freshHome();
    const cwd = freshCwd();
    const sink = await startSink();
    try {
      writeFileSync(join(home, 'config.yaml'),
        `collector:\n  endpoint: "${sink.url}"\n`, 'utf-8');
      // No arm at all — the default posture.
      await runHermesHookAsync(home, sessionEnd(HERMES_SESSION, cwd));
      await runHermesHookAsync(home, preToolCall(HERMES_SESSION, cwd, 'c'));
      await runHermesHookAsync(home, postToolCall(HERMES_SESSION, cwd, 'c'));

      assert.equal(sink.requestCount(), 0,
        'an unarmed session must not export a single OTLP request');
      const store = readStore(home);
      assert.deepEqual(store.sessions, {}, 'nothing may be armed');
    } finally {
      await sink.close();
    }
  });

  it('an id-less session_end never becomes a store key', async () => {
    const home = freshHome();
    const cwd = freshCwd();
    armPending(home, cwd);

    await runHermesHookAsync(home, sessionEnd('', cwd));

    const store = readStore(home);
    assert.deepEqual(store.sessions, {},
      "'' must never key the store, on any event");
    assert.notEqual(store.pending_arm, undefined, 'the arm is untouched');
  });

  it('one arm binds exactly one session, and only from the arming cwd', async () => {
    const home = freshHome();
    const cwd = freshCwd();
    const otherCwd = freshCwd();
    armPending(home, cwd);

    // A different directory cannot claim it.
    await runHermesHookAsync(home, postToolCall('sess-elsewhere', otherCwd, 'x'));
    assert.deepEqual(readStore(home).sessions, {},
      'a cwd mismatch must never claim the arm');

    // The arming directory claims it, once.
    await runHermesHookAsync(home, postToolCall(HERMES_SESSION, cwd, 'y'));
    // A second session in the same directory finds nothing left to claim,
    // even across the turn-boundary session_end.
    await runHermesHookAsync(home, sessionEnd(HERMES_SESSION, cwd));
    await runHermesHookAsync(home, postToolCall('20260807_180000_second', cwd, 'z'));

    const armed = Object.keys(readStore(home).sessions);
    assert.deepEqual(armed, [HERMES_SESSION],
      'exactly one session may be bound by one arm');
  });
});

// ── The other half of the discrimination ───────────────────────────────
//
// The fix is a per-platform choice, so it has to be pinned in BOTH
// directions: skipping the disarm everywhere would leave every Claude
// Code session armed until the 7-day backstop. Driven through the real
// dispatch rather than the bundled binary because the only thing under
// test is which branch `SessionEnd` takes, and the library call makes the
// platform an explicit parameter instead of an implicit CLI flag.

describe('SessionEnd disarm is platform-discriminating', () => {
  function armedFixture(sessionId: string): {
    logsConfig: CollectorLogsConfig; cwd: string;
  } {
    const dir = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-sessend-disarm-')));
    const cwd = freshCwd();
    const logsConfig: CollectorLogsConfig = {
      enabled: true, local: true, path: join(dir, 'audit.jsonl'), max_size_mb: 100,
    };
    saveMonitorStore(logsConfig, {
      sessions: { [sessionId]: { armed_at: Date.now(), cwd } },
    });
    return { logsConfig, cwd };
  }

  async function endSession(
    platform: string, sessionId: string, logsConfig: CollectorLogsConfig, cwd: string,
  ): Promise<void> {
    await dispatchCollectorEvent({
      event: 'SessionEnd',
      input: { session_id: sessionId, cwd },
      platform,
      config: {
        endpoint: '', api_key: '', timeout: 5000, protocol: 'http', enabled: false,
      } as ResolvedMetricsConfig,
      meterProvider: null,
      tracerProvider: null,
      logsConfig,
    });
  }

  it('claude-code SessionEnd still drops the arm', async () => {
    const sessionId = 'cc-session-1';
    const { logsConfig, cwd } = armedFixture(sessionId);
    await endSession('claude-code', sessionId, logsConfig, cwd);
    assert.equal(sessionId in loadMonitorStore(logsConfig).sessions, false,
      'a real session teardown must not leave the arm behind');
  });

  it('hermes SessionEnd keeps it', async () => {
    const sessionId = HERMES_SESSION;
    const { logsConfig, cwd } = armedFixture(sessionId);
    await endSession('hermes', sessionId, logsConfig, cwd);
    assert.equal(sessionId in loadMonitorStore(logsConfig).sessions, true,
      'a Hermes turn boundary must not disarm the session');
  });
});

// ── Local OTLP sink ────────────────────────────────────────────────────

interface Sink {
  url: string;
  requestCount: () => number;
  close: () => Promise<void>;
}

function startSink(): Promise<Sink> {
  return new Promise((resolve, reject) => {
    let count = 0;
    const server: Server = createServer((req, res) => {
      count++;
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/x-protobuf' });
      res.end();
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
        requestCount: () => count,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}
