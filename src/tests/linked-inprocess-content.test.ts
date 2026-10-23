// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryLogRecordExporter, LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import type { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { registerPiExtension } from '../adapters/pi-plugin.js';
import { registerOpenClawPlugin } from '../adapters/openclaw-plugin.js';
import { createNioPlugin } from '../adapters/opencode-plugin.js';
import { makeInMemoryTracer } from './helpers/tracer.js';
import { contentRecordSchema } from '../schemas/content.js';

const HOSTS = ['pi', 'opencode', 'openclaw'] as const;
type Host = typeof HOSTS[number];
type Handler = (event: unknown, context: unknown) => unknown;
interface Lifecycle {
  prompt(text: string): Promise<void>;
  reply(body: string): Promise<void>;
  pre(body: string): Promise<void>;
  post(body: string): Promise<void>;
  end(): Promise<void>;
}
const SESSION = 'linked-content-session';
const PROJECT = '/workspaces/linked-content-project';

async function bind(host: Host, tracer: NodeTracerProvider | null, logger: LoggerProvider): Promise<Lifecycle> {
  const options = { tracerProvider: tracer, meterProvider: null, loggerProvider: logger };
  const handlers = new Map<string, Handler>();
  const on = (name: string, handler: Handler) => { handlers.set(name, handler); };
  const call = async (name: string, event: unknown, ctx: unknown) => { await handlers.get(name)!(event, ctx); };
  const content = (body: string) => [
    { type: 'thinking', thinking: `think:${body}` },
    { type: 'text', text: `reply:${body}` },
    { type: 'toolCall', id: 'tool-1', name: 'bash', arguments: { command: `echo ${body}` } },
    { type: 'text', text: `reply:${body}` },
    { type: 'thinking', thinking: `after:${body}` },
  ];
  if (host === 'pi') {
    registerPiExtension({ on, registerCommand() {} }, options);
    const ctx = {
      cwd: PROJECT, hasUI: false,
      sessionManager: { getSessionId: () => SESSION, getSessionFile: () => null },
    };
    await call('session_start', {}, ctx);
    return {
      async prompt(text) { await call('input', { text }, ctx); },
      async reply(body) {
        await call('message_end', { message: {
          id: 'assistant-1', role: 'assistant', model: 'claude-sonnet-4', provider: 'anthropic',
          timestamp: Date.now() + 10, content: content(body), usage: { input: 5, output: 7 },
        } }, ctx);
      },
      async pre(body) { await call('tool_call', { toolName: 'bash', toolCallId: 'tool-1', input: { command: `echo ${body}` } }, ctx); },
      async post(body) { await call('tool_result', { toolName: 'bash', toolCallId: 'tool-1', content: [{ type: 'text', text: `result:${body}` }] }, ctx); },
      async end() { await call('agent_end', {}, ctx); },
    };
  }
  if (host === 'openclaw') {
    registerOpenClawPlugin({ on }, options);
    const ctx = { sessionId: SESSION };
    await call('session_start', {}, ctx);
    return {
      async prompt(text) {
        await call('before_agent_reply', { cleanedBody: text }, ctx);
        await call('llm_input', { sessionId: SESSION, runId: 'run-1', prompt: text, historyMessages: [] }, ctx);
      },
      async reply(body) {
        await call('llm_output', {
          sessionId: SESSION, runId: 'run-1', provider: 'anthropic', model: 'claude-sonnet-4',
          assistantTexts: [`reply:${body}`, `reply:${body}`],
          lastAssistant: { role: 'assistant', content: content(body) }, usage: { input: 5, output: 7 },
        }, ctx);
      },
      async pre(body) { await call('before_tool_call', { toolName: 'exec', toolCallId: 'tool-1', params: { command: `echo ${body}` } }, ctx); },
      async post(body) { await call('after_tool_call', { toolName: 'exec', toolCallId: 'tool-1', result: `result:${body}` }, ctx); },
      async end() { await call('agent_end', {}, ctx); },
    };
  }
  const hooks = await createNioPlugin(options)({ directory: PROJECT, worktree: PROJECT });
  const event = async (type: string, properties: Record<string, unknown>) => { await hooks.event!({ event: { type, properties } }); };
  return {
    async prompt(text) {
      const output = { message: { id: 'user-1', sessionID: SESSION }, parts: [{ id: 'prompt-1', type: 'text', text }] };
      await hooks['chat.message']!({}, output);
      await hooks['chat.message']!({}, output); // Same host message observed twice.
    },
    async reply(body) {
      const info = { id: 'assistant-1', sessionID: SESSION, role: 'assistant', providerID: 'anthropic', modelID: 'claude-sonnet-4', time: { created: Date.now() + 10, completed: Date.now() + 20 } };
      await event('message.updated', { info });
      const parts = [
        { type: 'reasoning', text: `think:${body}` },
        { type: 'text', text: `reply:${body}` },
        { type: 'tool', callID: 'tool-1', tool: 'bash', state: { input: { command: `echo ${body}` } } },
        { type: 'text', text: `reply:${body}` },
        { type: 'reasoning', text: `after:${body}` },
      ];
      for (const [i, part] of parts.entries()) {
        const p = { ...part, id: `part-${i}`, sessionID: SESSION, messageID: 'assistant-1' };
        await event('message.part.updated', { part: { ...p, text: 'incomplete snapshot' } });
        await event('message.part.updated', { part: p });
      }
      await event('message.updated', { info });
    },
    async pre(body) { await hooks['tool.execute.before']!({ tool: 'bash', sessionID: SESSION, callID: 'tool-1' }, { args: { command: `echo ${body}` } }); },
    async post(body) { await hooks['tool.execute.after']!({ tool: 'bash', sessionID: SESSION, callID: 'tool-1', args: {} }, { title: 'done', output: `result:${body}`, metadata: {} }); },
    async end() { await event('session.idle', { sessionID: SESSION }); },
  };
}

