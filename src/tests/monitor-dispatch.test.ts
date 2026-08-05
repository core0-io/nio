// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * `/nio monitor` on OpenClaw and Hermes.
 *
 * Those two platforms do not install the focused `nio-*` skills (see
 * CLAUDE.md), so the unified `/nio` dispatcher is their only entry point
 * — and before this it had no `monitor` case at all. With the collector
 * now silent by default, that meant an upgraded OpenClaw or Hermes user
 * had no in-product way to ever turn telemetry back on:
 * `dispatchNioCommand('monitor on')` answered `Unknown subcommand:
 * monitor`.
 *
 * The subprocess half of this file runs the *Hermes-bundled* nio-cli.js,
 * which is the real path the Hermes Python plugin takes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatchNioCommand, type DispatchDeps } from '../adapters/openclaw-dispatch.js';
import type { ActionOrchestrator } from '../core/action-orchestrator.js';
import type { SkillScanner } from '../scanner/index.js';
import { trackTempDir } from './helpers/tmp-dirs.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const NIO_CLI = join(HERE, '..', '..', 'plugins', 'hermes', 'scripts', 'nio-cli.js');

/** Bounded so a regression can't hang CI (this repo has that history). */
const CLI_TIMEOUT_MS = 30000;

/**
 * The `monitor` case takes neither dependency — it routes straight into
 * lib/monitor-commands.ts. Passing throwing stand-ins makes that
 * explicit: if the implementation ever started reaching for the
 * orchestrator or scanner, these tests would fail loudly rather than
 * quietly exercising a different path.
 */
const DEPS: DispatchDeps = {
  get orchestrator(): ActionOrchestrator {
    throw new Error('monitor must not touch the orchestrator');
  },
  get scanner(): SkillScanner {
    throw new Error('monitor must not touch the scanner');
  },
};

// realpath: on macOS tmpdir() is under /var, a symlink to /private/var.
// A pending arm records process.cwd(), which POSIX reports resolved.
function freshHome(): string {
  return trackTempDir(realpathSync(mkdtempSync(join(tmpdir(), 'nio-monitor-dispatch-'))));
}

function storeAt(home: string): Record<string, unknown> {
  const p = join(home, 'monitored-sessions.json');
  if (!existsSync(p)) return { sessions: {} };
  return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
}

/** Extract the JSON block the dispatcher appends after its summary line. */
function parseTail(out: string): Record<string, unknown> {
  const start = out.indexOf('{');
  assert.notEqual(start, -1, `expected a JSON block in dispatcher output:\n${out}`);
  return JSON.parse(out.slice(start)) as Record<string, unknown>;
}

/**
 * Run `body` with NIO_HOME and CLAUDE_CODE_SESSION_ID pinned, restoring
 * both afterwards. The session-id var is set explicitly (not merely
 * inherited) because the developer running `pnpm test` from inside a
 * Claude Code session would otherwise flip these cases between the
 * direct-arm and pending-arm paths.
 *
 * Mutates process.env directly because the production code under test
 * reads NIO_HOME/CLAUDE_CODE_SESSION_ID from the environment with no
 * injectable seam — see helpers/with-nio-home.ts's docblock for the full
 * reasoning. Safe only under node:test's default serial-within-a-file
 * execution. try/finally restores both vars even if `body` throws.
 */
async function withEnv(
  home: string,
  sessionId: string | null,
  body: () => Promise<void>,
): Promise<void> {
  const prevHome = process.env['NIO_HOME'];
  const prevSession = process.env['CLAUDE_CODE_SESSION_ID'];
  process.env['NIO_HOME'] = home;
  if (sessionId === null) delete process.env['CLAUDE_CODE_SESSION_ID'];
  else process.env['CLAUDE_CODE_SESSION_ID'] = sessionId;
  try {
    await body();
  } finally {
    if (prevHome === undefined) delete process.env['NIO_HOME'];
    else process.env['NIO_HOME'] = prevHome;
    if (prevSession === undefined) delete process.env['CLAUDE_CODE_SESSION_ID'];
    else process.env['CLAUDE_CODE_SESSION_ID'] = prevSession;
  }
}

