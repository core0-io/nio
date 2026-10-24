// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, realpathSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { LoggerProvider, InMemoryLogRecordExporter, SimpleLogRecordProcessor, type ReadableLogRecord } from '@opentelemetry/sdk-logs';
import { dispatchCollectorEvent, type HookStdinPayload } from '../scripts/lib/collector-core.js';
import { loadState } from '../scripts/lib/traces-state-store.js';
import { makeInMemoryTracer } from './helpers/tracer.js';
import { isSessionMonitored } from '../scripts/lib/monitor-check.js';
import { loadContentLimits } from '../scripts/lib/config-loader.js';

for (const platform of ['claude-code', 'codex', 'hermes']) {
  it(`${platform} preserves Trace bodies and emits ordered GenAI messages once on the existing turn`, async () => {
    const previousHome = process.env['NIO_HOME'];
    const dir = mkdtempSync(join(tmpdir(), 'nio-content-hooks-'));
    process.env['NIO_HOME'] = dir;
    const tracer = makeInMemoryTracer();
    const exporter = new InMemoryLogRecordExporter();
    const logger = new LoggerProvider({ processors: [new SimpleLogRecordProcessor(exporter)] });
    const logsConfig = { path: join(dir, 'audit.jsonl'), local: true, enabled: true };
    const transcriptPath = join(dir, 'session.jsonl');
    const sessionId = `session-${platform}`;
    const config = {
      enabled: true, endpoint: 'http://unused.invalid', api_key: '', headers: {}, timeout: 5000,
      protocol: 'http' as const, metrics_enabled: false, traces_enabled: true, logs_enabled: true,
    };
    writeFileSync(join(dir, 'config.yaml'), 'collector:\n  monitor_all_sessions: true\n  content_limits:\n    user_prompt: 4096\n');
    const dispatch = async (event: string, input: Partial<HookStdinPayload> = {}, payload?: unknown, closeTurn?: boolean) => {
      await dispatchCollectorEvent({
        event, input: { session_id: sessionId, cwd: dir, transcript_path: transcriptPath, ...input },
        platform, config, logsConfig, meterProvider: null, tracerProvider: tracer.provider, closeTurn,
        loggerProvider: logger, conversationInput: payload === undefined ? undefined : { payload },
      });
    };
    type Message = { role: string; parts: { type: string; content?: string }[] };
    const messages = (record: ReadableLogRecord, key: string) =>
      record.attributes[key] as unknown as Message[];
    try {
      const userTimestamp = new Date().toISOString();
      const user = platform === 'codex'
        ? { type: 'response_item', timestamp: userTimestamp, payload: { type: 'message', role: 'user', id: 'user-1', content: [{ type: 'input_text', text: 'short prompt' }, { type: 'input_image' }, { type: 'input_text', text: 'short prompt' }] } }
        : { type: 'user', timestamp: userTimestamp, uuid: 'user-1', message: { role: 'user', content: [{ type: 'text', text: 'short prompt' }, { type: 'image' }, { type: 'text', text: 'short prompt' }] } };
      writeFileSync(transcriptPath, JSON.stringify(user) + '\n');
      await dispatch('UserPromptSubmit', platform === 'hermes' ? { prompt: 'short prompt', prompt_id: 'user-1' } : {});
      await dispatch('UserPromptSubmit', platform === 'hermes' ? { prompt: 'short prompt', prompt_id: 'user-1' } : {});
      const longPrompt = '界'.repeat(2500);
      await dispatch('UserPromptSubmit', { prompt: longPrompt, prompt_id: 'user-2' });
      const traceId = loadState(logsConfig)!.turn_trace_id;
      const timestamp = new Date().toISOString();
      const texts = ['short reply', 'short reply', 'long '.repeat(1000)];
      let payload: unknown;
      if (platform === 'codex') {
        const entries = [
          user,
          { type: 'turn_context', timestamp, payload: { turn_id: 'turn-1', model: 'host-model' } },
          { type: 'response_item', timestamp, payload: { type: 'reasoning', id: 'reason-1', summary: [{ type: 'summary_text', text: 'exposed summary' }] } },
          { type: 'response_item', timestamp, payload: { type: 'message', id: 'reply-1', role: 'assistant', content: texts.map(text => ({ type: 'output_text', text })) } },
        ];
        writeFileSync(transcriptPath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
      } else if (platform === 'claude-code') {
        writeFileSync(transcriptPath, JSON.stringify(user) + '\n' + JSON.stringify({
          type: 'assistant', timestamp, requestId: 'request-1', message: {
            id: 'reply-1', model: 'host-model', role: 'assistant',
            content: [{ type: 'thinking', thinking: 'exposed summary' }, ...texts.map(text => ({ type: 'text', text }))],
          },
        }) + '\n');
      } else {
        payload = { session_id: sessionId, extra: { conversation_history: [
          { role: 'user', content: 'short prompt' },
          { role: 'assistant', id: 'reply-1', reasoning_content: 'exposed summary', content: texts.map(text => ({ type: 'text', text })) },
        ] } };
        await dispatch('Stop', {}, payload, false);
        await dispatch('Stop', {}, payload, false);
        assert.deepEqual(tracer.finished(), []);
        assert.equal(loadState(logsConfig)!.turn_trace_id, traceId);
      }
      const toolInput = { command: 'echo short', api_key: 'secret-value' };
      await dispatch('PreToolUse', { tool_name: 'Bash', tool_use_id: 'tool-1', tool_input: toolInput });
      const pendingId = loadState(logsConfig)!.pending_spans['tool-1']!.span_id;
      const result = { output: '界'.repeat(5000) };
      const tool = { tool_name: 'Bash', tool_use_id: 'tool-1', tool_input: toolInput, tool_response: result };
      await dispatch('PostToolUse', tool);
      await dispatch('PostToolUse', tool);
      const longInput = { command: 'echo ' + 'x'.repeat(4096) };
      await dispatch('PreToolUse', { tool_name: 'Bash', tool_use_id: 'tool-2', tool_input: longInput });
      await dispatch('PostToolUse', { tool_name: 'Bash', tool_use_id: 'tool-2', tool_input: longInput, tool_response: { output: 'short result' } });
      if (platform === 'hermes') {
        await dispatch('UserPromptSubmit', { prompt: longPrompt, prompt_id: 'user-2' });
        assert.equal(loadState(logsConfig)!.turn_trace_id, traceId);
        await dispatch('Stop', {}, payload, false);
        assert.equal(tracer.finished().some(span => span.name === 'invoke_agent UserPromptSubmit'), false);
        await dispatch('SessionEnd', {}, payload);
        await dispatch('SessionEnd', {}, payload);
      } else {
        await dispatch('Stop', {}, payload);
        await dispatch('Stop', {}, payload);
      }
      await logger.forceFlush();
      const records = exporter.getFinishedLogRecords().filter(record => record.instrumentationScope.name === 'nio-content');
      const spans = tracer.finished();
      const turn = spans.find(span => span.name === 'invoke_agent UserPromptSubmit')!;
      const toolSpan = spans.find(span => span.attributes['gen_ai.tool.call.id'] === 'tool-1')!;
      const secondTool = spans.find(span => span.attributes['gen_ai.tool.call.id'] === 'tool-2')!;
      assert.equal(toolSpan.spanContext().spanId, pendingId);
      assert.equal(turn.spanContext().traceId, traceId);
      assert.equal(turn.attributes['nio.turn.user_prompt'], longPrompt.slice(0, 2048) + '…[truncated]');
      assert.equal(toolSpan.attributes['gen_ai.tool.call.arguments'], '{"command":"echo short","api_key":"[REDACTED]"}');
      assert.equal(toolSpan.attributes['gen_ai.tool.call.result'], JSON.stringify(result).slice(0, 2048) + '…[truncated]');
      assert.equal(toolSpan.attributes['nio.tool_summary'], 'echo short');
      assert.equal(secondTool.attributes['gen_ai.tool.call.arguments'], JSON.stringify(longInput).slice(0, 2048) + '…[truncated]');
      assert.equal(secondTool.attributes['gen_ai.tool.call.result'], '{"output":"short result"}');
      const prompts = records.filter(record => record.attributes['gen_ai.input.messages'] !== undefined);
      assert.equal(prompts.length, 2);
      const firstPrompt = messages(prompts[0]!, 'gen_ai.input.messages');
      assert.deepEqual(firstPrompt, [{ role: 'user', parts: (platform === 'hermes' ? ['short prompt'] : ['short prompt', 'short prompt']).map(content => ({ type: 'text', content })) }]);
      const longPromptMessage = messages(prompts[1]!, 'gen_ai.input.messages');
      assert.ok(longPromptMessage[0]!.parts[0]!.content!.startsWith('界'));
      assert.ok(longPromptMessage[0]!.parts[0]!.content!.endsWith('[truncated]'));
      assert.ok(Buffer.byteLength(longPromptMessage[0]!.parts[0]!.content!) <= 4096);
      const outputs = records.filter(record => record.attributes['gen_ai.output.messages'] !== undefined);
      const parts = outputs.flatMap(record => messages(record, 'gen_ai.output.messages').flatMap(message => message.parts));
      assert.deepEqual(parts, [
        { type: 'reasoning', content: 'exposed summary' },
        ...texts.map(content => ({ type: 'text', content })),
      ]);
      for (const record of records) {
        assert.equal(record.spanContext!.traceId, traceId);
        assert.equal(record.spanContext!.spanId, turn.spanContext().spanId);
        assert.equal(record.attributes['nio.trace_id'], traceId);
        assert.equal(record.attributes['nio.span_id'], turn.spanContext().spanId);
        assert.equal(record.attributes['nio.guard.decision'], undefined);
        assert.equal(record.severityText, 'INFO');
        assert.equal(record.body, undefined);
      }
      assert.deepEqual(spans.map(span => span.name), ['execute_tool Bash', 'execute_tool Bash', 'invoke_agent UserPromptSubmit']);
    } finally {
      await logger.shutdown();
      await tracer.shutdown();
      if (previousHome === undefined) delete process.env['NIO_HOME']; else process.env['NIO_HOME'] = previousHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

it('bundled Hermes callbacks ignore tool-result pseudo-users and scope anonymous replies to observed user boundaries', async () => {
  type OtlpValue = {
    stringValue?: string;
    arrayValue?: { values: OtlpValue[] };
    kvlistValue?: { values: OtlpAttribute[] };
  };
  type OtlpAttribute = { key: string; value: OtlpValue };
  type OtlpRecord = { traceId: string; spanId: string; attributes: OtlpAttribute[] };
  type OtlpSpan = OtlpRecord & { name: string };
  const decode = (value: OtlpValue): unknown => {
    if (value.stringValue !== undefined) return value.stringValue;
    if (value.arrayValue) return value.arrayValue.values.map(decode);
    if (value.kvlistValue) return Object.fromEntries(value.kvlistValue.values.map(({ key, value }) => [key, decode(value)]));
    return undefined;
  };
  const attributes = (record: OtlpRecord) => Object.fromEntries(record.attributes.map(({ key, value }) => [key, decode(value)]));
  const dir = mkdtempSync(join(tmpdir(), 'nio-hermes-replay-'));
  const records: OtlpRecord[] = [];
  const spans: OtlpSpan[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString()) as {
      resourceLogs?: { scopeLogs?: { scope?: { name?: string }; logRecords?: OtlpRecord[] }[] }[];
      resourceSpans?: { scopeSpans?: { spans?: OtlpSpan[] }[] }[];
    };
    for (const resource of payload.resourceLogs ?? []) for (const scope of resource.scopeLogs ?? []) {
      if (scope.scope?.name === 'nio-content') records.push(...scope.logRecords ?? []);
    }
    for (const resource of payload.resourceSpans ?? []) for (const scope of resource.scopeSpans ?? []) {
      spans.push(...scope.spans ?? []);
    }
    res.setHeader('Content-Type', 'application/json');
    res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const logsConfig = { path: join(dir, 'audit.jsonl') };
  writeFileSync(join(dir, 'config.yaml'), `collector:\n  endpoint: http://127.0.0.1:${address.port}\n  monitor_all_sessions: true\n  metrics: { enabled: false }\n  logs: { enabled: true, local: true, path: '${logsConfig.path}' }\n`);
  const callback = async (event: string, history: unknown[], prompt?: string) => {
    const payload = {
      hook_event_name: event, session_id: 'hermes-replay', cwd: dir,
      extra: { conversation_history: history, ...(prompt === undefined ? {} : { user_message: prompt }) },
    };
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [
        fileURLToPath(new URL('../../plugins/hermes/scripts/hook-cli.js', import.meta.url)),
        '--platform', 'hermes', '--stdin',
      ], { env: { ...process.env, NIO_HOME: dir }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', code => resolve({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify(payload));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
  };
  try {
    const user1 = { role: 'user', id: 'host-user-1', content: 'continue' };
    const user2 = { role: 'user', id: 'host-user-2', content: 'continue' };
    const reply = { role: 'assistant', content: 'OK' };
    const toolResult = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'host-tool-1', content: 'done' }] };
    await callback('pre_llm_call', [user1], 'continue');
    const traceId = loadState(logsConfig)!.turn_trace_id;
    await callback('post_llm_call', [user1, reply]);
    assert.equal(spans.length, 0, 'a model callback must not close the existing user turn');
    await callback('pre_llm_call', [user1, reply, toolResult], 'continue');
    await callback('post_llm_call', [user1, reply, toolResult]);
    assert.equal(records.filter(record => attributes(record)['gen_ai.input.messages'] !== undefined).length, 1,
      'a tool-result-only pseudo-user must not change the prompt fallback identity');
    assert.equal(records.filter(record => attributes(record)['gen_ai.output.messages'] !== undefined).length, 1,
      'replayed anonymous output must remain suppressed after tools');
    await callback('pre_llm_call', [user1, reply, toolResult, user2], 'continue');
    const history = [user1, reply, toolResult, user2, reply];
    await callback('post_llm_call', history);
    await callback('post_llm_call', history);
    await callback('post_llm_call', [user2, reply]);
    assert.equal(records.filter(record => attributes(record)['gen_ai.output.messages'] !== undefined).length, 2,
      'host user identity distinguishes equal anonymous replies and survives history compaction');
    const anonymousUser = { role: 'user', content: 'anonymous follow-up' };
    await callback('pre_llm_call', [...history, anonymousUser], 'anonymous follow-up');
    const anonymousHistory = [...history, anonymousUser, reply];
    await callback('post_llm_call', anonymousHistory);
    await callback('pre_llm_call', [...anonymousHistory, anonymousUser], 'anonymous follow-up');
    const repeatedAnonymousHistory = [...anonymousHistory, anonymousUser, reply];
    await callback('post_llm_call', repeatedAnonymousHistory);
    await callback('post_llm_call', repeatedAnonymousHistory);
    assert.equal(loadState(logsConfig)!.turn_trace_id, traceId);
    assert.equal(spans.length, 0, 'distinct observed users do not invent a host turn-end boundary');
    await callback('on_session_end', repeatedAnonymousHistory);
    const prompts = records.filter(record => attributes(record)['gen_ai.input.messages'] !== undefined);
    const outputs = records.filter(record => attributes(record)['gen_ai.output.messages'] !== undefined);
    assert.equal(prompts.length, 4);
    assert.equal(outputs.length, 4, 'content plus observed occurrence distinguishes equal anonymous user boundaries without duplicating replay');
    for (const output of outputs) {
      assert.deepEqual(attributes(output)['gen_ai.output.messages'], [{ role: 'assistant', parts: [{ type: 'text', content: 'OK' }], finish_reason: 'unknown' }]);
    }
    assert.deepEqual(spans.map(span => span.name), ['invoke_agent UserPromptSubmit']);
    const turn = spans[0]!;
    assert.equal(turn.traceId, traceId);
    for (const record of records) {
      assert.equal(record.traceId, turn.traceId);
      assert.equal(record.spanId, turn.spanId);
      assert.equal(attributes(record)['nio.trace_id'], turn.traceId);
      assert.equal(attributes(record)['nio.span_id'], turn.spanId);
      assert.equal(attributes(record)['gen_ai.response.id'], undefined);
    }
    assert.equal(attributes(turn)['gen_ai.response.id'], undefined);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

it('content consent fails closed, honors existing session arms and cwd claims, and keeps local audit offline', async () => {
  const previousHome = process.env['NIO_HOME'];
  const dir = mkdtempSync(join(tmpdir(), 'nio-content-gate-'));
  process.env['NIO_HOME'] = dir;
  const logsConfig = { local: true, path: join(dir, 'audit.jsonl') };
  try {
    assert.equal(isSessionMonitored('session-1', dir, logsConfig), false);
    const canonicalDir = realpathSync(dir);
    const consentPath = join(dir, 'monitored-sessions.json');
    writeFileSync(consentPath, JSON.stringify({ sessions: {}, pending_arm: { at: Date.now(), cwd: canonicalDir } }));
    const lock = openSync(`${consentPath}.lock`, 'wx');
    try {
      assert.equal(isSessionMonitored('contender', dir, logsConfig), false);
      assert.ok(JSON.parse(readFileSync(consentPath, 'utf8')).pending_arm);
    } finally {
      closeSync(lock);
      unlinkSync(`${consentPath}.lock`);
    }
    assert.equal(isSessionMonitored('unknown', dir, logsConfig), false);
    assert.equal(isSessionMonitored('unrelated', '/elsewhere', logsConfig), false);
    assert.equal(isSessionMonitored('session-1', dir, logsConfig), true);
    assert.equal(isSessionMonitored('session-1', null, logsConfig), true);
    assert.equal(isSessionMonitored('session-2', dir, logsConfig), false);
    writeFileSync(join(dir, 'monitored-sessions.json'), '{corrupt');
    assert.equal(isSessionMonitored('session-1', dir, logsConfig), false);
    writeFileSync(join(dir, 'config.yaml'), 'collector:\n  monitor_all_sessions: "true"\n  content_limits:\n    text: -1\n    thinking: 0\n');
    assert.equal(isSessionMonitored('session-1', dir, logsConfig), false);
    assert.equal(loadContentLimits().thinking, 0);
    assert.ok(loadContentLimits().text > 0);
    await dispatchCollectorEvent({
      event: 'UserPromptSubmit', input: { session_id: 'offline', prompt: 'private' }, platform: 'claude-code',
      config: { enabled: false, endpoint: '', api_key: '', timeout: 5000, protocol: 'http', metrics_enabled: false, traces_enabled: true, logs_enabled: true },
      meterProvider: null, tracerProvider: null, loggerProvider: null, logsConfig,
    });
    const audit = readFileSync(logsConfig.path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(audit[0].event, 'UserPromptSubmit');
    assert.equal(audit[0].session_id, 'offline');
    assert.equal(audit[0].prompt, undefined);
  } finally {
    if (previousHome === undefined) delete process.env['NIO_HOME']; else process.env['NIO_HOME'] = previousHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

it('hook content gating cannot be bypassed by provider injection and does not disable local audit', async () => {
  const previousHome = process.env['NIO_HOME'];
  const dir = mkdtempSync(join(tmpdir(), 'nio-hook-content-disabled-'));
  process.env['NIO_HOME'] = dir;
  const tracer = makeInMemoryTracer();
  const exporter = new InMemoryLogRecordExporter();
  const logger = new LoggerProvider({ processors: [new SimpleLogRecordProcessor(exporter)] });
  try {
    for (const mode of ['unarmed', 'no endpoint', 'logs disabled', 'traces disabled']) {
      writeFileSync(join(dir, 'config.yaml'), `collector:\n  monitor_all_sessions: ${mode !== 'unarmed'}\n`);
      const logsConfig = { local: true, path: join(dir, `${mode}.jsonl`) };
      const config = {
        enabled: mode !== 'no endpoint', endpoint: mode === 'no endpoint' ? '' : 'http://unused.invalid',
        api_key: '', headers: {}, timeout: 5000, protocol: 'http' as const,
        metrics_enabled: false, traces_enabled: mode !== 'traces disabled', logs_enabled: mode !== 'logs disabled',
      };
      for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) {
        await dispatchCollectorEvent({
          event, platform: 'claude-code', config, logsConfig,
          input: { session_id: `disabled-${mode}`, prompt: 'private prompt', tool_name: 'Read', tool_use_id: 'tool-1', tool_input: { path: 'private path' }, tool_response: { output: 'private result' } },
          tracerProvider: tracer.provider, loggerProvider: logger, meterProvider: null,
        });
      }
      const audit = readFileSync(logsConfig.path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(audit.map(entry => entry.event), ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']);
    }
    await logger.forceFlush();
    assert.deepEqual(exporter.getFinishedLogRecords().filter(record => record.instrumentationScope.name === 'nio-content'), []);
  } finally {
    await tracer.shutdown();
    await logger.shutdown();
    if (previousHome === undefined) delete process.env['NIO_HOME']; else process.env['NIO_HOME'] = previousHome;
    rmSync(dir, { recursive: true, force: true });
  }
});
