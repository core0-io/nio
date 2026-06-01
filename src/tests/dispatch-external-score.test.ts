// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * /nio external-score integration tests.
 *
 * Driven through dispatchNioCommand() with a temp NIO_HOME so we exercise the
 * real config-load + endpoint-probe paths without touching the user's ~/.nio/.
 * Mirrors the mock-scorer harness used by dispatch-doctor.test.ts.
 */

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dump as yamlDump } from 'js-yaml';

import { dispatchNioCommand } from '../adapters/openclaw-dispatch.js';
import { _setDiagnosticsAuditPathForTests } from '../adapters/diagnostics.js';
import { _resetOAuthRegistryForTests } from '../core/analysers/external/auth.js';

interface MockScorerOpts {
  status?: number;     // default 200
  body?: unknown;      // JSON-serialised. Default { score: 0.42 }
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
  nioHome = mkdtempSync(join(tmpdir(), 'nio-extscore-test-'));
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

afterEach(() => {
  _resetOAuthRegistryForTests();
});

// external-score needs neither orchestrator nor scanner.
const stubDeps = {
  orchestrator: {} as never,
  scanner: {} as never,
};

function writeConfig(cfg: Record<string, unknown>): void {
  writeFileSync(join(nioHome, 'config.yaml'), yamlDump(cfg));
}

describe('/nio external-score', () => {
  it('reports a friendly note when no endpoints are configured', async () => {
    writeConfig({ guard: { protection_level: 'balanced' } });
    const out = await dispatchNioCommand('external-score', stubDeps);
    assert.match(out, /## Nio External Scores/);
    assert.match(out, /No external scoring endpoints configured/);
    assert.match(out, /guard\.external_analyser/);
  });

  it('reports all-disabled when every entry is disabled, without listing them', async () => {
    writeConfig({
      guard: {
        protection_level: 'balanced',
        external_analyser: [
          { name: 'scorer_off1', endpoint: 'http://example.invalid/a', enabled: false },
          { name: 'scorer_off2', endpoint: 'http://example.invalid/b', enabled: false },
        ],
      },
    });
    const out = await dispatchNioCommand('external-score', stubDeps);
    assert.match(out, /2 endpoint\(s\) configured, all disabled/);
    // Disabled endpoints must NOT appear as probed rows.
    assert.doesNotMatch(out, /scorer_off1/);
    assert.doesNotMatch(out, /scorer_off2/);
  });

  it('leads with the score, then name — no auth label and no reason on success', async () => {
    const scorer = await startMockScorer({ body: { score: 0.42, reason: 'looks fine' } });
    try {
      writeConfig({
        guard: {
          protection_level: 'balanced',
          external_analyser: [{ name: 'guardrail', endpoint: scorer.url, weight: 1 }],
        },
      });
      const out = await dispatchNioCommand('external-score', stubDeps);
      assert.match(out, /1 enabled endpoint\(s\) queried/);
      assert.match(out, /- \[0\.42\] — guardrail \(/);
      // Success rows must NOT carry the reason or an auth label.
      assert.doesNotMatch(out, /looks fine/);
      assert.doesNotMatch(out, /\[no auth\]/);
    } finally {
      await stopServer(scorer.server);
    }
  });

  it('probes bearer-auth entries and leads with their score (no auth label)', async () => {
    const scorer = await startMockScorer({ body: { score: 0.13 } });
    try {
      writeConfig({
        guard: {
          protection_level: 'balanced',
          external_analyser: [{
            name: 'reputation',
            endpoint: scorer.url,
            weight: 1,
            auth: { type: 'bearer', api_key: 'sk-test' },
          }],
        },
      });
      const out = await dispatchNioCommand('external-score', stubDeps);
      assert.match(out, /- \[0\.13\] — reputation \(/);
      assert.doesNotMatch(out, /\[bearer\]/);
    } finally {
      await stopServer(scorer.server);
    }
  });

  it('shows ✗ with the error reason on failure (no hint line)', async () => {
    const scorer = await startMockScorer({
      status: 422,
      body: { detail: [{ loc: ['query', 'start'], msg: 'Field required' }] },
    });
    try {
      writeConfig({
        guard: {
          protection_level: 'balanced',
          external_analyser: [{ name: 'broken', endpoint: scorer.url, weight: 1 }],
        },
      });
      const out = await dispatchNioCommand('external-score', stubDeps);
      assert.match(out, /- \[✗\] — broken \(.*\):/);
      assert.match(out, /422.*Field required/);
      // No separate hint line.
      assert.doesNotMatch(out, /^\s*hint:/m);
    } finally {
      await stopServer(scorer.server);
    }
  });

  it('skips disabled entries while listing only enabled ones', async () => {
    const scorer = await startMockScorer({ body: { score: 0.5 } });
    try {
      writeConfig({
        guard: {
          protection_level: 'balanced',
          external_analyser: [
            { name: 'live_one', endpoint: scorer.url, weight: 1 },
            { name: 'skipped_one', endpoint: 'http://example.invalid/x', enabled: false },
          ],
        },
      });
      const out = await dispatchNioCommand('external-score', stubDeps);
      assert.match(out, /1 enabled endpoint\(s\) queried/);
      assert.match(out, /- \[0\.5\] — live_one \(/);
      assert.doesNotMatch(out, /skipped_one/);
    } finally {
      await stopServer(scorer.server);
    }
  });

  it('does NOT write probe failures to the audit log', async () => {
    writeConfig({
      guard: {
        protection_level: 'balanced',
        external_analyser: [{ name: 'dead', endpoint: 'http://127.0.0.1:1/score', weight: 1 }],
      },
    });
    writeFileSync(join(nioHome, 'audit.jsonl'), '');
    await dispatchNioCommand('external-score', stubDeps);
    const auditLines = readFileSync(join(nioHome, 'audit.jsonl'), 'utf-8').split('\n').filter(Boolean);
    const diagLines = auditLines.filter((l: string) => {
      try { return (JSON.parse(l) as { event?: string }).event === 'diagnostic'; } catch { return false; }
    });
    assert.equal(diagLines.length, 0,
      'external-score must not write diagnostics; found ' + diagLines.length);
  });

  it('is reachable via the `external` alias', async () => {
    writeConfig({ guard: { protection_level: 'balanced' } });
    const out = await dispatchNioCommand('external', stubDeps);
    assert.match(out, /## Nio External Scores/);
  });
});
