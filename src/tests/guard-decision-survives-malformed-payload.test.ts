// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * A malformed hook PAYLOAD must cost telemetry, never enforcement.
 *
 * ── What this adds to guard-decision-survives-malformed-tool-input ─────
 *
 * That file pins one field (`tool_input.<arg>`) and one function
 * (`toolSummary`), on the sites that run AFTER the decision. Task 1d's
 * report predicted the same "cast an unvalidated host value, then call a
 * method on it" pattern would exist elsewhere on the path. It does, in
 * three more places, all of which run BEFORE the decision — so they do
 * not merely lose a deny that was already computed, they stop it being
 * computed at all:
 *
 *   1. `parseInput`   `hookEvent.startsWith('Post')`
 *      (claude-code.ts / codex.ts / hermes.ts)
 *   2. `checkToolGate` → `parseMcpToolName`'s `name.startsWith('mcp__')`
 *      and `matchesCaseInsensitive`'s `c.toLowerCase()`, both reading
 *      `input.toolName`
 *   3. `buildEnvelope` `content.slice(0, 10_000)`
 *
 * `guard-hook.ts` reads `payload.tool_name` a second time, after the
 * decision, for the guard-decision metric and `toolSummary`. That read is
 * coerced too, but it is NOT independently killable here: every path it
 * feeds is already total (see `toolSummary`'s own coercion in
 * collector-core.ts), so no input distinguishes the two. It is
 * defence-in-depth, not a fix this file pins.
 *
 * Measured against the shipped `guard-hook.js` bundle with NO collector
 * endpoint configured, `permitted_tools: { claude_code: [Bash, Write] }`:
 *
 *   payload                                   before        after
 *   ───────────────────────────────────────   ───────────   ───────────
 *   tool_name: 12345                          exit 1 (1)    exit 2 + reason
 *   hook_event_name: 99                       exit 1 (2)    exit 2 + reason
 *   Write content: 42, sensitive path         exit 1 (3)    exit 2 + reason
 *
 * Exit 1 is Claude Code's NON-blocking error code: the tool runs. Note
 * every "before" row needed no collector at all — this is the guard's own
 * decision path, not the telemetry path.
 *
 * ── Why `permitted_tools`, not `blocked_tools` ────────────────────────
 *
 * `permitted_tools` is a strict Phase 0 allowlist, and that makes the
 * security claim exact rather than incidental: a `tool_name` that is not
 * a string is BY DEFINITION not in the allowlist, so the only correct
 * answer is deny. Before the fix the guard died instead, and every host
 * reads a dead hook as "no action" — i.e. the unlisted tool ran. A
 * `blocked_tools` denylist could not express that case, because a
 * non-string name matches no denylist entry.
 *
 * MUTATION (each independently kills a different fix):
 *   - revert `asText` on `toolName` in claude-code.ts/hermes.ts parseInput
 *     → the numeric / object / array tool_name cases go red
 *   - revert `asText` on `hookEvent` in claude-code.ts parseInput
 *     → the numeric hook_event_name case goes red
 *   - revert `asText` on the write-body reads in claude-code.ts
 *     buildEnvelope → the numeric-content case goes red
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

/** Guard-only runs: no endpoint, no network, no flush budget to wait out. */
const EXIT_BOUND_MS = 20_000;

/** 300 KB — the "very long string" leg of the acceptance matrix. */
const LONG = 'x'.repeat(300_000);

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * No `collector.endpoint` on purpose. Every case here fails on the
 * guard's OWN path, so pinning them without a collector is what proves
 * the defect is not a telemetry defect that leaked sideways.
 */
function nioHome(): string {
  const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-malformed-payload-')));
  writeFileSync(join(home, 'config.yaml'), `guard:
  protection_level: balanced
  confirm_action: deny
  permitted_tools:
    claude_code: ["Bash", "Write"]
    hermes: ["terminal"]
`, 'utf-8');
  return home;
}

/** Async spawn so every case runs concurrently. */
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

/** Claude Code's deny contract: exit 2, reason on stderr. */
function assertClaudeCodeDeny(r: RunResult, what: string): void {
  assert.ok(!r.timedOut, `${what}: guard-hook did not exit`);
  assert.equal(
    r.code, 2,
    `${what}: guard-hook exited ${r.code} instead of 2 — the deny degraded to ` +
    `Claude Code's non-blocking error code, i.e. the tool ran. ` +
    `stderr: ${r.stderr.slice(0, 400)}`,
  );
  assert.ok(r.stderr.trim().length > 0, `${what}: the deny reason must reach stderr`);
}

/** Hermes's deny contract: exit 0, `{"decision":"block"}` on stdout. */
function assertHermesBlock(r: RunResult, what: string): void {
  assert.ok(!r.timedOut, `${what}: hook-cli did not exit`);
  assert.equal(
    r.code, 0,
    `${what}: hook-cli exited ${r.code} instead of 0. stderr: ${r.stderr.slice(0, 400)}`,
  );
  assert.ok(
    r.stdout.trim().length > 0,
    `${what}: Hermes reads empty stdout as "no action" — the block must be written`,
  );
  assert.equal(JSON.parse(r.stdout.trim()).decision, 'block');
}

