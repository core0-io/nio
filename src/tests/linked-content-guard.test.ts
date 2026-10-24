// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardAuditSchema } from '../schemas/guard-audit.js';

for (const platform of ['claude-code', 'codex', 'hermes']) {
  it(`${platform} returns its computed Guard denial when deeply nested tool arguments exceed the attribute redactor stack`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nio-guard-content-'));
    const server = createServer((req, res) => {
      req.resume();
      req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end('{}'); });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const toolName = platform === 'hermes' ? 'terminal' : 'Bash';
    const platformKey = platform.replace(/-/g, '_');
    writeFileSync(join(dir, 'config.yaml'), `guard:\n  blocked_tools:\n    ${platformKey}: [${toolName}]\ncollector:\n  endpoint: http://127.0.0.1:${address.port}\n  monitor_all_sessions: true\n  metrics: { enabled: false }\n  logs: { enabled: true, local: true, path: '${dir}/audit.jsonl' }\n`);
    const args = platform === 'hermes'
      ? [fileURLToPath(new URL('../../plugins/hermes/scripts/hook-cli.js', import.meta.url)), '--platform', 'hermes', '--stdin']
      : [fileURLToPath(new URL(`../../plugins/${platform}/skills/nio/scripts/guard-hook.js`, import.meta.url)), '--platform', platform];
    const rawInput = '{"command":"echo denied","unused":' + '['.repeat(20000) + '0' + ']'.repeat(20000) + '}';
    const event = platform === 'hermes' ? 'pre_tool_call' : 'PreToolUse';
    const payload = `{"hook_event_name":"${event}","session_id":"content-denied","cwd":${JSON.stringify(dir)},"tool_name":"${toolName}","tool_use_id":"denied-1","extra":{"tool_call_id":"denied-1"},"tool_input":${rawInput}}`;
    try {
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const proc = spawn(process.execPath, args, { env: { ...process.env, NIO_HOME: dir } });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', chunk => { stdout += chunk; });
        proc.stderr.on('data', chunk => { stderr += chunk; });
        proc.once('error', reject);
        proc.once('close', code => resolve({ code, stdout, stderr }));
        proc.stdin.end(payload);
      });
      if (platform === 'hermes') {
        assert.equal(result.code, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).decision, 'block');
      } else {
        assert.equal(result.code, 2, result.stderr);
      }
      const entries = readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const record = entries.find(entry => entry.event === 'guard');
      assert.equal(guardAuditSchema.safeParse(record).success, true);
      assert.equal(record.decision, 'deny');
      assert.equal(record.phases[0].triggered_block, true);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
