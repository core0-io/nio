// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for hook-cli.js.
 *
 * Tests exercise the compiled dist CLI via a child process so we
 * catch both the TypeScript logic AND the bundling pipeline (import
 * resolution, splitting chunks, etc.). That also means the test
 * suite must run AFTER `pnpm run build` — the CI pipeline already
 * builds before `pnpm test`, and dev loop should do the same.
 *
 * All assertions are on stdout/stderr/exit-code — the CLI contract
 * that Hermes consumes.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve path to the built hook-cli.js. Test file lives in
// dist/tests/ at runtime. Scripts are bundled by bun (not tsc) into
// plugins/claude-code/skills/nio/scripts/, not dist/scripts/.
const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_CLI = join(
  HERE,
  '..',
  '..',
  'plugins',
  'claude-code',
  'skills',
  'nio',
  'scripts',
  'hook-cli.js',
);

// Isolated NIO_HOME so tests don't touch the developer's ~/.nio.
const TMP_HOME = mkdtempSync(join(tmpdir(), 'nio-hook-cli-test-'));
mkdirSync(TMP_HOME, { recursive: true });
writeFileSync(join(TMP_HOME, 'config.yaml'), `guard:
  protection_level: balanced
  confirm_action: allow
`);

after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runHookCli(
  args: string[],
  stdin?: string,
  extraEnv: Record<string, string> = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [HOOK_CLI, ...args], {
      env: { ...process.env, NIO_HOME: TMP_HOME, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ stdout, stderr, code }));
    if (stdin !== undefined) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    } else {
      proc.stdin.end();
    }
  });
}

function hermesEnvelope(toolName: string, toolInput: Record<string, unknown>) {
  return JSON.stringify({
    hook_event_name: 'pre_tool_call',
    tool_name: toolName,
    tool_input: toolInput,
    session_id: 'test-sess',
    cwd: '/tmp',
    extra: {},
  });
}

// ── --platform hermes: deny path ──────────────────────────────────────

describe('hook-cli --platform hermes: deny', () => {
  it('emits Hermes-shaped block on dangerous exec_command', async () => {
    const payload = hermesEnvelope('terminal', { command: 'rm -rf /' });
    const { stdout, code } = await runHookCli(
      ['--platform', 'hermes', '--stdin'],
      payload,
    );
    assert.equal(code, 0, `unexpected exit ${code}, stderr follows`);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.decision, 'block');
    assert.ok(typeof parsed.reason === 'string' && parsed.reason.length > 0);
  });

  it('accepts envelope via --envelope flag (equivalent to --stdin)', async () => {
    const payload = hermesEnvelope('terminal', { command: 'rm -rf /' });
    const { stdout, code } = await runHookCli(
      ['--platform', 'hermes', '--envelope', payload],
    );
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.decision, 'block');
  });
});

// ── --platform hermes: allow path ─────────────────────────────────────

describe('hook-cli --platform hermes: allow', () => {
  it('emits {} on safe exec_command', async () => {
    const payload = hermesEnvelope('terminal', { command: 'ls /tmp' });
    const { stdout, code } = await runHookCli(
      ['--platform', 'hermes', '--stdin'],
      payload,
    );
    assert.equal(code, 0);
    assert.equal(stdout.trim(), '{}');
  });

  it('emits {} for unmapped tool (Phase 0 pass-through)', async () => {
    const payload = hermesEnvelope('delegate_task', {});
    const { stdout, code } = await runHookCli(
      ['--platform', 'hermes', '--stdin'],
      payload,
    );
    assert.equal(code, 0);
    assert.equal(stdout.trim(), '{}');
  });
});

// ── --platform hermes: ask × confirm_action matrix ────────────────────