describe('dispatchNioCommand: monitor', () => {
  it('arms the session with `monitor on`', async () => {
    const home = freshHome();
    await withEnv(home, 'sess-dispatch-on', async () => {
      const out = await dispatchNioCommand('monitor on', DEPS);
      assert.ok(
        !out.includes('Unknown subcommand'),
        `monitor must be a known subcommand; got:\n${out}`,
      );
      const parsed = parseTail(out);
      assert.equal(parsed['action'], 'on');
      assert.equal(parsed['mode'], 'direct');
      assert.equal(parsed['session_id'], 'sess-dispatch-on');

      const store = storeAt(home) as { sessions: Record<string, unknown> };
      assert.equal('sess-dispatch-on' in store.sessions, true,
        'the arm must actually be persisted, not just reported');
    });
  });

  it('leaves a pending arm when the host exposes no session id', async () => {
    const home = freshHome();
    await withEnv(home, null, async () => {
      const out = await dispatchNioCommand('monitor on', DEPS);
      const parsed = parseTail(out);
      assert.equal(parsed['mode'], 'pending');
      const store = storeAt(home) as { pending_arm?: { cwd: string } };
      assert.equal(typeof store.pending_arm?.cwd, 'string');
    });
  });

  it('bare `monitor` means on', async () => {
    const home = freshHome();
    await withEnv(home, 'sess-dispatch-bare', async () => {
      const parsed = parseTail(await dispatchNioCommand('monitor', DEPS));
      assert.equal(parsed['action'], 'on');
    });
  });

  it('disarms with `monitor off`', async () => {
    const home = freshHome();
    await withEnv(home, 'sess-dispatch-off', async () => {
      await dispatchNioCommand('monitor on', DEPS);
      const parsed = parseTail(await dispatchNioCommand('monitor off', DEPS));
      assert.equal(parsed['action'], 'off');
      assert.equal(parsed['removed'], true);
      const store = storeAt(home) as { sessions: Record<string, unknown> };
      assert.equal('sess-dispatch-off' in store.sessions, false);
    });
  });

  it('reports state with `monitor status`', async () => {
    const home = freshHome();
    await withEnv(home, 'sess-dispatch-status', async () => {
      const before = parseTail(await dispatchNioCommand('monitor status', DEPS));
      assert.equal(before['monitored'], false);

      await dispatchNioCommand('monitor on', DEPS);
      const after = parseTail(await dispatchNioCommand('monitor status', DEPS));
      assert.equal(after['monitored'], true);
      assert.equal(after['armed_sessions'], 1);
    });
  });

  it('accepts the start/stop/show aliases the skill routing table lists', async () => {
    const home = freshHome();
    await withEnv(home, 'sess-dispatch-alias', async () => {
      assert.equal(parseTail(await dispatchNioCommand('monitor start', DEPS))['action'], 'on');
      assert.equal(parseTail(await dispatchNioCommand('monitor show', DEPS))['monitored'], true);
      assert.equal(parseTail(await dispatchNioCommand('monitor stop', DEPS))['removed'], true);
    });
  });

  it('rejects an unknown monitor subcommand without touching the store', async () => {
    const home = freshHome();
    await withEnv(home, 'sess-dispatch-bogus', async () => {
      const out = await dispatchNioCommand('monitor bogus', DEPS);
      assert.match(out, /Unknown monitor subcommand: bogus/);
      assert.equal(existsSync(join(home, 'monitored-sessions.json')), false);
    });
  });

  it('lists monitor in the usage text', async () => {
    const home = freshHome();
    await withEnv(home, null, async () => {
      const out = await dispatchNioCommand('nonsense-subcommand', DEPS);
      assert.match(out, /\/nio monitor \[on\|off\|status\]/);
    });
  });
});

// ── Hermes: the real path the Python plugin takes ──────────────────────

interface RunResult { stdout: string; stderr: string; code: number | null }

function runNioCli(args: string[], env: Record<string, string>, cwd: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [NIO_CLI, ...args], {
      env: { ...process.env, ...env },
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      reject(new Error(`nio-cli timed out after ${CLI_TIMEOUT_MS}ms; stderr: ${stderr}`));
    }, CLI_TIMEOUT_MS);
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    proc.stdin.end();
  });
}

describe('hermes nio-cli: /nio monitor', () => {
  it('arms and disarms through the bundled Hermes CLI', async () => {
    const home = freshHome();
    const env = { NIO_HOME: home, CLAUDE_CODE_SESSION_ID: 'sess-hermes-monitor' };

    const on = await runNioCli(['monitor', 'on'], env, home);
    assert.equal(on.code, 0, `stderr: ${on.stderr}`);
    assert.ok(
      !on.stdout.includes('Unknown subcommand'),
      `Hermes must be able to arm a session; got:\n${on.stdout}`,
    );
    assert.equal(parseTail(on.stdout)['mode'], 'direct');
    const store = storeAt(home) as { sessions: Record<string, unknown> };
    assert.equal('sess-hermes-monitor' in store.sessions, true);

    const status = await runNioCli(['monitor', 'status'], env, home);
    assert.equal(status.code, 0, `stderr: ${status.stderr}`);
    assert.equal(parseTail(status.stdout)['monitored'], true);

    const off = await runNioCli(['monitor', 'off'], env, home);
    assert.equal(off.code, 0, `stderr: ${off.stderr}`);
    assert.equal(parseTail(off.stdout)['removed'], true);
  });
});
