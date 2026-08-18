// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * A malformed tool argument must cost telemetry, never enforcement.
 *
 * ── The defect, reproduced end-to-end before the fix ──────────────────
 *
 * `toolSummary()` read its fields through `as string` casts and then
 * called string methods on them:
 *
 *     return ((toolInput['command'] as string) || '').slice(0, 300);
 *
 * `tool_input` is never schema-checked — it is `JSON.parse`d hook stdin.
 * A model that emits `{"command": 123}` (or `true`, or a nested object)
 * makes that line throw `TypeError: (toolInput.command || "").slice is
 * not a function`, from three places that all run AFTER the guard has
 * decided and BEFORE the decision reaches the host:
 *
 *   1. `dispatchCollectorEvent`'s `baseFields`, which is built OUTSIDE
 *      that function's own try/catch (hook-cli.ts's Hermes guard path
 *      awaits the dispatch);
 *   2. `hook-cli.ts`'s `spanKey(collectorInput)` (Hermes);
 *   3. `guard-hook.ts`'s `spanKey(payload)` (Claude Code / Codex).
 *
 * Measured against the shipped bundles, `blocked_tools` deny, identical
 * fixtures except for the type of `command`:
 *
 *   platform      command: "ls /tmp"              command: 123
 *   ───────────   ────────────────────────────    ─────────────────────
 *   hermes        exit 0, stdout                  exit 1, stdout EMPTY
 *                 {"decision":"block",…}
 *   claude code   exit 2, reason on stderr        exit 1, Node stack
 *
 * Both host contracts read that as "the hook took no action", so the
 * blocked tool runs. Site 3 fires only when a tracer provider exists
 * (monitored session + configured endpoint); site 1 fires with NO
 * endpoint at all, because the local audit leg keeps the dispatch running
 * regardless — so on Hermes every user is exposed, collector or not.
 *
 * ── What this file pins ───────────────────────────────────────────────
 *
 * Case A drives site 1 (no endpoint). Cases B and C drive sites 2 and 3
 * against RFC 5737 TEST-NET-1, which is also this task's acceptance
 * check: a completely unreachable collector must not cost the deny.
 *
 * MUTATION: restore any `argText(...)` in collector-core.ts's
 * `toolSummary` to the old `(x as string) || ''` form — case A goes red on
 * the Hermes dispatch site, cases B and C on the two `spanKey` sites.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { trackTempDir } from './helpers/tmp-dirs.js';

// The shipped bundles, not dist/ — see helpers/hermes-hook.ts for why the
// bundle and the tsc output are not interchangeable.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const HOOK_CLI = join(REPO, 'plugins', 'hermes', 'scripts', 'hook-cli.js');
const GUARD_HOOK = join(
  REPO, 'plugins', 'claude-code', 'skills', 'nio', 'scripts', 'guard-hook.js',
);

/** RFC 5737 TEST-NET-1: reserved for documentation, guaranteed unroutable. */
const UNROUTABLE_ENDPOINT = 'http://192.0.2.1:4318';

/**
 * Same sizing as collector-flush-timeout.test.ts: the flush backstop is
 * 5s, plus process start and guard evaluation. 20s leaves headroom for
 * slow CI while staying far below the 95s+ an unbounded flush blocks for.
 */
const EXIT_BOUND_MS = 20_000;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * `blocked_tools` is the deny source on purpose: it is Phase 0, keyed on
 * the tool NAME, so it fires identically whatever `tool_input` holds.
 * A risk-scored deny would need a plausible command string, which is
 * exactly the thing this test has to make malformed.
 *
 * `monitor_all_sessions: true` is load-bearing for cases B and C: both
 * hooks gate provider creation on `isSessionMonitored`, and no fixture
 * session here is ever armed — without it the tracer provider would be
 * null, `spanKey` would never be reached, and the cases would pass
 * without touching the code they exist to pin.
 */
function nioHome(endpoint: string): string {
  const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-malformed-arg-')));
  writeFileSync(join(home, 'config.yaml'), `guard:
  protection_level: balanced
  confirm_action: deny
  blocked_tools:
    claude_code: ["Bash"]
    hermes: ["terminal"]
collector:
  endpoint: "${endpoint}"
  monitor_all_sessions: true
`, 'utf-8');
  return home;
}

/** Async spawn so all three cases run concurrently. */
function runHook(cli: string, args: string[], home: string, payload: unknown): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [cli, ...args], { env: { ...process.env, NIO_HOME: home } });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, EXIT_BOUND_MS);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
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
      resolve({ code, stdout, stderr, timedOut: false });
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

