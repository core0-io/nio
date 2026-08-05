// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Wiring tests for NIO_DUMP_PAYLOAD across all four hook entry points
 * (collector-hook.ts / guard-hook.ts / hook-cli.ts / scanner-hook.ts) plus
 * the OpenClaw plugin's handlers.
 *
 * payload-dump.test.ts already pins `dumpPayload()`'s own behaviour in
 * isolation. That's not enough on its own: a call site can be deleted, or
 * never wired in the first place, and an isolated unit test of the
 * function would stay green regardless. These tests instead drive each
 * real entry point (spawning the bundled CLI scripts the same way
 * hook-cli.test.ts / monitor-scanner-hook.test.ts do, and invoking the
 * OpenClaw plugin's registered handlers in-process the same way
 * monitor-openclaw.test.ts does) and assert a dump file actually lands
 * with content matching what that entry point received.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(HERE, '..', '..', 'plugins', 'claude-code', 'skills', 'nio', 'scripts');
const COLLECTOR_HOOK = join(SCRIPTS_DIR, 'collector-hook.js');
const GUARD_HOOK = join(SCRIPTS_DIR, 'guard-hook.js');
const HOOK_CLI = join(SCRIPTS_DIR, 'hook-cli.js');
const SCANNER_HOOK = join(SCRIPTS_DIR, 'scanner-hook.js');

const cleanupDirs: string[] = [];
after(() => {
  for (const d of cleanupDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

/** Isolated NIO_HOME with no OTLP endpoint configured, so hooks never touch the network. */
function nioHome(): string {
  const home = freshDir('nio-dump-home-');
  writeFileSync(join(home, 'config.yaml'), `guard:\n  protection_level: balanced\n  confirm_action: allow\n`, 'utf-8');
  return home;
}

function dumpFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
}

function readDump(dir: string, filename: string): unknown {
  return JSON.parse(readFileSync(join(dir, filename), 'utf-8'));
}

interface RunResult { stdout: string; stderr: string; code: number | null }

/** Timeout guard so a hang in any of these hooks fails fast instead of stalling CI. */
const RUN_TIMEOUT_MS = 15000;

function run(cliPath: string, args: string[], stdin: string, env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      reject(new Error(`${cliPath} timed out after ${RUN_TIMEOUT_MS}ms; stderr so far: ${stderr}`));
    }, RUN_TIMEOUT_MS);
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    proc.stdin.write(stdin);
    proc.stdin.end();
  });
}

// ── collector-hook.ts ───────────────────────────────────────────────────

describe('NIO_DUMP_PAYLOAD wiring: collector-hook.ts', () => {
  it('dumps the raw stdin payload when NIO_DUMP_PAYLOAD is set', async () => {
    const home = nioHome();
    const dumpDir = freshDir('nio-dump-collector-');
    const payload = {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-collector-dump',
      cwd: '/tmp',
      tool_name: 'Bash',
      tool_input: { command: 'ls /tmp' },
    };

    const { code, stderr } = await run(COLLECTOR_HOOK, [], JSON.stringify(payload), {
      NIO_HOME: home,
      NIO_DUMP_PAYLOAD: dumpDir,
    });
    assert.equal(code, 0, `hook should exit 0; stderr: ${stderr}`);

    const files = dumpFiles(dumpDir);
    assert.equal(files.length, 1, `expected exactly one dump file, got: ${files.join(', ')}`);
    assert.match(files[0]!, /^\d+-claude-code-PreToolUse-[0-9a-f]{6}\.json$/);
    assert.deepEqual(readDump(dumpDir, files[0]!), payload);
  });

  it('dumps nothing when NIO_DUMP_PAYLOAD is unset', async () => {
    const home = nioHome();
    const dumpDir = freshDir('nio-dump-collector-unset-');
    const payload = {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-collector-nodump',
      cwd: '/tmp',
      tool_name: 'Bash',
      tool_input: { command: 'ls /tmp' },
    };

    // dumpDir exists but is never referenced via env — proves the hook
    // doesn't dump to some other implicit location either.
    const { code, stderr } = await run(COLLECTOR_HOOK, [], JSON.stringify(payload), {
      NIO_HOME: home,
    });
    assert.equal(code, 0, `hook should exit 0; stderr: ${stderr}`);
    assert.deepEqual(dumpFiles(dumpDir), []);
  });
});

