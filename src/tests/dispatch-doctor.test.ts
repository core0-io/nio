// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * /nio doctor + /nio report (Diagnostics summary) integration tests.
 *
 * Driven through dispatchNioCommand() with a temp NIO_HOME so we exercise
 * the real config-load + audit-log paths without touching the user's
 * ~/.nio/.
 */

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump as yamlDump } from 'js-yaml';

import { dispatchNioCommand } from '../adapters/openclaw-dispatch.js';
import { _setDiagnosticsAuditPathForTests } from '../adapters/diagnostics.js';
import { _resetOAuthRegistryForTests } from '../core/analysers/external/auth.js';

let nioHome: string;
let originalNioHome: string | undefined;

before(() => {
  originalNioHome = process.env.NIO_HOME;
  nioHome = mkdtempSync(join(tmpdir(), 'nio-doctor-test-'));
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

// dispatchNioCommand requires DispatchDeps even though doctor/report don't
// use them. Construct minimal stubs.
const stubDeps = {
  orchestrator: {} as never,
  scanner: {} as never,
};

function writeConfig(cfg: Record<string, unknown>): void {
  // Write the YAML directly. We deliberately do NOT call resetConfig() — it
  // writes its own defaults to disk via the lazy configYamlPath() resolver,
  // which would clobber the test config (and historically clobbered the
  // real ~/.nio/config.yaml when the path was a module-load-time constant).
  writeFileSync(join(nioHome, 'config.yaml'), yamlDump(cfg));
}

describe('/nio doctor', () => {
  it('reports config OK when YAML is valid', async () => {
    writeConfig({ guard: { protection_level: 'balanced' } });
    const out = await dispatchNioCommand('doctor', stubDeps);
    assert.match(out, /## Nio Doctor/);
    assert.match(out, /### Configuration/);
    assert.match(out, /✓ .*config\.yaml loaded successfully/);
  });

  it('flags llm_analyser.enabled without api_key', async () => {
    writeConfig({
      guard: {
        protection_level: 'balanced',
        llm_analyser: { enabled: true, api_key: '' },
      },
    });
    const out = await dispatchNioCommand('doctor', stubDeps);
    assert.match(out, /### LLM Analyser/);
    assert.match(out, /✗.*api_key is empty/);
    assert.match(out, /hint:.*api_key/);
  });

  it('dry-runs OAuth and reports failure with hint when endpoint is unreachable', async () => {
    writeConfig({
      guard: {
        protection_level: 'balanced',
        external_analyser: [{
          name: 'scorer_dead',
          endpoint: 'http://127.0.0.1:1/score',
          weight: 1,
          auth: {
            type: 'oauth',
            oauth_url: 'http://127.0.0.1:1/oauth',
            client_id: 'cid',
            client_secret: 'csec',
          },
        }],
      },
    });
    const out = await dispatchNioCommand('doctor', stubDeps);
    assert.match(out, /### External Analysers/);
    assert.match(out, /✗ scorer_dead/);
    // /token is unreachable → token_failed diagnostic; its hint mentions
    // client_id / client_secret.
    assert.match(out, /hint:.*client_id/);
  });

  it('marks disabled external analyser entries with · instead of ✓/✗', async () => {
    writeConfig({
      guard: {
        protection_level: 'balanced',
        external_analyser: [{
          name: 'scorer_off',
          endpoint: 'http://example.invalid/score',
          enabled: false,
          auth: { type: 'bearer', api_key: 'sk' },
        }],
      },
    });
    const out = await dispatchNioCommand('doctor', stubDeps);
    assert.match(out, /· scorer_off .* — disabled/);
  });
});

describe('/nio report — Diagnostics summary', () => {
  it('aggregates diagnostic entries by (source,kind,component) with counts', async () => {
    writeConfig({ guard: { protection_level: 'balanced' } });

    // Seed the audit log with three diagnostic entries — two should collapse.
    const auditPath = join(nioHome, 'audit.jsonl');
    const lines = [
      { event: 'diagnostic', timestamp: '2026-05-25T14:02:11.000Z', severity: 'error',
        source: 'oauth', kind: 'token_failed', component: 'scorer_primary',
        message: 'HTTP 401', hint: 'Check client_id.' },
      { event: 'diagnostic', timestamp: '2026-05-25T14:09:33.000Z', severity: 'error',
        source: 'oauth', kind: 'token_failed', component: 'scorer_primary',
        message: 'HTTP 401', hint: 'Check client_id.' },
      { event: 'diagnostic', timestamp: '2026-05-25T14:31:08.000Z', severity: 'error',
        source: 'llm',   kind: 'api_key_missing',
        message: 'api_key empty', hint: 'Set api_key.' },
    ];
    for (const l of lines) {
      appendFileSync(auditPath, JSON.stringify(l) + '\n');
    }

    const out = await dispatchNioCommand('report', stubDeps);
    assert.match(out, /## Diagnostics/);
    // Two token_failed entries should collapse to count=2
    assert.match(out, /\| 2 \| oauth \| token_failed \| scorer_primary \|/);
    // api_key_missing keeps its own row
    assert.match(out, /\| 1 \| llm \| api_key_missing \|/);
    // Hints section appears
    assert.match(out, /Hints:/);
    assert.match(out, /oauth token_failed:.*client_id/);
  });

  it('omits Diagnostics section when no diagnostic entries exist', async () => {
    writeConfig({ guard: { protection_level: 'balanced' } });
    // Clear audit log
    writeFileSync(join(nioHome, 'audit.jsonl'), '');
    // Seed one non-diagnostic event
    appendFileSync(join(nioHome, 'audit.jsonl'),
      JSON.stringify({
        event: 'guard', timestamp: '2026-05-25T15:00:00.000Z',
        decision: 'allow', risk_level: 'low', tool_name: 'Bash',
      }) + '\n');

    const out = await dispatchNioCommand('report', stubDeps);
    assert.doesNotMatch(out, /## Diagnostics/);
  });
});
