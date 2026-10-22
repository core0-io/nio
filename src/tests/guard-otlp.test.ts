import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoggerProvider } from '../scripts/lib/logs-collector.js';
import { buildEvaluatedGuardAuditEntry, writeAuditLog } from '../adapters/common.js';
import { createNio } from '../index.js';
import { evaluateHook } from '../adapters/hook-engine.js';
import { loadConfig } from '../adapters/common.js';
import { ClaudeCodeAdapter } from '../adapters/claude-code.js';
import { CodexAdapter } from '../adapters/codex.js';
import { HermesAdapter } from '../adapters/hermes.js';
import { OpenClawAdapter } from '../adapters/openclaw.js';
import { PiAdapter } from '../adapters/pi.js';
import { OpenCodeAdapter } from '../adapters/opencode.js';
import { GuardEvaluation } from '../core/guard-evaluation.js';
import { validateGuardAuditEntry } from '../schemas/index.js';

it('dual-writes the same validated Guard record through a real HTTP OTLP receiver', async () => {
  const payloads: any[] = [];
  let received: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    payloads.push(JSON.parse(Buffer.concat(chunks).toString()));
    received?.();
    res.setHeader('content-type', 'application/json'); res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const dir = mkdtempSync(join(tmpdir(), 'nio-otlp-'));
  const path = join(dir, 'audit.jsonl');
  const provider = createLoggerProvider({ endpoint: `http://127.0.0.1:${address.port}`, protocol: 'http', api_key: '', headers: {}, timeout: 1000, enabled: true, logs_enabled: true, metrics_enabled: false, traces_enabled: false }, 'pi', 'receiver-agent')!;
  try {
    const audit = new GuardEvaluation();
    audit.start(0); audit.complete(0, null, [], 'Tool gate passed');
    audit.terminate('unmapped_allow', 'Tool is not mapped', 0);
    const entry = buildEvaluatedGuardAuditEntry({ toolName: 'unknown', toolInput: {}, eventType: 'pre', raw: {} }, null, null, 'pi', audit, undefined, 'receiver-agent');
    validateGuardAuditEntry(entry);
    writeAuditLog(entry, { loggerProvider: provider, logsConfig: { path } });
    const exported = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('OTLP receiver timed out')), 2000);
      received = () => { clearTimeout(timeout); resolve(); };
    });
    await provider.forceFlush();
    await exported;
    assert.equal(payloads.length, 1);
    const resource = payloads[0].resourceLogs[0];
    const scope = resource.scopeLogs[0];
    assert.equal(scope.scope.name, 'nio-audit');
    const record = scope.logRecords[0];
    assert.deepEqual(JSON.parse(record.body.stringValue), JSON.parse(readFileSync(path, 'utf8').trim()));
    assert.equal(BigInt(record.timeUnixNano), BigInt(Date.parse(entry.timestamp)) * 1000000n);
    const attrs = Object.fromEntries(resource.resource.attributes.map((a: any) => [a.key, a.value.stringValue]));
    assert.equal(attrs['service.name'], entry.service_name);
    assert.equal(attrs['nio.platform'], entry.platform);
    assert.equal(attrs['gen_ai.agent.name'], entry.agent_name);
    for (const adapter of [new ClaudeCodeAdapter(), new CodexAdapter(), new HermesAdapter(), new OpenClawAdapter(), new PiAdapter(), new OpenCodeAdapter()]) {
      const platformProvider = createLoggerProvider({ endpoint: `http://127.0.0.1:${address.port}`, protocol: 'http', api_key: '', headers: {}, timeout: 1000, enabled: true, logs_enabled: true, metrics_enabled: false, traces_enabled: false }, adapter.name)!;
      const before: number = payloads.length;
      const raw = { tool_name: 'unknown', toolName: 'unknown', tool: 'unknown', tool_input: {}, input: {}, args: {}, params: {} };
      const done = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`${adapter.name} receiver timed out`)), 2000);
        received = () => { clearTimeout(timeout); resolve(); };
      });
      try {
        await evaluateHook(adapter, raw, { config: loadConfig(), nio: createNio() }, { loggerProvider: platformProvider, logsConfig: { path } });
        await platformProvider.forceFlush();
        await done;
        assert.equal(payloads.length - before, 1, `${adapter.name} produces exactly one evaluation`);
        const resource: any = payloads[before].resourceLogs[0];
        const body = JSON.parse(resource.scopeLogs[0].logRecords[0].body.stringValue);
        validateGuardAuditEntry(body);
        assert.equal(body.platform, adapter.name);
        assert.equal(body.termination.kind, 'unmapped_allow');
        const identity: Record<string, unknown> = Object.fromEntries(resource.resource.attributes.map((a: any) => [a.key, a.value.stringValue]));
        assert.equal(identity['gen_ai.agent.name'], body.agent_name);
      } finally { await platformProvider.shutdown(); }
    }
    if (process.env.NIO_OTLP_CAPTURE_PATH) writeFileSync(process.env.NIO_OTLP_CAPTURE_PATH, JSON.stringify(payloads[0], null, 2) + '\n');
  } finally {
    await provider.shutdown();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

it('configured native CLI and plugin runtime paths each send exactly one Guard evaluation', async () => {
  const bodies: any[] = [];
  const captures: unknown[] = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    captures.push(payload);
    for (const resource of payload.resourceLogs ?? []) {
      for (const scope of resource.scopeLogs ?? []) {
        for (const record of scope.logRecords ?? []) {
          const body = JSON.parse(record.body.stringValue);
          if (body.event === 'guard') bodies.push(body);
        }
      }
    }
    res.setHeader('content-type', 'application/json'); res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const home = mkdtempSync(join(tmpdir(), 'nio-native-otlp-'));
  writeFileSync(join(home, 'config.yaml'), `agent_name: native-receiver\ncollector:\n  endpoint: http://127.0.0.1:${port}\n  metrics:\n    enabled: false\n  traces:\n    enabled: false\n  logs:\n    enabled: true\n`);
  try {
    await runNativeGuardPaths(home);
    const deadline = Date.now() + 2000;
    while (bodies.length < 6 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const local = readFileSync(join(home, 'audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.event === 'guard');
    assert.equal(local.length, 6);
    assert.equal(bodies.length, 6, bodies.map(entry => entry.platform).join(','));
    for (const platform of ['claude-code', 'codex', 'hermes', 'openclaw', 'pi', 'opencode']) {
      const entries = bodies.filter(entry => entry.platform === platform);
      assert.equal(entries.length, 1, `${platform} exactly one evaluation`);
      validateGuardAuditEntry(entries[0]);
      assert.deepEqual(entries[0], local.find(entry => entry.evaluation_id === entries[0].evaluation_id));
      assert.equal(entries[0].agent_name, 'native-receiver');
    }
    if (process.env.NIO_OTLP_CAPTURE_PATH) writeFileSync(process.env.NIO_OTLP_CAPTURE_PATH, JSON.stringify(captures[0], null, 2) + '\n');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});

const nativePlatforms = ['claude-code', 'codex', 'hermes', 'openclaw', 'pi', 'opencode'];

async function runNativeGuardPaths(home: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  const { InProcessPluginRuntime } = await import('../adapters/plugin-runtime.js');
  const prior = process.env.NIO_HOME;
  const raw = { hook_event_name: 'PreToolUse', tool_name: 'unknown', toolName: 'unknown', tool: 'unknown', tool_input: {}, input: {}, args: {}, params: {} };
  const run = (script: string, args: string[], input?: unknown) => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, NIO_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
    let errors = '';
    child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(errors)));
    child.stdin.end(input ? JSON.stringify(input) : undefined);
  });
  try {
    const scripts = 'plugins/claude-code/skills/nio/scripts/';
    await run(`${scripts}guard-hook.js`, ['--platform', 'claude-code'], raw);
    await run(`${scripts}guard-hook.js`, ['--platform', 'codex'], raw);
    await run(`${scripts}hook-cli.js`, ['--platform', 'hermes', '--envelope', JSON.stringify({ ...raw, hook_event_name: 'pre_tool_call' })]);
    process.env.NIO_HOME = home;
    for (const adapter of [new OpenClawAdapter(), new PiAdapter(), new OpenCodeAdapter()]) {
      const runtime = new InProcessPluginRuntime({ platform: adapter.name, adapter });
      await runtime.onPreTool('session', 'call', 'unknown', {}, raw);
      await runtime.disposeAllSessions();
    }
  } finally {
    if (prior === undefined) delete process.env.NIO_HOME; else process.env.NIO_HOME = prior;
  }
}

for (const scenario of [
  { name: 'no collector configuration', config: '{}\n', local: true, failedExport: false },
  { name: 'no endpoint and logs export disabled', config: 'collector:\n  logs:\n    enabled: false\n', local: true, failedExport: false },
  { name: 'endpoint configured but logs export disabled', config: 'collector:\n  endpoint: http://127.0.0.1:1\n  metrics:\n    enabled: false\n  traces:\n    enabled: false\n  logs:\n    enabled: false\n', local: true, failedExport: false },
  { name: 'unreachable remote endpoint', config: 'collector:\n  endpoint: http://127.0.0.1:1\n  timeout: 1000\n  metrics:\n    enabled: false\n  traces:\n    enabled: false\n  logs:\n    enabled: true\n', local: true, failedExport: true },
  { name: 'explicitly disabled local logging', config: 'collector:\n  logs:\n    local: false\n', local: false, failedExport: false },
]) {
  it(`six native paths preserve independent local Guard logging: ${scenario.name}`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'nio-native-local-'));
    writeFileSync(join(home, 'config.yaml'), scenario.config);
    try {
      await runNativeGuardPaths(home);
      const path = join(home, 'audit.jsonl');
      const entries = existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
      const guards = entries.filter(entry => entry.event === 'guard');
      assert.equal(guards.length, scenario.local ? 6 : 0);
      for (const platform of scenario.local ? nativePlatforms : []) {
        const records = guards.filter(entry => entry.platform === platform);
        assert.equal(records.length, 1, `${platform} retains one local evaluation`);
        const record = validateGuardAuditEntry(records[0]);
        assert.equal(record.decision, 'allow');
        assert.equal(record.termination.kind, 'unmapped_allow');
      }
      const failures = entries.filter(entry => entry.kind === 'otlp_export_failed' && entry.component === 'logs');
      assert.equal(failures.length > 0, scenario.failedExport);
      if (scenario.failedExport) assert.match(String(failures[0].detail), /ECONNREFUSED/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}

it('disabled collector with a configured endpoint sends nothing and retains the local Guard record', async () => {
  const { guardAuditFixture } = await import('./helpers/guard-audit.js');
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    requests++;
    res.setHeader('content-type', 'application/json'); res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const home = mkdtempSync(join(tmpdir(), 'nio-disabled-collector-'));
  const path = join(home, 'audit.jsonl');
  const provider = createLoggerProvider({ endpoint: `http://127.0.0.1:${port}`, protocol: 'http', api_key: '', headers: {}, timeout: 1000, enabled: false, logs_enabled: true, metrics_enabled: false, traces_enabled: false }, 'claude-code');
  try {
    const entry = guardAuditFixture();
    writeAuditLog(entry, { loggerProvider: provider, logsConfig: { path } });
    await provider?.forceFlush();
    assert.deepEqual(validateGuardAuditEntry(JSON.parse(readFileSync(path, 'utf8'))), entry);
    assert.equal(requests, 0);
    assert.equal(provider, null);
  } finally {
    await provider?.shutdown();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});