describe('hook-cli --platform hermes: ask maps through confirm_action', () => {
  // Use a strict-level config so borderline scores trigger `ask` under
  // balanced but `deny` under strict. A command like `sudo apt-get
  // install nginx` typically lands in the confirm/ask zone with the
  // built-in rules at balanced level.
  //
  // To keep the test deterministic we rely on a marker command that
  // Phase 2 flags as "confirm" under `balanced`. Inspecting the rule
  // set, SYSTEM_COMMAND (severity high) scores ~0.675 which is
  // above balanced's 0.5 confirm threshold and below 0.8 deny.
  //
  // In the test fixture we use a deliberate confirm-zone command.
  // If the rule tuning shifts in the future, this may need updating
  // (and would be caught by the assertion).

  function writeConfigWith(confirmAction: 'allow' | 'deny' | 'ask'): string {
    const home = mkdtempSync(join(tmpdir(), 'nio-hook-cli-confirm-'));
    writeFileSync(join(home, 'config.yaml'), `guard:
  protection_level: balanced
  confirm_action: ${confirmAction}
`);
    return home;
  }

  const CONFIRM_CMD = 'sudo apt-get install nginx';

  it('ask + confirm_action:allow → emits {} (pass-through)', async () => {
    const home = writeConfigWith('allow');
    try {
      const payload = hermesEnvelope('terminal', { command: CONFIRM_CMD });
      const { stdout, code } = await runHookCli(
        ['--platform', 'hermes', '--stdin'],
        payload,
        { NIO_HOME: home },
      );
      assert.equal(code, 0);
      assert.equal(stdout.trim(), '{}');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('ask + confirm_action:deny → emits block JSON', async () => {
    const home = writeConfigWith('deny');
    try {
      const payload = hermesEnvelope('terminal', { command: CONFIRM_CMD });
      const { stdout, code } = await runHookCli(
        ['--platform', 'hermes', '--stdin'],
        payload,
        { NIO_HOME: home },
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.decision, 'block');
      assert.ok(typeof parsed.reason === 'string');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('ask + confirm_action:ask → emits block JSON and warns on stderr', async () => {
    const home = writeConfigWith('ask');
    try {
      const payload = hermesEnvelope('terminal', { command: CONFIRM_CMD });
      const { stdout, stderr, code } = await runHookCli(
        ['--platform', 'hermes', '--stdin'],
        payload,
        { NIO_HOME: home },
      );
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.decision, 'block');
      assert.match(stderr, /ask.*not supported on Hermes/i);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ── Error paths / fail-open semantics ─────────────────────────────────

describe('hook-cli --platform hermes: errors', () => {
  it('exits 1 with empty stdout when stdin is malformed JSON', async () => {
    const { stdout, stderr, code } = await runHookCli(
      ['--platform', 'hermes', '--stdin'],
      'not valid json',
    );
    assert.equal(code, 1);
    assert.equal(stdout.trim(), '');
    assert.match(stderr, /invalid JSON/i);
  });

  it('exits 1 when neither --stdin nor --envelope provided', async () => {
    const { stdout, stderr, code } = await runHookCli(
      ['--platform', 'hermes'],
    );
    assert.equal(code, 1);
    assert.equal(stdout.trim(), '');
    assert.match(stderr, /--stdin or --envelope/i);
  });

  it('exits 1 when --platform is unsupported', async () => {
    const payload = hermesEnvelope('terminal', { command: 'ls' });
    const { stdout, stderr, code } = await runHookCli(
      ['--platform', 'nonexistent', '--stdin'],
      payload,
    );
    assert.equal(code, 1);
    assert.equal(stdout.trim(), '');
    assert.match(stderr, /unsupported --platform/i);
  });

  it('exits 1 and prints usage when --platform missing', async () => {
    const { stdout, stderr, code } = await runHookCli([]);
    assert.equal(code, 1);
    assert.equal(stdout.trim(), '');
    assert.match(stderr, /Usage/);
  });
});

// ── Input parsing ─────────────────────────────────────────────────────

describe('hook-cli --platform hermes: stdin handling', () => {
  it('reads multi-line JSON from stdin correctly', async () => {
    const prettyJson = JSON.stringify(
      JSON.parse(hermesEnvelope('terminal', { command: 'ls /tmp' })),
      null,
      2,
    );
    const { stdout, code } = await runHookCli(
      ['--platform', 'hermes', '--stdin'],
      prettyJson,
    );
    assert.equal(code, 0);
    assert.equal(stdout.trim(), '{}');
  });
});

// ── Collector path: non-pre_tool_call events ──────────────────────────
//
// hook-cli dispatches based on hook_event_name from stdin:
//   pre_tool_call → guard pipeline (covered above)
//   anything else → collector pipeline (audit + OTEL traces/metrics)
// Collector path always emits {} — telemetry never blocks Hermes.

describe('hook-cli --platform hermes: collector path', () => {
  function makeEnvelope(eventName: string, extras: Record<string, unknown> = {}) {
    return JSON.stringify({
      hook_event_name: eventName,
      session_id: 'collector-test-sess',
      cwd: '/tmp',
      ...extras,
    });
  }

  it('post_tool_call emits {} silently', async () => {
    const payload = makeEnvelope('post_tool_call', {
      tool_name: 'terminal',
      tool_input: { command: 'ls /tmp' },
      extra: { tool_call_id: 'tc-1', result: { output: 'a\nb\nc' } },
    });
    const { stdout, code } = await runHookCli(
      ['--platform', 'hermes', '--stdin'],
      payload,
    );
    assert.equal(code, 0);
    assert.equal(stdout.trim(), '{}');
  });

  it('pre_llm_call emits {} silently', async () => {
    const payload = makeEnvelope('pre_llm_call', {
      extra: { user_message: 'hello world', is_first_turn: true },
    });
    const { stdout, code } = await runHookCli(
      ['--platform', 'hermes', '--stdin'],
      payload,
    );
    assert.equal(code, 0);
    assert.equal(stdout.trim(), '{}');
  });

  it('post_llm_call emits {} silently', async () => {
    const payload = makeEnvelope('post_llm_call', { extra: {} });
    const { stdout, code } = await runHookCli(
      ['--platform', 'hermes', '--stdin'],
      payload,
    );
    assert.equal(code, 0);
    assert.equal(stdout.trim(), '{}');
  });

  it('on_session_start emits {} silently', async () => {
    const payload = makeEnvelope('on_session_start', { extra: {} });
    const { stdout, code } = await runHookCli(
      ['--platform', 'hermes', '--stdin'],
      payload,
    );
    assert.equal(code, 0);
    assert.equal(stdout.trim(), '{}');
  });

  it('on_session_end emits {} silently', async () => {
    const payload = makeEnvelope('on_session_end', { extra: {} });
    const { stdout, code } = await runHookCli(
      ['--platform', 'hermes', '--stdin'],
      payload,
    );
    assert.equal(code, 0);
    assert.equal(stdout.trim(), '{}');
  });

  it('subagent_stop emits {} silently', async () => {
    const payload = makeEnvelope('subagent_stop', {
      extra: { parent_session_id: 'parent', task_id: 'tk-1' },
    });
    const { stdout, code } = await runHookCli(
      ['--platform', 'hermes', '--stdin'],
      payload,
    );
    assert.equal(code, 0);
    assert.equal(stdout.trim(), '{}');
  });

  it('unknown event still emits {} (forward-compat with future Hermes events)', async () => {
    const payload = makeEnvelope('on_some_future_event', {});
    const { stdout, code } = await runHookCli(
      ['--platform', 'hermes', '--stdin'],
      payload,
    );
    assert.equal(code, 0);
    assert.equal(stdout.trim(), '{}');
  });

  it('collector events do NOT block even on dangerous-looking tool input', async () => {
    // post_tool_call would carry the same dangerous command as a
    // pre_tool_call would, but post is observational only — never
    // blocks. Regression guard against any future code path that
    // accidentally routes a non-pre event into the guard pipeline.
    const payload = makeEnvelope('post_tool_call', {
      tool_name: 'terminal',
      tool_input: { command: 'rm -rf /' },
      extra: { result: { error: 'permission denied' } },
    });
    const { stdout, code } = await runHookCli(
      ['--platform', 'hermes', '--stdin'],
      payload,
    );
    assert.equal(code, 0);
    assert.equal(stdout.trim(), '{}');
  });
});