describe('a deny survives a non-string tool argument', () => {
  let hermesNoEndpoint: Promise<RunResult>;
  let hermesUnroutable: Promise<RunResult>;
  let claudeCodeUnroutable: Promise<RunResult>;
  let hermesControl: Promise<RunResult>;

  before(() => {
    // A — Hermes, NO collector endpoint. Pins the site inside
    //     dispatchCollectorEvent, which the ungated local audit leg keeps
    //     reachable for every Hermes user.
    const homeA = nioHome('');
    hermesNoEndpoint = runHook(HOOK_CLI, ['--platform', 'hermes', '--stdin'], homeA, {
      hook_event_name: 'pre_tool_call',
      tool_name: 'terminal',
      tool_input: { command: 123 },
      session_id: 'sess-malformed-hermes-noep',
      cwd: homeA,
      extra: {},
    });

    // B — Hermes against a packet-dropping endpoint. Adds hook-cli's own
    //     `spanKey` site, and doubles as the unreachable-collector check.
    const homeB = nioHome(UNROUTABLE_ENDPOINT);
    hermesUnroutable = runHook(HOOK_CLI, ['--platform', 'hermes', '--stdin'], homeB, {
      hook_event_name: 'pre_tool_call',
      tool_name: 'terminal',
      tool_input: { command: { argv: ['rm', '-rf', '/'] } },
      session_id: 'sess-malformed-hermes-unroutable',
      cwd: homeB,
      extra: {},
    });

    // C — Claude Code guard-hook against the same endpoint.
    const homeC = nioHome(UNROUTABLE_ENDPOINT);
    claudeCodeUnroutable = runHook(GUARD_HOOK, [], homeC, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: true },
      session_id: 'sess-malformed-cc-unroutable',
      tool_use_id: 'tu-malformed-1',
      cwd: homeC,
    });

    // Control — the same Hermes fixture with a well-formed command, so a
    // regression that broke the deny for EVERY payload could not read as
    // "case A still passes".
    const homeD = nioHome('');
    hermesControl = runHook(HOOK_CLI, ['--platform', 'hermes', '--stdin'], homeD, {
      hook_event_name: 'pre_tool_call',
      tool_name: 'terminal',
      tool_input: { command: 'ls /tmp' },
      session_id: 'sess-malformed-hermes-control',
      cwd: homeD,
      extra: {},
    });
  });

  it('control: a well-formed command on a blocked tool blocks on Hermes', async () => {
    const r = await hermesControl;
    assert.ok(!r.timedOut, `control run did not exit; stderr: ${r.stderr.slice(0, 400)}`);
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}; stderr: ${r.stderr.slice(0, 400)}`);
    assert.equal(JSON.parse(r.stdout.trim()).decision, 'block');
  });

  it('hermes: a numeric command still reaches Hermes as a block, with no collector configured', async () => {
    const r = await hermesNoEndpoint;
    assert.ok(!r.timedOut, `hook-cli did not exit; stderr: ${r.stderr.slice(0, 400)}`);
    assert.equal(
      r.code, 0,
      `hook-cli exited ${r.code} instead of 0 — a malformed tool argument crashed the ` +
      `guard path; stderr: ${r.stderr.slice(0, 400)}`,
    );
    assert.ok(
      r.stdout.trim().length > 0,
      'Hermes reads empty stdout as "no action" — the block decision must be written',
    );
    assert.equal(JSON.parse(r.stdout.trim()).decision, 'block');
  });

  it('hermes: an object command still blocks with a packet-dropping collector', async () => {
    const r = await hermesUnroutable;
    assert.ok(!r.timedOut, `hook-cli did not exit; stderr: ${r.stderr.slice(0, 400)}`);
    assert.equal(
      r.code, 0,
      `hook-cli exited ${r.code} instead of 0; stderr: ${r.stderr.slice(0, 400)}`,
    );
    assert.ok(r.stdout.trim().length > 0, 'the block decision must be written');
    assert.equal(JSON.parse(r.stdout.trim()).decision, 'block');
  });

  it('claude code: a boolean command still exits 2 with a reason, with a packet-dropping collector', async () => {
    const r = await claudeCodeUnroutable;
    assert.ok(!r.timedOut, `guard-hook did not exit; stderr: ${r.stderr.slice(0, 400)}`);
    // Exit 2 + a stderr reason is Claude Code's deny contract; exit 1 is
    // its NON-blocking error code, i.e. the tool runs.
    assert.equal(
      r.code, 2,
      `guard-hook exited ${r.code} instead of 2 — a malformed tool argument downgraded ` +
      `a deny to a non-blocking error; stderr: ${r.stderr.slice(0, 400)}`,
    );
    assert.ok(r.stderr.trim().length > 0, 'the deny reason must reach stderr');
  });
});
