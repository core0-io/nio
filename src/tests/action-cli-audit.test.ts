import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateGuardAuditEntry } from '../schemas/index.js';

it('action-cli audits its direct evaluation without claiming Tool gate execution', () => {
  const home = mkdtempSync(join(tmpdir(), 'nio-action-cli-'));
  try {
    const output = execFileSync(process.execPath, ['plugins/claude-code/skills/nio/scripts/action-cli.js', 'evaluate', '--type', 'read_file', '--path', '/tmp/example'], { env: { ...process.env, NIO_HOME: home }, encoding: 'utf8' });
    const result = JSON.parse(output);
    const entries = readFileSync(join(home, 'audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.event === 'guard');
    assert.equal(entries.length, 1);
    const entry = validateGuardAuditEntry(entries[0]);
    assert.equal(entry.decision, result.decision);
    assert.equal(entry.phases[0].status, 'skipped');
    assert.equal(entry.phases[0].skip_reason, 'not_applicable');
    assert.deepEqual(entry.phases, result.audit.phases);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
