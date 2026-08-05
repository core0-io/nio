// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * The monitor gate on hook-cli's Hermes GUARD path (`pre_tool_call`).
 *
 * Found by mutation, not by reading: replacing the session id handed to
 * `isSessionMonitored` in that branch with a literal that is never armed
 * left the whole 1530-test suite green. Every existing Hermes monitor
 * test drives `post_tool_call` / `on_session_start` — the collector path
 * (`runHermesCollector`) — so the guard branch's own gate, its own
 * provider construction and its own state write were entirely unpinned.
 * A leak there means an unarmed Hermes session's PreToolUse telemetry
 * ships anyway.
 *
 * The observable used here is the on-disk trace state shard rather than
 * the wire, for the same reason monitor-e2e.test.ts uses it on Claude
 * Code: in the guard branch `saveState` sits behind `if (tracerProvider)`
 * and `tracerProvider` is strictly co-conditioned on `monitored`, so the
 * shard's existence is an exact, race-free readout of the gate's answer.
 * An OTLP sink would add network timing for no extra discrimination —
 * and on the allow path the guard branch emits no span at all, so
 * `/v1/traces` would be silent either way.
 *
 * `collector.endpoint` still points at a closed port so that a leaked
 * exporter fails fast instead of the test quietly depending on a real
 * collector being absent.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempDir } from './helpers/tmp-dirs.js';
import { runHermesHookAsync } from './helpers/hermes-hook.js';

function freshHome(): string {
  const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-hermes-guard-gate-')));
  writeFileSync(join(home, 'config.yaml'), `guard:
  protection_level: balanced
  confirm_action: allow
collector:
  endpoint: "http://127.0.0.1:19999"
`, 'utf-8');
  return home;
}

/** Arm a session directly in the store, as monitor-cli's `on` would. */
function armSession(home: string, sessionId: string): void {
  writeFileSync(join(home, 'monitored-sessions.json'), JSON.stringify({
    sessions: { [sessionId]: { armed_at: Date.now(), cwd: home } },
  }), 'utf-8');
}

/** The state store is sharded per session; match on the shared prefix. */
function stateShards(home: string): string[] {
  return readdirSync(home).filter((f) => f.startsWith('traces-state-store-'));
}

function preToolCall(home: string, sessionId: string, command: string): unknown {
  return {
    hook_event_name: 'pre_tool_call',
    tool_name: 'terminal',
    tool_input: { command },
    session_id: sessionId,
    cwd: home,
    extra: {},
  };
}

describe('hermes guard path (pre_tool_call): monitor gate', () => {
  it('an armed session writes trace state; an unarmed one in the same home writes none', async () => {
    // Two homes rather than two sessions in one home: the assertion is
    // "did ANY shard appear", and one home holding both sessions could
    // not tell whose shard it was.
    const armedHome = freshHome();
    armSession(armedHome, 'sess-hermes-guard-armed');
    const armedOut = await runHermesHookAsync(
      armedHome, preToolCall(armedHome, 'sess-hermes-guard-armed', 'ls /tmp'),
    );
    assert.equal(armedOut.trim(), '{}', 'a benign command must still be allowed');
    assert.equal(
      stateShards(armedHome).length, 1,
      'an armed session must open the pending-span state the eventual post_tool_call needs',
    );

    const unarmedHome = freshHome();
    const unarmedOut = await runHermesHookAsync(
      unarmedHome, preToolCall(unarmedHome, 'sess-hermes-guard-unarmed', 'ls /tmp'),
    );
    assert.equal(unarmedOut.trim(), '{}');
    assert.deepEqual(
      stateShards(unarmedHome), [],
      'an unarmed session must not get a tracer provider, and therefore must not write trace state',
    );
  });

  it('enforcement is never gated: an unarmed session is still blocked', async () => {
    const home = freshHome();
    const out = await runHermesHookAsync(
      home, preToolCall(home, 'sess-hermes-guard-deny', 'rm -rf /'),
    );
    const parsed = JSON.parse(out.trim()) as { decision?: string; reason?: string };
    assert.equal(
      parsed.decision, 'block',
      'the monitor gate controls telemetry only — Phase 0-6 evaluation runs unconditionally',
    );
    assert.ok((parsed.reason ?? '').length > 0, 'a block must carry a reason');
    assert.deepEqual(
      stateShards(home), [],
      'and the deny still exports nothing for an unarmed session',
    );
  });
});
