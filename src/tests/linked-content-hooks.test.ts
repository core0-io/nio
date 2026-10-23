// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, realpathSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoggerProvider, InMemoryLogRecordExporter, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { dispatchCollectorEvent, type HookStdinPayload } from '../scripts/lib/collector-core.js';
import { loadState } from '../scripts/lib/traces-state-store.js';
import { makeInMemoryTracer } from './helpers/tracer.js';
import { isSessionMonitored } from '../scripts/lib/monitor-check.js';
import { loadContentLimits } from '../scripts/lib/config-loader.js';

for (const platform of ['claude-code', 'codex', 'hermes']) {
  it(`${platform} emits short and long content once with actual turn/chat/tool span IDs`, async () => {
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
    writeFileSync(join(dir, 'config.yaml'), 'collector:\n  monitor_all_sessions: true\n  content_limits:\n    tool_output: 128\n');
    const dispatch = async (event: string, input: Partial<HookStdinPayload> = {}, payload?: unknown) => {
      await dispatchCollectorEvent({
        event, input: { session_id: sessionId, cwd: dir, transcript_path: transcriptPath, ...input },
        platform, config, logsConfig, meterProvider: null, tracerProvider: tracer.provider,
        loggerProvider: logger, conversationInput: payload === undefined ? undefined : { payload },
      });
    };
    try {
      const userTimestamp = new Date().toISOString();
      const user = platform === 'codex'
        ? { type: 'response_item', timestamp: userTimestamp, payload: { type: 'message', role: 'user', id: 'user-1', content: [{ type: 'input_text', text: 'short prompt' }, { type: 'input_image' }, { type: 'input_text', text: 'short prompt' }] } }
        : { type: 'user', timestamp: userTimestamp, uuid: 'user-1', message: { role: 'user', content: [{ type: 'text', text: 'short prompt' }, { type: 'image' }, { type: 'text', text: 'short prompt' }] } };
      writeFileSync(transcriptPath, JSON.stringify(user) + '\n');
      await dispatch('UserPromptSubmit', platform === 'hermes' ? { prompt: 'short prompt', prompt_id: 'user-1' } : {});
      await dispatch('UserPromptSubmit', platform === 'hermes' ? { prompt: 'short prompt', prompt_id: 'user-1' } : {});
      await dispatch('UserPromptSubmit', { prompt: '界'.repeat(1500), prompt_id: 'user-2' });
      await dispatch('PreToolUse', { tool_name: 'Bash', tool_use_id: 'tool-1', tool_input: { command: 'echo short', api_key: 'secret-value' } });
      const pendingId = loadState(logsConfig)!.pending_spans['tool-1']!.span_id;
      const tool = { tool_name: 'Bash', tool_use_id: 'tool-1', tool_input: { command: 'echo short', api_key: 'secret-value' }, tool_response: { output: '界'.repeat(5000) } };
      await dispatch('PostToolUse', tool);
      await dispatch('PostToolUse', tool);
      const timestamp = new Date().toISOString();
      const longText = 'long '.repeat(1000);
      const texts = ['short reply', 'short reply', longText];
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
        payload = { session_id: sessionId, extra: { model: 'host-model', conversation_history: [
          { role: 'user', content: 'short prompt' },
          { role: 'assistant', id: 'reply-1', reasoning_content: 'exposed summary', content: texts.map(text => ({ type: 'text', text })) },
        ] } };
      }
      await dispatch('Stop', {}, payload);
      await dispatch('Stop', {}, payload);
      await logger.forceFlush();
      const records = exporter.getFinishedLogRecords().filter(record => record.instrumentationScope.name === 'nio-content');
      const spans = tracer.finished();
      const turn = spans.find(span => span.name === 'invoke_agent UserPromptSubmit')!;
      const toolSpan = spans.find(span => span.name === 'execute_tool Bash')!;
      assert.ok(turn);
      assert.equal(toolSpan.spanContext().spanId, pendingId);
      const prompts = records.filter(record => record.attributes['nio.content.type'] === 'user_prompt');
      const expectedPrompts = platform === 'hermes' ? ['short prompt', '界'.repeat(1500)] : ['short prompt', 'short prompt', '界'.repeat(1500)];
      assert.deepEqual(prompts.map(record => record.body), expectedPrompts);
      assert.deepEqual(prompts.map(record => record.attributes['nio.content.index']), platform === 'hermes' ? [0, 1] : [0, 2, 3]);
      assert.ok(prompts.every(record => record.spanContext?.spanId === turn.spanContext().spanId));
      const replies = records.filter(record => record.attributes['nio.content.type'] === 'text');
      assert.deepEqual(replies.map(record => record.body), texts);
      assert.deepEqual(replies.map(record => record.attributes['nio.content.index']), [1, 2, 3]);
      assert.deepEqual(records.filter(record => record.attributes['nio.content.type'] === 'thinking').map(record => record.body), ['exposed summary']);
      const inputs = records.filter(record => record.attributes['nio.content.type'] === 'tool_input');
      assert.equal(inputs.length, 1);
      assert.equal(inputs[0]!.body, '{"command":"echo short","api_key":"[REDACTED]"}');
      assert.equal(inputs[0]!.attributes['nio.content.redactions'], 1);
      const outputs = records.filter(record => record.attributes['nio.content.type'] === 'tool_output');
      assert.equal(outputs.length, 1);
      assert.equal(outputs[0]!.attributes['nio.content.truncated'], true);
      assert.equal(outputs[0]!.attributes['nio.content.original_bytes'], 15000);
      assert.ok(Buffer.byteLength(String(outputs[0]!.body)) <= 128);
      for (const record of records) {
        const context = record.spanContext!;
        assert.ok(spans.some(span => span.spanContext().traceId === context.traceId && span.spanContext().spanId === context.spanId));
        assert.equal(record.attributes['nio.trace_id'], context.traceId);
        assert.equal(record.attributes['nio.span_id'], context.spanId);
        assert.equal(record.attributes['nio.guard.decision'], undefined);
        assert.equal(record.severityText, 'INFO');
      }
      for (const record of [...inputs, ...outputs]) assert.equal(record.spanContext!.spanId, pendingId);
      for (const span of spans) {
        for (const key of ['nio.chat.reply', 'nio.turn.user_prompt', 'nio.turn.assistant_reply', 'gen_ai.tool.call.arguments', 'gen_ai.tool.call.result']) {
          assert.equal(span.attributes[key], undefined);
        }
      }
      assert.equal(spans.filter(span => span.name === 'invoke_agent UserPromptSubmit').length, 1);
    } finally {
      await logger.shutdown();
      await tracer.shutdown();
      if (previousHome === undefined) delete process.env['NIO_HOME']; else process.env['NIO_HOME'] = previousHome;
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

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
