// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * /nio config import <path> integration tests.
 *
 * Driven through dispatchNioCommand() with a temp NIO_HOME so we exercise
 * the real config-load + import paths without touching the user's ~/.nio/.
 *
 * Network probes (external_analyser, collector) are pointed at local HTTP
 * servers brought up per-test so doctor-gate behaviour is deterministic.
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
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dump as yamlDump } from 'js-yaml';

import { dispatchNioCommand } from '../adapters/openclaw-dispatch.js';
import { _setDiagnosticsAuditPathForTests } from '../adapters/diagnostics.js';
import { _resetOAuthRegistryForTests } from '../core/analysers/external/auth.js';

interface MockScorerOpts {
  status?: number;
  body?: unknown;
}

function startMockScorer(opts: MockScorerOpts = {}): Promise<{ url: string; server: Server }> {
  const status = opts.status ?? 200;
  const body = JSON.stringify(opts.body ?? { score: 0.42 });
  const server = createServer((_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}/score`, server });
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise(r => server.close(() => r()));
}

let nioHome: string;
let originalNioHome: string | undefined;

before(() => {
  originalNioHome = process.env.NIO_HOME;
  nioHome = mkdtempSync(join(tmpdir(), 'nio-import-test-'));
  process.env.NIO_HOME = nioHome;
  mkdirSync(nioHome, { recursive: true });
  _setDiagnosticsAuditPathForTests(join(nioHome, 'audit.jsonl'));
});

after(() => {
  if (originalNioHome === undefined) delete process.env.NIO_HOME;
  else process.env.NIO_HOME = originalNioHome;
  _setDiagnosticsAuditPathForTests(null);
  try { rmSync(nioHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  // Wipe everything in nioHome between tests so each one starts from a known
  // baseline. We re-create the directory itself because the import path may
  // need to write into it.
  rmSync(nioHome, { recursive: true, force: true });
  mkdirSync(nioHome, { recursive: true });
});

afterEach(() => {
  _resetOAuthRegistryForTests();
});

const stubDeps = { orchestrator: {} as never, scanner: {} as never };

function writeImportSource(name: string, cfg: Record<string, unknown>): string {
  const p = join(nioHome, name);
  writeFileSync(p, yamlDump(cfg));
  return p;
}

function liveConfigYaml(): string {
  return readFileSync(join(nioHome, 'config.yaml'), 'utf8');
}

function listBackups(): string[] {
  if (!existsSync(nioHome)) return [];
  return readdirSync(nioHome).filter(f => f.startsWith('config.yaml.bak.'));
}

describe('/nio config import', () => {
  it('happy path with no probes triggered: schema-only config writes and creates backup', async () => {
    // Existing config must be present so we can verify backup is created.
    writeFileSync(join(nioHome, 'config.yaml'), yamlDump({ guard: { protection_level: 'strict' } }));
    const src = writeImportSource('incoming.yaml', { guard: { protection_level: 'balanced' } });

    const out = await dispatchNioCommand(`config import ${src}`, stubDeps);
    assert.match(out, /# config import OK/);
    assert.match(out, /Backup: .*config\.yaml\.bak\./);
    assert.match(liveConfigYaml(), /protection_level: balanced/);
    assert.equal(listBackups().length, 1);
  });

  it('first import with no existing config: writes and creates NO backup', async () => {
    const src = writeImportSource('incoming.yaml', { guard: { protection_level: 'balanced' } });

    const out = await dispatchNioCommand(`config import ${src}`, stubDeps);
    assert.match(out, /# config import OK/);
    assert.match(out, /Backup: \(no previous config\)/);
    assert.match(liveConfigYaml(), /protection_level: balanced/);
    assert.equal(listBackups().length, 0);
  });

  it('happy path with probes passing: external_analyser endpoint reachable', async () => {
    const scorer = await startMockScorer({ body: { score: 0.1 } });
    try {
      writeFileSync(join(nioHome, 'config.yaml'), yamlDump({ guard: { protection_level: 'strict' } }));
      const src = writeImportSource('incoming.yaml', {
        guard: {
          protection_level: 'balanced',
          external_analyser: [{ name: 'scorer_local', endpoint: scorer.url, weight: 1 }],
        },
      });

      const out = await dispatchNioCommand(`config import ${src}`, stubDeps);
      assert.match(out, /# config import OK/);
      assert.match(out, /✓ scorer_local.*score 0\.1/);
      assert.match(liveConfigYaml(), /scorer_local/);
      assert.equal(listBackups().length, 1);
    } finally {
      await stopServer(scorer.server);
    }
  });

  it('doctor-gate rejects unreachable external_analyser: live config untouched, no backup', async () => {
    writeFileSync(join(nioHome, 'config.yaml'), yamlDump({ guard: { protection_level: 'strict' } }));
    const src = writeImportSource('incoming.yaml', {
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

    const out = await dispatchNioCommand(`config import ${src}`, stubDeps);
    assert.match(out, /# config import REJECTED/);
    assert.match(out, /✗ dead/);
    // Live config kept its old protection_level — was NOT replaced.
    assert.match(liveConfigYaml(), /protection_level: strict/);
    assert.equal(listBackups().length, 0);
  });

  it('doctor-gate rejects llm_analyser.enabled without api_key', async () => {
    writeFileSync(join(nioHome, 'config.yaml'), yamlDump({ guard: { protection_level: 'strict' } }));
    const src = writeImportSource('incoming.yaml', {
      guard: {
        protection_level: 'balanced',
        llm_analyser: { enabled: true, api_key: '' },
      },
    });

    const out = await dispatchNioCommand(`config import ${src}`, stubDeps);
    assert.match(out, /# config import REJECTED/);
    assert.match(out, /api_key is empty/);
    assert.match(liveConfigYaml(), /protection_level: strict/);
    assert.equal(listBackups().length, 0);
  });

  it('doctor-gate rejects collector endpoint that is unreachable', async () => {
    writeFileSync(join(nioHome, 'config.yaml'), yamlDump({ guard: { protection_level: 'strict' } }));
    const src = writeImportSource('incoming.yaml', {
      guard: { protection_level: 'balanced' },
      collector: { endpoint: 'http://127.0.0.1:1', timeout: 500 },
    });

    const out = await dispatchNioCommand(`config import ${src}`, stubDeps);
    assert.match(out, /# config import REJECTED/);
    assert.match(out, /### Collector/);
    assert.match(out, /✗ http:\/\/127\.0\.0\.1:1/);
    assert.match(liveConfigYaml(), /protection_level: strict/);
    assert.equal(listBackups().length, 0);
  });

  it('file not found: returns FAILED and does not touch live config', async () => {
    writeFileSync(join(nioHome, 'config.yaml'), yamlDump({ guard: { protection_level: 'strict' } }));
    const missing = join(nioHome, 'definitely-not-here.yaml');

    const out = await dispatchNioCommand(`config import ${missing}`, stubDeps);
    assert.match(out, /# config import FAILED/);
    assert.match(out, /file not found/);
    assert.match(liveConfigYaml(), /protection_level: strict/);
    assert.equal(listBackups().length, 0);
  });

  it('malformed YAML: returns FAILED and does not touch live config', async () => {
    writeFileSync(join(nioHome, 'config.yaml'), yamlDump({ guard: { protection_level: 'strict' } }));
    const src = join(nioHome, 'bad.yaml');
    writeFileSync(src, '{ : not valid yaml :\n  - [\n');

    const out = await dispatchNioCommand(`config import ${src}`, stubDeps);
    assert.match(out, /# config import FAILED/);
    assert.match(liveConfigYaml(), /protection_level: strict/);
    assert.equal(listBackups().length, 0);
  });

  it('schema validation failure: returns FAILED and does not touch live config', async () => {
    writeFileSync(join(nioHome, 'config.yaml'), yamlDump({ guard: { protection_level: 'strict' } }));
    const src = writeImportSource('incoming.yaml', {
      guard: { protection_level: 'no-such-level' },
    });

    const out = await dispatchNioCommand(`config import ${src}`, stubDeps);
    assert.match(out, /# config import FAILED/);
    assert.match(liveConfigYaml(), /protection_level: strict/);
    assert.equal(listBackups().length, 0);
  });

  it('two imports back-to-back: distinct backup filenames', async () => {
    writeFileSync(join(nioHome, 'config.yaml'), yamlDump({ guard: { protection_level: 'strict' } }));
    const src = writeImportSource('incoming.yaml', { guard: { protection_level: 'balanced' } });

    await dispatchNioCommand(`config import ${src}`, stubDeps);
    // One second of separation guarantees distinct timestamps at second
    // granularity (which is what our stamp truncates to).
    await new Promise(r => setTimeout(r, 1100));
    await dispatchNioCommand(`config import ${src}`, stubDeps);

    const backups = listBackups();
    assert.equal(backups.length, 2, `expected 2 backups, got: ${backups.join(', ')}`);
    assert.notEqual(backups[0], backups[1]);
  });

  it('rejects empty path with usage message', async () => {
    const out = await dispatchNioCommand('config import', stubDeps);
    assert.match(out, /config import requires a path/i);
  });
});
