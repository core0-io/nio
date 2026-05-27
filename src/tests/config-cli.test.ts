// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * config-cli.js spawn-based integration tests.
 *
 * config-cli is the bundled CLI that setup.sh invokes during install when
 * the user passes --config <path>. Its `import` subcommand must:
 *   - exit 0 on success (and apply the file)
 *   - exit 1 on doctor-gate rejection (and leave the live config alone)
 *   - exit 1 on file-not-found / yaml-error / schema-error (FAILED)
 *   - exit 2 on missing path argument (usage)
 *
 * Since setup.sh keys its abort logic on the process exit code, the
 * exit code contract is what these tests exercise.
 */

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dump as yamlDump } from 'js-yaml';

import { _resetOAuthRegistryForTests } from '../core/analysers/external/auth.js';

// config-cli.js is shipped bundled (via scripts/build.js) into each plugin's
// skill dir. Tests run from dist/tests/ so we walk back to the repo root
// and pick any one of the bundled copies — they're all byte-identical.
const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_CLI = join(
  HERE, '..', '..',
  'plugins', 'claude-code', 'skills', 'nio', 'scripts', 'config-cli.js',
);

let nioHome: string;
let originalNioHome: string | undefined;

before(() => {
  originalNioHome = process.env.NIO_HOME;
  nioHome = mkdtempSync(join(tmpdir(), 'nio-config-cli-test-'));
});

after(() => {
  if (originalNioHome === undefined) delete process.env.NIO_HOME;
  else process.env.NIO_HOME = originalNioHome;
  try { rmSync(nioHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  rmSync(nioHome, { recursive: true, force: true });
  mkdirSync(nioHome, { recursive: true });
});

afterEach(() => {
  _resetOAuthRegistryForTests();
});

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runCli(args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CONFIG_CLI, ...args], {
      env: { ...process.env, NIO_HOME: nioHome },
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

function writeIncoming(name: string, cfg: Record<string, unknown>): string {
  const p = join(nioHome, name);
  writeFileSync(p, yamlDump(cfg));
  return p;
}

function listBackups(): string[] {
  return readdirSync(nioHome).filter(f => f.startsWith('config.yaml.bak.'));
}

describe('config-cli import', () => {
  it('valid file: exit 0, live config replaced, backup created', async () => {
    writeFileSync(join(nioHome, 'config.yaml'), yamlDump({ guard: { protection_level: 'strict' } }));
    const src = writeIncoming('incoming.yaml', { guard: { protection_level: 'balanced' } });

    const { stdout, code } = await runCli(['import', src]);
    assert.equal(code, 0);
    assert.match(stdout, /# config import OK/);
    assert.match(readFileSync(join(nioHome, 'config.yaml'), 'utf8'), /protection_level: balanced/);
    assert.equal(listBackups().length, 1);
  });

  it('doctor-gate rejection: exit 1, live config untouched, no backup', async () => {
    writeFileSync(join(nioHome, 'config.yaml'), yamlDump({ guard: { protection_level: 'strict' } }));
    const src = writeIncoming('incoming.yaml', {
      guard: {
        protection_level: 'balanced',
        external_analyser: [{
          name: 'dead',
          endpoint: 'http://127.0.0.1:1/score',
          timeout: 500,
          weight: 1,
        }],
      },
    });

    const { stdout, code } = await runCli(['import', src]);
    assert.equal(code, 1);
    assert.match(stdout, /# config import REJECTED/);
    assert.match(readFileSync(join(nioHome, 'config.yaml'), 'utf8'), /protection_level: strict/);
    assert.equal(listBackups().length, 0);
  });

  it('file not found: exit 1, FAILED report, no backup', async () => {
    writeFileSync(join(nioHome, 'config.yaml'), yamlDump({ guard: { protection_level: 'strict' } }));
    const { stdout, code } = await runCli(['import', join(nioHome, 'definitely-not-here.yaml')]);
    assert.equal(code, 1);
    assert.match(stdout, /# config import FAILED/);
    assert.match(stdout, /file not found/);
    assert.match(readFileSync(join(nioHome, 'config.yaml'), 'utf8'), /protection_level: strict/);
    assert.equal(listBackups().length, 0);
  });

  it('missing path argument: exit 2 with usage on stderr', async () => {
    const { stderr, code } = await runCli(['import']);
    assert.equal(code, 2);
    assert.match(stderr, /Usage: config-cli\.js import <path>/);
  });

  // Note: the "first import with no existing config" path is covered by
  // the dispatch-level test in dispatch-config-import.test.ts. We don't
  // re-test it here because the bundled config-cli.js eagerly initialises
  // a default ~/.nio/config.yaml as a side effect of module load (via
  // shared collector init chunks), which masks the "no previous config"
  // branch at the spawned-process level. The dispatcher path is the source
  // of truth — and it's tested.
});
