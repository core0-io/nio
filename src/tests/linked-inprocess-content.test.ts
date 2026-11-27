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

type Message = { role: string; parts: { type: string; content?: string }[] };
const messages = (record: { attributes: Record<string, unknown> }, direction: 'input' | 'output'): Message[] =>
  (record.attributes[`gen_ai.${direction}.messages`] ?? []) as Message[];
const outputTexts = (records: { attributes: Record<string, unknown> }[]) =>
  records.flatMap(record => messages(record, 'output')).flatMap(message =>
    message.parts.filter(part => part.type === 'text').map(part => part.content));

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
const TOOL_SECRET = 'private-summary-value'.repeat(40);

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
      async pre(body) { await call('tool_call', { toolName: 'bash', toolCallId: 'tool-1', input: { command: `echo ${body}`, api_key: TOOL_SECRET } }, ctx); },
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
      async pre(body) { await call('before_tool_call', { toolName: 'exec', toolCallId: 'tool-1', params: { command: `echo ${body}`, api_key: TOOL_SECRET } }, ctx); },
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
    async pre(body) { await hooks['tool.execute.before']!({ tool: 'bash', sessionID: SESSION, callID: 'tool-1' }, { args: { command: `echo ${body}`, api_key: TOOL_SECRET } }); },
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
      return exporter.getFinishedLogRecords().filter(record =>
        record.attributes['gen_ai.input.messages'] || record.attributes['gen_ai.output.messages']).map(record => {
        assert.ok(record.spanContext, 'OTLP built-in trace/span fields must be present');
        assert.equal(record.body, undefined, 'payload is not copied into body');
        return contentRecordSchema.parse({
          attributes: record.attributes,
          traceId: record.spanContext.traceId, spanId: record.spanContext.spanId,
        });
      });
    };
    return { provider, records };
  }

  for (const host of HOSTS) {
    for (const size of ['short', 'long'] as const) {
      it(`${host}: ${size} structured messages use existing turn spans and preserve Trace fields`, async () => {
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
          assert.equal(early.length, 1, 'tool arguments must not force content logs');
          await lifecycle.post(body);
          await lifecycle.end();
          await lifecycle.end();
          const records = await logs.records();
          assert.equal(records.length, 2, 'one prompt and one assistant message, not one per part');
          const spans = tracer.finished();
          const turn = spans.find(s => s.attributes['gen_ai.operation.name'] === 'invoke_agent');
          const tool = spans.find(s => s.attributes['gen_ai.operation.name'] === 'execute_tool');
          assert.ok(turn); assert.ok(tool);
          assert.equal(spans.filter(s => s.attributes['gen_ai.operation.name'] === 'chat').length, 0);
          assert.equal(spans.length, 2, 'no extra model/chat spans');
          const prompt = records.find(r => messages(r, 'input').length)!;
          assert.deepEqual(messages(prompt, 'input'), [{
            role: 'user', parts: [{ type: 'text', content: `prompt:${body}` }],
          }]);
          const output = records.find(r => messages(r, 'output').length)!;
          const [assistant] = messages(output, 'output');
          assert.equal(assistant.role, 'assistant');
          assert.deepEqual(assistant.parts, [
            { type: 'reasoning', content: `think:${body}` },
            { type: 'text', content: `reply:${body}` },
            { type: 'text', content: `reply:${body}` },
            { type: 'reasoning', content: `after:${body}` },
          ]);
          for (const record of records) {
            assert.equal(record.traceId, turn.spanContext().traceId);
            assert.equal(record.spanId, turn.spanContext().spanId);
          }
          assert.equal(tool.parentSpanContext?.spanId, turn.spanContext().spanId);
          assert.ok(String(turn.attributes['nio.turn.user_prompt']).includes('prompt:'));
          if (host === 'openclaw') assert.ok(String(turn.attributes['nio.turn.assistant_reply']).includes('reply:'));
          else assert.equal(turn.attributes['nio.turn.assistant_reply'], undefined, 'structured source capture must not invent new Trace reply writes');
          assert.ok(String(tool.attributes['gen_ai.tool.call.arguments']).includes('echo '));
          assert.ok(String(tool.attributes['gen_ai.tool.call.result']).includes('result:'));
          assert.ok(String(tool.attributes['nio.tool_summary']).includes('echo '));
          assert.ok(!JSON.stringify(spans.map(span => span.attributes)).includes('private-summary-value'));
          if (size === 'short') {
            assert.equal(turn.attributes['nio.turn.user_prompt'], `prompt:${body}`);
            if (host === 'openclaw') assert.equal(turn.attributes['nio.turn.assistant_reply'], `reply:${body}\nreply:${body}`);
            assert.deepEqual(JSON.parse(String(tool.attributes['gen_ai.tool.call.arguments'])), { command: `echo ${body}`, api_key: '[REDACTED]' });
            assert.equal(tool.attributes['gen_ai.tool.call.result'],
              host === 'pi' ? JSON.stringify([{ type: 'text', text: `result:${body}` }]) : `result:${body}`);
            assert.equal(tool.attributes['nio.tool_summary'],
              host === 'openclaw' ? `echo ${body}` : JSON.stringify({ command: `echo ${body}`, api_key: '[REDACTED]' }));
          }
          for (const span of spans) {
            assert.equal(span.attributes['gen_ai.response.id'], undefined);
            assert.ok(!Object.keys(span.attributes).some(key => key.startsWith('nio.chat.')));
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
    it(`${host}: content observed before consent is not buffered for later export`, async () => {
      configure(host, 'unarmed');
      const tracer = makeInMemoryTracer();
      const logs = logger();
      try {
        const lifecycle = await bind(host, tracer.provider, logs.provider);
        await lifecycle.prompt('unconsented prompt');
        await lifecycle.reply('unconsented assistant');
        configure(host);
        await lifecycle.end();
        assert.deepEqual(await logs.records(), []);
      } finally {
        await tracer.shutdown();
        await logs.provider.shutdown();
      }
    });
    if (host !== 'openclaw') it(`${host}: replayed assistant identity does not emit another content batch`, async () => {
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
        assert.equal(tracer.finished().filter(s => s.attributes['gen_ai.operation.name'] === 'chat').length, 0);
      } finally {
        await tracer.shutdown();
        await logs.provider.shutdown();
      }
    });
  }

  it('Pi replays the session file across turns without replaying observed messages', async () => {
    configure('pi');
    const tracer = makeInMemoryTracer();
    const logs = logger();
    const handlers = new Map<string, Handler>();
    const transcript = join(home, 'linked-pi-session.jsonl');
    const entry = (id: string, text: string) => {
      const timestamp = Date.now();
      return JSON.stringify({
        type: 'message', id, timestamp: new Date(timestamp).toISOString(),
        message: { role: 'assistant', timestamp, model: 'claude-sonnet-4', content: [{ type: 'text', text }] },
      }) + '\n';
    };
    const ctx = { cwd: PROJECT, hasUI: false, sessionManager: { getSessionId: () => SESSION, getSessionFile: () => transcript } };
    registerPiExtension({ on(name, handler) { handlers.set(name, handler); }, registerCommand() {} }, {
      tracerProvider: tracer.provider, meterProvider: null, loggerProvider: logs.provider,
    });
    try {
      await handlers.get('session_start')!({}, ctx);
      await handlers.get('input')!({ text: 'first question' }, ctx);
      const first = entry('first-assistant', 'first answer');
      writeFileSync(transcript, first);
      await handlers.get('agent_end')!({}, ctx);
      await handlers.get('input')!({ text: 'second question' }, ctx);
      writeFileSync(transcript, first + entry('second-assistant', 'second answer'));
      await handlers.get('agent_end')!({}, ctx);
      await handlers.get('agent_end')!({}, ctx);
      assert.deepEqual(outputTexts(await logs.records()), ['first answer', 'second answer']);
      assert.equal(tracer.finished().filter(s => s.attributes['gen_ai.operation.name'] === 'chat').length, 0);
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
        await handlers.get('llm_output')!({ assistantTexts: ['identical reply'], lastAssistant: { role: 'assistant', content: 'identical reply' }, model: 'unrecognized-model', reasoningEffort: 'high' }, ctx);
        await handlers.get('agent_end')!({}, ctx);
      }
      const records = await logs.records();
      assert.equal(records.length, 4);
      assert.deepEqual(outputTexts(records), ['identical reply', 'identical reply']);
      assert.ok(records.flatMap(record => messages(record, 'output')).every(message =>
        message.parts.every(part => part.type === 'text')), 'configuration is not observed reasoning');
      assert.equal(tracer.finished().filter(s => s.attributes['gen_ai.operation.name'] === 'chat').length, 0);
    } finally {
      await tracer.shutdown();
      await logs.provider.shutdown();
    }
  });
  it('opencode retains an assistant message created before its callback was delivered', async () => {
    configure('opencode');
    const tracer = makeInMemoryTracer();
    const logs = logger();
    const created = Date.now() - 1000;
    try {
      const hooks = await createNioPlugin({ tracerProvider: tracer.provider, meterProvider: null, loggerProvider: logs.provider })({ directory: PROJECT, worktree: PROJECT });
      await hooks.event!({ event: { type: 'message.updated', properties: { info: { id: 'late-message', sessionID: SESSION, role: 'assistant', time: { created, completed: created + 10 } } } } });
      await hooks.event!({ event: { type: 'message.part.updated', properties: { part: { id: 'late-part', messageID: 'late-message', sessionID: SESSION, type: 'text', text: 'delayed live reply' } } } });
      await hooks.event!({ event: { type: 'session.idle', properties: { sessionID: SESSION } } });
      const records = await logs.records();
      assert.deepEqual(outputTexts(records), ['delayed live reply']);
      const turn = tracer.finished().find(span => span.attributes['gen_ai.operation.name'] === 'invoke_agent')!;
      assert.equal(records[0]!.spanId, turn.spanContext().spanId);
    } finally {
      await tracer.shutdown();
      await logs.provider.shutdown();
    }
  });

  it('opencode groups ordered repeated input parts as one message and rejects malformed parts', async () => {
    configure('opencode');
    const tracer = makeInMemoryTracer();
    const logs = logger();
    try {
      const hooks = await createNioPlugin({ tracerProvider: tracer.provider, meterProvider: null, loggerProvider: logs.provider })({ directory: PROJECT, worktree: PROJECT });
      await hooks['chat.message']!({}, { message: { id: 'malformed', sessionID: SESSION }, parts: 'not an array' });
      const output = { message: { sessionID: SESSION }, parts: [
        { id: 'input-a', type: 'text', text: 'first' },
        { id: 'input-b', type: 'text', text: 'first' },
        { id: 'image', type: 'image' },
        { id: 'input-c', type: 'text', text: 'last' },
      ] };
      await hooks['chat.message']!({}, output);
      await hooks['chat.message']!({}, output);
      await hooks.event!({ event: { type: 'session.idle', properties: { sessionID: SESSION } } });
      const records = await logs.records();
      assert.equal(records.length, 1);
      assert.deepEqual(messages(records[0]!, 'input'), [{
        role: 'user', parts: [
          { type: 'text', content: 'first' }, { type: 'text', content: 'first' }, { type: 'text', content: 'last' },
        ],
      }]);
      const turn = tracer.finished().find(span => span.attributes['gen_ai.operation.name'] === 'invoke_agent')!;
      assert.equal(turn.attributes['nio.turn.user_prompt'], 'first\nfirst\nlast');
      assert.equal(records[0]!.spanId, turn.spanContext().spanId);
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
      await handlers.get('message_end')!({ message: { id: 'observed-pi', role: 'assistant', timestamp: Date.now() - 1000, content: 'observed fallback' } }, ctx);
      await handlers.get('agent_end')!({}, ctx);
      const records = await logs.records();
      assert.deepEqual(outputTexts(records), ['observed fallback']);
      const turn = tracer.finished().find(span => span.attributes['gen_ai.operation.name'] === 'invoke_agent')!;
      assert.equal(records[0]!.spanId, turn.spanContext().spanId);
      assert.equal(turn.attributes['nio.turn.assistant_reply'], 'observed fallback');
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
      assert.deepEqual(outputTexts(await logs.records()), ['identified reply']);
      assert.equal(tracer.finished().filter(span => span.attributes['gen_ai.operation.name'] === 'chat').length, 0);
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