// ── guard-hook.ts ────────────────────────────────────────────────────────

describe('NIO_DUMP_PAYLOAD wiring: guard-hook.ts', () => {
  it('dumps the raw stdin payload on the allow path', async () => {
    const home = nioHome();
    const dumpDir = freshDir('nio-dump-guard-');
    const payload = {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-guard-dump',
      cwd: '/tmp',
      tool_name: 'Bash',
      tool_input: { command: 'ls /tmp' },
    };

    const { code, stderr } = await run(GUARD_HOOK, [], JSON.stringify(payload), {
      NIO_HOME: home,
      NIO_DUMP_PAYLOAD: dumpDir,
    });
    assert.equal(code, 0, `hook should exit 0 on an allow decision; stderr: ${stderr}`);

    const files = dumpFiles(dumpDir);
    assert.equal(files.length, 1, `expected exactly one dump file, got: ${files.join(', ')}`);
    assert.deepEqual(readDump(dumpDir, files[0]!), payload);
  });

  it('still dumps on the deny path (exit code 2)', async () => {
    const home = nioHome();
    const dumpDir = freshDir('nio-dump-guard-deny-');
    const payload = {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-guard-deny-dump',
      cwd: '/tmp',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
    };

    const { code, stderr } = await run(GUARD_HOOK, [], JSON.stringify(payload), {
      NIO_HOME: home,
      NIO_DUMP_PAYLOAD: dumpDir,
    });
    assert.equal(code, 2, 'rm -rf / should be denied');
    assert.ok(stderr.length > 0);

    const files = dumpFiles(dumpDir);
    assert.equal(files.length, 1, 'dump must happen regardless of the guard decision');
    assert.deepEqual(readDump(dumpDir, files[0]!), payload);
  });

  it('dumps nothing when NIO_DUMP_PAYLOAD is unset', async () => {
    const home = nioHome();
    const dumpDir = freshDir('nio-dump-guard-unset-');
    const payload = {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-guard-nodump',
      cwd: '/tmp',
      tool_name: 'Bash',
      tool_input: { command: 'ls /tmp' },
    };

    const { code, stderr } = await run(GUARD_HOOK, [], JSON.stringify(payload), {
      NIO_HOME: home,
    });
    assert.equal(code, 0, `stderr: ${stderr}`);
    assert.deepEqual(dumpFiles(dumpDir), []);
  });
});

// ── hook-cli.ts (Hermes) — both the guard branch and the collector branch ──

