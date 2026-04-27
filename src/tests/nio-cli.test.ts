// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve path to the built nio-cli.js. Test file lives in dist/tests/
// at runtime; the bundled CLI lives in the Hermes plugin scripts dir.
const HERE = dirname(fileURLToPath(import.meta.url));
const NIO_CLI = join(
  HERE, '..', '..', 'plugins', 'hermes', 'scripts', 'nio-cli.js',
);

// Isolated NIO_HOME so tests don't touch the developer's ~/.nio.
// We don't clean up — OS reaps /tmp; keeping the test file free of
// filesystem-destructive calls so Nio's own Phase 4 behavioural
// analyser doesn't (correctly) flag this file.
const TMP_HOME = mkdtempSync(join(tmpdir(), 'nio-cli-test-'));
mkdirSync(TMP_HOME, { recursive: true });
writeFileSync(join(TMP_HOME, 'config.yaml'), `guard:
  protection_level: balanced
  confirm_action: allow
`);

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runCli(args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [NIO_CLI, ...args], {
      env: { ...process.env, NIO_HOME: TMP_HOME },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ stdout, stderr, code }));
    proc.stdin.end();
  });
}

// ── Subcommand routing ────────────────────────────────────────────────

describe('nio-cli: subcommand routing', () => {
  it('empty argv defaults to config show', async () => {
    const { stdout, code } = await runCli([]);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.ok(parsed.guard, 'expected guard section in config');
    assert.equal(parsed.guard.protection_level, 'balanced');
  });

  it('config show prints config JSON', async () => {
    const { stdout, code } = await runCli(['config', 'show']);
    assert.equal(code, 0);
    assert.ok(stdout.startsWith('{'));
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.guard.protection_level, 'balanced');
  });

  it('config show works as single-arg (Python plugin invocation style)', async () => {
    // Python plugin passes the whole user input as one argv arg —
    // exercise the join('') path.
    const { stdout, code } = await runCli(['config show']);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.ok(parsed.guard);
  });

  it('action subcommand routes to evaluator', async () => {
    const { stdout, code } = await runCli([
      'action', 'exec_command:', 'ls', '/tmp',
    ]);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.ok(['allow', 'deny', 'confirm'].includes(parsed.decision));
  });

  it('action with quoted single-arg (Python plugin invocation)', async () => {
    const { stdout, code } = await runCli(['action exec_command: ls /tmp']);
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout);
    assert.ok(parsed.decision);
  });

  it('report subcommand returns audit summary text', async () => {
    const { stdout, code } = await runCli(['report']);
    assert.equal(code, 0);
    // Report against an empty NIO_HOME tmp — handler still produces
    // some text, never throws. We only assert it ran cleanly.
    assert.ok(typeof stdout === 'string' && stdout.length > 0);
  });

  it('unknown subcommand returns usage text', async () => {
    const { stdout, code } = await runCli(['bogus', 'arg']);
    assert.equal(code, 0);
    assert.ok(stdout.includes('Unknown subcommand: bogus'));
    assert.ok(stdout.includes('Usage:'));
  });

  it('reset alias maps to config reset', async () => {
    const { stdout, code } = await runCli(['reset']);
    assert.equal(code, 0);
    assert.ok(stdout.includes('Config reset to defaults'));
  });
});

// ── Output shape ──────────────────────────────────────────────────────

describe('nio-cli: output shape', () => {
  it('always ends stdout with a single trailing newline', async () => {
    const { stdout } = await runCli(['config', 'show']);
    // dispatchNioCommand sometimes returns a string without a trailing
    // newline (JSON.stringify never adds one). nio-cli normalises so
    // shell consumers see a clean line-terminated stream.
    assert.ok(stdout.endsWith('\n'));
    assert.ok(!stdout.endsWith('\n\n'), 'should not double-terminate');
  });
});