describe('linked content through real in-process host lifecycles', () => {
  let home: string;
  let previousHome: string | undefined;
  beforeEach(() => {
    previousHome = process.env['NIO_HOME'];
    home = mkdtempSync(join(tmpdir(), 'nio-linked-inprocess-'));
    process.env['NIO_HOME'] = home;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env['NIO_HOME'];
    else process.env['NIO_HOME'] = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  function configure(host: Host, mode = 'enabled') {
    writeFileSync(join(home, 'config.yaml'), `collector:\n  endpoint: "${mode === 'no endpoint' ? '' : 'http://127.0.0.1:4318'}"\n  traces: { enabled: ${mode !== 'traces disabled'} }\n  logs: { enabled: ${mode !== 'logs disabled'}, local: false }\n`);
    if (mode !== 'unarmed') writeFileSync(join(home, 'monitored-sessions.json'), JSON.stringify({
      sessions: { [SESSION]: { armed_at: Date.now(), cwd: host === 'openclaw' ? process.cwd() : PROJECT } },
    }));
  }
  function logger() {
    const exporter = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({ processors: [new BatchLogRecordProcessor(exporter)] });
    const records = async () => {
      await provider.forceFlush();
      return exporter.getFinishedLogRecords().filter(record => record.attributes['nio.content.type']).map(record => {
        assert.ok(record.spanContext, 'OTLP built-in trace/span fields must be present');
        return contentRecordSchema.parse({
          body: record.body, attributes: record.attributes,
          traceId: record.spanContext.traceId, spanId: record.spanContext.spanId,
        });
      });
    };
    return { provider, records };
  }

  for (const host of HOSTS) {
    for (const size of ['short', 'long'] as const) {
      it(`${host}: ${size} prompt, reasoning, repeated text blocks and tool IO are linked exactly once`, async () => {
        configure(host);
        const tracer = makeInMemoryTracer();
        const logs = logger();
        const body = size === 'short' ? 'short-content-marker' : 'long-content-marker'.repeat(300);
        try {
          const lifecycle = await bind(host, tracer.provider, logs.provider);
          await lifecycle.prompt(`prompt:${body}`);
          await lifecycle.reply(body);
          await lifecycle.pre(body);
          const early = await logs.records();
          assert.deepEqual(early.map(r => r.attributes['nio.content.type']), ['user_prompt', 'tool_input']);
          await lifecycle.pre(body); // Replay cannot mint a different executing span.
          await lifecycle.post(body);
          await lifecycle.post(body);
          await lifecycle.end();
          await lifecycle.end();
          const records = await logs.records();
          assert.equal(records.length, 7);
          const spans = tracer.finished();
          const turn = spans.find(s => s.attributes['gen_ai.operation.name'] === 'invoke_agent');
          const chat = spans.find(s => s.attributes['gen_ai.operation.name'] === 'chat');
          const tool = spans.find(s => s.attributes['gen_ai.operation.name'] === 'execute_tool');
          assert.ok(turn); assert.ok(chat); assert.ok(tool);
          assert.equal(spans.filter(s => s.attributes['gen_ai.operation.name'] === 'execute_tool').length, 1);
          assert.deepEqual(chat.attributes['nio.chat.tool_call_ids'], ['tool-1']);
          const prompt = records.find(r => r.attributes['nio.content.type'] === 'user_prompt');
          assert.equal(prompt?.spanId, turn.spanContext().spanId);
          assert.equal(prompt?.body, `prompt:${body}`);
          if (host === 'opencode') assert.equal(prompt?.attributes['nio.content.source_id'], 'prompt-1');
          for (const record of records) {
            assert.equal(record.traceId, turn.spanContext().traceId);
            if (record.attributes['nio.content.type'].startsWith('tool_')) {
              assert.equal(record.spanId, tool.spanContext().spanId);
              assert.equal(record.attributes['gen_ai.tool.call.id'], 'tool-1');
              assert.equal(record.attributes['nio.content.source_id'], 'tool-1');
              assert.equal(record.attributes['nio.content.source'], `${host}-events`);
              assert.ok(record.body.includes(body));
            }
          }
          const chatContent = records.filter(r => r.spanId === chat.spanContext().spanId);
          assert.deepEqual(chatContent.map(r => [r.attributes['nio.content.type'], r.attributes['nio.content.index'], r.body]), [
            ['thinking', 0, `think:${body}`], ['text', 1, `reply:${body}`],
            ['text', 3, `reply:${body}`], ['thinking', 4, `after:${body}`],
          ]);
          if (host === 'opencode') assert.deepEqual(
            chatContent.map(r => r.attributes['nio.content.source_id']), ['part-0', 'part-1', 'part-3', 'part-4'],
          );
          assert.equal(chat.parentSpanContext?.spanId, turn.spanContext().spanId);
          assert.equal(tool.parentSpanContext?.spanId, turn.spanContext().spanId);
          for (const span of spans) {
            assert.ok(!JSON.stringify(span.attributes).includes(body), 'full bodies and short previews do not belong on spans');
          }
        } finally {
          await tracer.shutdown();
          await logs.provider.shutdown();
        }
      });
    }
    for (const mode of ['unarmed', 'logs disabled', 'traces disabled', 'no endpoint', 'no tracer']) {
      it(`${host}: ${mode} suppresses content even with injected providers`, async () => {
        configure(host, mode);
        const tracer = makeInMemoryTracer();
        const logs = logger();
        try {
          const lifecycle = await bind(host, mode === 'no tracer' ? null : tracer.provider, logs.provider);
          await lifecycle.prompt('private prompt');
          await lifecycle.reply('private content');
          await lifecycle.pre('private arguments');
          await lifecycle.post('private result');
          await lifecycle.end();
          assert.deepEqual(await logs.records(), []);
          if (mode === 'unarmed') assert.ok(tracer.finished().length > 0, 'capture consent must not suppress baseline spans');
        } finally {
          await tracer.shutdown();
          await logs.provider.shutdown();
        }
      });
    }
    if (host !== 'openclaw') it(`${host}: replayed assistant identity does not emit another chat or content batch`, async () => {
      configure(host);
      const tracer = makeInMemoryTracer();
      const logs = logger();
      try {
        const lifecycle = await bind(host, tracer.provider, logs.provider);
        await lifecycle.prompt('first question');
        await lifecycle.reply('same observed response');
        await lifecycle.end();
        const first = await logs.records();
        await lifecycle.reply('same observed response');
        await lifecycle.end();
        assert.equal((await logs.records()).length, first.length);
        assert.equal(tracer.finished().filter(s => s.attributes['gen_ai.operation.name'] === 'chat').length, 1);
      } finally {
        await tracer.shutdown();
        await logs.provider.shutdown();
      }
    });
  }

  it('Pi replays the session file across turns without replaying already observed calls', async () => {
    configure('pi');
    const tracer = makeInMemoryTracer();
    const logs = logger();
    const handlers = new Map<string, Handler>();
    const transcript = join(home, 'linked-pi-session.jsonl');
    const timestamp = Date.now() + 100;
    const entry = (id: string, text: string) => JSON.stringify({
      type: 'message', id, timestamp: new Date(timestamp).toISOString(),
      message: { role: 'assistant', timestamp, model: 'claude-sonnet-4', content: [{ type: 'text', text }] },
    }) + '\n';
    const first = entry('first-assistant', 'first answer');
    writeFileSync(transcript, first);
    const ctx = { cwd: PROJECT, hasUI: false, sessionManager: { getSessionId: () => SESSION, getSessionFile: () => transcript } };
    registerPiExtension({ on(name, handler) { handlers.set(name, handler); }, registerCommand() {} }, {
      tracerProvider: tracer.provider, meterProvider: null, loggerProvider: logs.provider,
    });
    try {
      await handlers.get('session_start')!({}, ctx);
      await handlers.get('input')!({ text: 'first question' }, ctx);
      await handlers.get('agent_end')!({}, ctx);
      writeFileSync(transcript, first + entry('second-assistant', 'second answer'));
      await handlers.get('input')!({ text: 'second question' }, ctx);
      await handlers.get('agent_end')!({}, ctx);
      await handlers.get('agent_end')!({}, ctx);
      assert.deepEqual((await logs.records()).filter(r => r.attributes['nio.content.type'] === 'text').map(r => r.body), ['first answer', 'second answer']);
      assert.equal(tracer.finished().filter(s => s.attributes['gen_ai.operation.name'] === 'chat').length, 2);
    } finally {
      await tracer.shutdown();
      await logs.provider.shutdown();
    }
  });

  it('OpenClaw preserves identical replies on separate real turns and never invents hidden reasoning', async () => {
    configure('openclaw');
    const tracer = makeInMemoryTracer();
    const logs = logger();
    const handlers = new Map<string, Handler>();
    const ctx = { sessionId: SESSION };
    registerOpenClawPlugin({ on(name, handler) { handlers.set(name, handler); } }, {
      tracerProvider: tracer.provider, meterProvider: null, loggerProvider: logs.provider,
    });
    try {
      for (let turn = 0; turn < 2; turn += 1) {
        await handlers.get('before_agent_reply')!({ cleanedBody: 'repeat question' }, ctx);
        await handlers.get('llm_input')!({ sessionId: SESSION, prompt: 'repeat question', runId: `run-${turn}` }, ctx);
        await handlers.get('llm_output')!({ assistantTexts: ['identical reply'], model: 'unrecognized-model', reasoningEffort: 'high' }, ctx);
        await handlers.get('agent_end')!({}, ctx);
      }
      const records = await logs.records();
      assert.deepEqual(records.map(r => r.attributes['nio.content.type']), ['user_prompt', 'text', 'user_prompt', 'text']);
      assert.deepEqual(records.filter(r => r.attributes['nio.content.type'] === 'text').map(r => r.body), ['identical reply', 'identical reply']);
      assert.equal(tracer.finished().filter(s => s.attributes['gen_ai.operation.name'] === 'chat').length, 2);
    } finally {
      await tracer.shutdown();
      await logs.provider.shutdown();
    }
  });
  it('opencode retains a live first call created before its callback was delivered', async () => {
    configure('opencode');
    const tracer = makeInMemoryTracer();
    const logs = logger();
    const created = Date.now() - 1000;
    try {
      const hooks = await createNioPlugin({ tracerProvider: tracer.provider, meterProvider: null, loggerProvider: logs.provider })({ directory: PROJECT, worktree: PROJECT });
      await hooks.event!({ event: { type: 'message.updated', properties: { info: { id: 'late-message', sessionID: SESSION, role: 'assistant', time: { created, completed: created + 10 } } } } });
      await hooks.event!({ event: { type: 'message.part.updated', properties: { part: { id: 'late-part', messageID: 'late-message', sessionID: SESSION, type: 'text', text: 'delayed live reply' } } } });
      await hooks.event!({ event: { type: 'session.idle', properties: { sessionID: SESSION } } });
      assert.deepEqual((await logs.records()).map(record => record.body), ['delayed live reply']);
      const chat = tracer.finished().find(span => span.attributes['gen_ai.operation.name'] === 'chat')!;
      assert.equal(chat.startTime[0] * 1000 + chat.startTime[1] / 1e6, created);
    } finally {
      await tracer.shutdown();
      await logs.provider.shutdown();
    }
  });

  it('Pi retains observed assistant content when the advertised session file is unavailable', async () => {
    configure('pi');
    const tracer = makeInMemoryTracer();
    const logs = logger();
    const handlers = new Map<string, Handler>();
    const ctx = { cwd: PROJECT, hasUI: false, sessionManager: { getSessionId: () => SESSION, getSessionFile: () => join(home, 'unavailable.jsonl') } };
    registerPiExtension({ on(name, handler) { handlers.set(name, handler); }, registerCommand() {} }, {
      tracerProvider: tracer.provider, meterProvider: null, loggerProvider: logs.provider,
    });
    try {
      await handlers.get('session_start')!({}, ctx);
      await handlers.get('message_end')!({ message: { id: 'observed-pi', role: 'assistant', timestamp: Date.now() - 1000, content: [{ type: 'text', text: 'observed fallback' }] } }, ctx);
      await handlers.get('agent_end')!({}, ctx);
      const records = await logs.records();
      assert.deepEqual(records.map(record => record.body), ['observed fallback']);
      assert.equal(records[0]!.attributes['nio.content.source'], 'pi-message-events');
      assert.equal(records[0]!.spanId, tracer.finished().find(span => span.attributes['gen_ai.operation.name'] === 'chat')!.spanContext().spanId);
    } finally {
      await tracer.shutdown();
      await logs.provider.shutdown();
    }
  });

  it('OpenClaw deduplicates an explicit lastAssistant identity across turn-close replay', async () => {
    configure('openclaw');
    const tracer = makeInMemoryTracer();
    const logs = logger();
    const handlers = new Map<string, Handler>();
    const ctx = { sessionId: SESSION };
    registerOpenClawPlugin({ on(name, handler) { handlers.set(name, handler); } }, {
      tracerProvider: tracer.provider, meterProvider: null, loggerProvider: logs.provider,
    });
    try {
      const event = { lastAssistant: { id: 'stable-assistant', content: [{ type: 'text', text: 'identified reply' }] } };
      for (let delivery = 0; delivery < 2; delivery++) {
        await handlers.get('llm_output')!(event, ctx);
        await handlers.get('agent_end')!({}, ctx);
      }
      assert.deepEqual((await logs.records()).map(record => record.body), ['identified reply']);
      assert.equal(tracer.finished().filter(span => span.attributes['gen_ai.operation.name'] === 'chat').length, 1);
    } finally {
      await tracer.shutdown();
      await logs.provider.shutdown();
    }
  });

  it('OpenClaw cannot claim cwd-scoped consent using its server launch directory', async () => {
    configure('openclaw', 'unarmed');
    const path = join(home, 'monitored-sessions.json');
    const store = { sessions: {}, pending_arm: { at: Date.now(), cwd: realpathSync(process.cwd()) } };
    writeFileSync(path, JSON.stringify(store));
    const tracer = makeInMemoryTracer();
    const logs = logger();
    try {
      const lifecycle = await bind('openclaw', tracer.provider, logs.provider);
      await lifecycle.prompt('unrelated private prompt');
      await lifecycle.reply('unrelated private reply');
      await lifecycle.end();
      assert.deepEqual(await logs.records(), []);
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), store);
    } finally {
      await tracer.shutdown();
      await logs.provider.shutdown();
    }
  });
});