describe('NIO_DUMP_PAYLOAD wiring: hook-cli.ts (Hermes)', () => {
  it('dumps the full envelope on the guard branch (pre_tool_call)', async () => {
    const home = nioHome();
    const dumpDir = freshDir('nio-dump-hermes-guard-');
    const payload = {
      hook_event_name: 'pre_tool_call',
      session_id: 'sess-hermes-guard-dump',
      cwd: '/tmp',
      tool_name: 'terminal',
      tool_input: { command: 'ls /tmp' },
      extra: {},
    };

    const { code, stderr } = await run(HOOK_CLI, ['--platform', 'hermes', '--stdin'], JSON.stringify(payload), {
      NIO_HOME: home,
      NIO_DUMP_PAYLOAD: dumpDir,
    });
    assert.equal(code, 0, `stderr: ${stderr}`);

    const files = dumpFiles(dumpDir);
    assert.equal(files.length, 1, `expected exactly one dump file, got: ${files.join(', ')}`);
    assert.match(files[0]!, /^\d+-hermes-pre_tool_call-[0-9a-f]{6}\.json$/);
    assert.deepEqual(readDump(dumpDir, files[0]!), payload);
  });

  it('dumps the full envelope on the collector branch (post_tool_call)', async () => {
    const home = nioHome();
    const dumpDir = freshDir('nio-dump-hermes-collector-');
    const payload = {
      hook_event_name: 'post_tool_call',
      session_id: 'sess-hermes-collector-dump',
      cwd: '/tmp',
      tool_name: 'terminal',
      tool_input: { command: 'ls /tmp' },
      extra: { tool_call_id: 'tc-1', result: { output: 'a\nb\nc' } },
    };

    const { code, stderr } = await run(HOOK_CLI, ['--platform', 'hermes', '--stdin'], JSON.stringify(payload), {
      NIO_HOME: home,
      NIO_DUMP_PAYLOAD: dumpDir,
    });
    assert.equal(code, 0, `stderr: ${stderr}`);

    const files = dumpFiles(dumpDir);
    assert.equal(files.length, 1, `expected exactly one dump file, got: ${files.join(', ')}`);
    assert.match(files[0]!, /^\d+-hermes-post_tool_call-[0-9a-f]{6}\.json$/);
    assert.deepEqual(readDump(dumpDir, files[0]!), payload);
  });

  it('dumps nothing on either branch when NIO_DUMP_PAYLOAD is unset', async () => {
    const home = nioHome();
    const dumpDir = freshDir('nio-dump-hermes-unset-');
    const guardPayload = {
      hook_event_name: 'pre_tool_call',
      session_id: 'sess-hermes-unset-guard',
      cwd: '/tmp',
      tool_name: 'terminal',
      tool_input: { command: 'ls /tmp' },
      extra: {},
    };
    const collectorPayload = {
      hook_event_name: 'post_tool_call',
      session_id: 'sess-hermes-unset-collector',
      cwd: '/tmp',
      extra: {},
    };

    const guardRes = await run(HOOK_CLI, ['--platform', 'hermes', '--stdin'], JSON.stringify(guardPayload), { NIO_HOME: home });
    assert.equal(guardRes.code, 0, `stderr: ${guardRes.stderr}`);
    const collectorRes = await run(HOOK_CLI, ['--platform', 'hermes', '--stdin'], JSON.stringify(collectorPayload), { NIO_HOME: home });
    assert.equal(collectorRes.code, 0, `stderr: ${collectorRes.stderr}`);

    assert.deepEqual(dumpFiles(dumpDir), []);
  });
});

// ── scanner-hook.ts (SessionStart) ─────────────────────────────────────

describe('NIO_DUMP_PAYLOAD wiring: scanner-hook.ts', () => {
  it('dumps the SessionStart payload even when no skills are installed', async () => {
    const home = nioHome();
    const dumpDir = freshDir('nio-dump-scanner-');
    // An empty fake $HOME means discoverSkills() finds nothing and the
    // hook exits early right after — but the dump call happens before
    // that early exit, so this also proves dump ordering: it must not be
    // conditioned on "found at least one skill to scan".
    const fakeHome = freshDir('nio-dump-scanner-fakehome-');
    const payload = {
      hook_event_name: 'SessionStart',
      source: 'startup',
      session_id: 'sess-scanner-dump',
      cwd: '/tmp',
    };

    const { code, stderr } = await run(SCANNER_HOOK, ['--platform', 'claude-code'], JSON.stringify(payload), {
      NIO_HOME: home,
      HOME: fakeHome,
      NIO_DUMP_PAYLOAD: dumpDir,
    });
    assert.equal(code, 0, `stderr: ${stderr}`);

    const files = dumpFiles(dumpDir);
    assert.equal(files.length, 1, `expected exactly one dump file, got: ${files.join(', ')}`);
    assert.match(files[0]!, /^\d+-claude-code-SessionStart-[0-9a-f]{6}\.json$/);
    assert.deepEqual(readDump(dumpDir, files[0]!), payload);
  });

  it('dumps nothing when NIO_DUMP_PAYLOAD is unset', async () => {
    const home = nioHome();
    const dumpDir = freshDir('nio-dump-scanner-unset-');
    const fakeHome = freshDir('nio-dump-scanner-unset-fakehome-');
    const payload = {
      hook_event_name: 'SessionStart',
      source: 'startup',
      session_id: 'sess-scanner-nodump',
      cwd: '/tmp',
    };

    const { code, stderr } = await run(SCANNER_HOOK, ['--platform', 'claude-code'], JSON.stringify(payload), {
      NIO_HOME: home,
      HOME: fakeHome,
    });
    assert.equal(code, 0, `stderr: ${stderr}`);
    assert.deepEqual(dumpFiles(dumpDir), []);
  });
});

// ── openclaw-plugin.ts — in-process, mirrors monitor-openclaw.test.ts ────