describe('a deny survives a malformed hook payload', () => {
  const runs = new Map<string, Promise<RunResult>>();

  const cc = (name: string, payload: Record<string, unknown>): void => {
    const home = nioHome();
    runs.set(name, runHook(GUARD_HOOK, [], home, {
      hook_event_name: 'PreToolUse', session_id: `sess-${name}`, cwd: home, ...payload,
    }));
  };
  const hermes = (name: string, payload: Record<string, unknown>): void => {
    const home = nioHome();
    runs.set(name, runHook(HOOK_CLI, ['--platform', 'hermes', '--stdin'], home, {
      hook_event_name: 'pre_tool_call', session_id: `sess-${name}`, cwd: home,
      extra: {}, ...payload,
    }));
  };

  before(() => {
    // ── Claude Code ──────────────────────────────────────────────────
    // A tool name that is not a string is not in the allowlist, so the
    // only correct answer is deny. One case per shape the acceptance
    // matrix names.
    cc('cc-number', { tool_name: 12345, tool_input: { command: 'ls /tmp' } });
    cc('cc-object', { tool_name: { server: 'x', tool: 'y' }, tool_input: {} });
    cc('cc-array', { tool_name: ['Bash'], tool_input: {} });
    cc('cc-null', { tool_name: null, tool_input: {} });
    cc('cc-empty', { tool_name: '', tool_input: {} });

    // The event name is read by `hookEvent.startsWith('Post')` in
    // parseInput — the very first statement of `evaluateHook`.
    cc('cc-event-number', { hook_event_name: 99, tool_name: 'Grep', tool_input: {} });

    // Long string on the tool_input side: the tool is unpermitted, so the
    // deny is small while the payload the guard had to carry is 300 KB.
    cc('cc-long', { tool_name: 'Grep', tool_input: { command: LONG } });

    // A permitted `Write` reaches Phase 1-6, so this one exercises
    // buildEnvelope's `content.slice(0, 10_000)`. The sensitive path is
    // inside this run's own temp NIO_HOME — nothing names or touches a
    // real user directory.
    const writeHome = nioHome();
    runs.set('cc-write-content', runHook(GUARD_HOOK, [], writeHome, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: join(writeHome, '.ssh', 'authorized_keys'), content: 42 },
      session_id: 'sess-cc-write-content',
      cwd: writeHome,
    }));
    // A non-string PATH is the other half, and it fails differently: the
    // throw lands inside the orchestrator's own try/catch, which is
    // documented to fail OPEN ("engine error → allow"). So this one never
    // exited 1 — it exited 0, silently, and the write to the sensitive
    // path went through. Coercing the array to its JSON text keeps the
    // `/.ssh/` fragment intact, so SENSITIVE_PATH still fires.
    const pathHome = nioHome();
    runs.set('cc-write-path', runHook(GUARD_HOOK, [], pathHome, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: {
        file_path: [join(pathHome, '.ssh', 'authorized_keys')],
        content: 'ssh-rsa AAAA',
      },
      session_id: 'sess-cc-write-path',
      cwd: pathHome,
    }));
    // Control for the case above: identical but with a string body, so a
    // regression that broke the SENSITIVE_PATH deny outright could not
    // read as "the malformed case still passes".
    const writeCtlHome = nioHome();
    runs.set('cc-write-control', runHook(GUARD_HOOK, [], writeCtlHome, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: join(writeCtlHome, '.ssh', 'authorized_keys'), content: 'ssh-rsa AAAA' },
      session_id: 'sess-cc-write-control',
      cwd: writeCtlHome,
    }));

    // ── Hermes ───────────────────────────────────────────────────────
    hermes('hermes-number', { tool_name: 777, tool_input: { command: 'ls /tmp' } });
    hermes('hermes-object', { tool_name: { a: 1 }, tool_input: { command: 'ls /tmp' } });
    // Control: a well-formed unpermitted call still blocks.
    hermes('hermes-control', { tool_name: 'grep', tool_input: { command: 'ls /tmp' } });
  });

  for (const [name, shape] of [
    ['cc-number', 'a numeric tool_name'],
    ['cc-object', 'a nested-object tool_name'],
    ['cc-array', 'an array tool_name'],
    ['cc-null', 'a null tool_name'],
    ['cc-empty', 'an empty-string tool_name'],
    ['cc-event-number', 'a numeric hook_event_name'],
    ['cc-long', 'a 300 KB command'],
  ] as const) {
    it(`claude code: ${shape} still exits 2 with a reason`, async () => {
      assertClaudeCodeDeny(await runs.get(name)!, name);
    });
  }

  it('claude code: a numeric Write body still reaches the sensitive-path deny', async () => {
    const r = await runs.get('cc-write-content')!;
    assertClaudeCodeDeny(r, 'cc-write-content');
    assert.match(
      r.stderr, /SENSITIVE_PATH/,
      'the deny must still come from Phase 2, not from some other failure',
    );
  });

  it('claude code: an array Write path is denied instead of failing open', async () => {
    const r = await runs.get('cc-write-path')!;
    assertClaudeCodeDeny(r, 'cc-write-path');
    assert.match(
      r.stderr, /SENSITIVE_PATH/,
      'the path text must survive coercion well enough for Phase 2 to recognise it',
    );
  });

  it('control: the same Write with a string body denies too', async () => {
    const r = await runs.get('cc-write-control')!;
    assertClaudeCodeDeny(r, 'cc-write-control');
    assert.match(r.stderr, /SENSITIVE_PATH/);
  });

  for (const [name, shape] of [
    ['hermes-number', 'a numeric tool_name'],
    ['hermes-object', 'a nested-object tool_name'],
  ] as const) {
    it(`hermes: ${shape} still reaches Hermes as a block`, async () => {
      assertHermesBlock(await runs.get(name)!, name);
    });
  }

  it('control: a well-formed unpermitted tool still blocks on Hermes', async () => {
    assertHermesBlock(await runs.get('hermes-control')!, 'hermes-control');
  });
});