describe('NIO_DUMP_PAYLOAD wiring: openclaw-plugin.ts', () => {
  function makeFakeApi() {
    const handlers = new Map<string, (e: unknown, c?: unknown) => Promise<unknown> | unknown>();
    return {
      api: { on(name: string, h: (e: unknown, c?: unknown) => Promise<unknown> | unknown) { handlers.set(name, h); } },
      handlers,
    };
  }

  async function withPlugin(
    body: (handlers: Map<string, (e: unknown, c?: unknown) => Promise<unknown> | unknown>) => Promise<void>,
  ): Promise<void> {
    const home = freshDir('nio-dump-oc-home-');
    writeFileSync(join(home, 'config.yaml'), `guard:\n  protection_level: balanced\n  confirm_action: allow\n`, 'utf-8');

    const prevHome = process.env['NIO_HOME'];
    process.env['NIO_HOME'] = home;
    try {
      const { registerOpenClawPlugin } = await import('../adapters/openclaw-plugin.js');
      const { api, handlers } = makeFakeApi();
      registerOpenClawPlugin(api);
      await body(handlers);
    } finally {
      if (prevHome === undefined) delete process.env['NIO_HOME'];
      else process.env['NIO_HOME'] = prevHome;
    }
  }

  it('before_tool_call dumps {event, ctx} when NIO_DUMP_PAYLOAD is set', async () => {
    const dumpDir = freshDir('nio-dump-oc-before-tool-');
    const prevDump = process.env['NIO_DUMP_PAYLOAD'];
    process.env['NIO_DUMP_PAYLOAD'] = dumpDir;
    try {
      await withPlugin(async (handlers) => {
        const beforeToolCall = handlers.get('before_tool_call')!;
        const event = { toolName: 'terminal', params: { command: 'ls /tmp' }, toolCallId: 'tc-dump-1' };
        const ctx = { sessionKey: 'sess-oc-dump-1' };
        await beforeToolCall(event, ctx);

        const files = dumpFiles(dumpDir);
        assert.equal(files.length, 1, `expected exactly one dump file, got: ${files.join(', ')}`);
        assert.match(files[0]!, /^\d+-openclaw-before_tool_call-[0-9a-f]{6}\.json$/);
        assert.deepEqual(readDump(dumpDir, files[0]!), { event, ctx });
      });
    } finally {
      if (prevDump === undefined) delete process.env['NIO_DUMP_PAYLOAD'];
      else process.env['NIO_DUMP_PAYLOAD'] = prevDump;
    }
  });

  it('llm_output dumps {event, ctx} when NIO_DUMP_PAYLOAD is set', async () => {
    const dumpDir = freshDir('nio-dump-oc-llm-output-');
    const prevDump = process.env['NIO_DUMP_PAYLOAD'];
    process.env['NIO_DUMP_PAYLOAD'] = dumpDir;
    try {
      await withPlugin(async (handlers) => {
        const llmOutput = handlers.get('llm_output')!;
        const event = { assistantTexts: ['hello there'], usage: { input: 10, output: 5 } };
        const ctx = { sessionKey: 'sess-oc-dump-2' };
        await llmOutput(event, ctx);

        const files = dumpFiles(dumpDir);
        assert.equal(files.length, 1, `expected exactly one dump file, got: ${files.join(', ')}`);
        assert.match(files[0]!, /^\d+-openclaw-llm_output-[0-9a-f]{6}\.json$/);
        assert.deepEqual(readDump(dumpDir, files[0]!), { event, ctx });
      });
    } finally {
      if (prevDump === undefined) delete process.env['NIO_DUMP_PAYLOAD'];
      else process.env['NIO_DUMP_PAYLOAD'] = prevDump;
    }
  });

  it('before_tool_call dumps nothing when NIO_DUMP_PAYLOAD is unset', async () => {
    const dumpDir = freshDir('nio-dump-oc-unset-');
    // Deliberately not setting NIO_DUMP_PAYLOAD.
    await withPlugin(async (handlers) => {
      const beforeToolCall = handlers.get('before_tool_call')!;
      const event = { toolName: 'terminal', params: { command: 'ls /tmp' }, toolCallId: 'tc-dump-3' };
      const ctx = { sessionKey: 'sess-oc-dump-3' };
      await beforeToolCall(event, ctx);
      assert.deepEqual(dumpFiles(dumpDir), []);
    });
  });
});
