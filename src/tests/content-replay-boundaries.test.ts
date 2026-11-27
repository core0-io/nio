// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryLogRecordExporter, LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { registerPiExtension } from '../adapters/pi-plugin.js';
import { createPiSource } from '../scripts/lib/conversation/pi-source.js';
import { createClaudeCodeSource } from '../scripts/lib/conversation/claude-code-source.js';
import { makeInMemoryTracer } from './helpers/tracer.js';

describe('content transcript replay boundaries', () => {
  let home: string;
  let previousHome: string | undefined;
  beforeEach(() => {
    previousHome = process.env['NIO_HOME'];
    home = mkdtempSync(join(tmpdir(), 'nio-replay-boundary-'));
    process.env['NIO_HOME'] = home;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env['NIO_HOME'];
    else process.env['NIO_HOME'] = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  for (const rejected of ['message', 'prompt', 'none'] as const) {
    it(`Pi ${rejected}: replay honors observation-time consent and resets next turn`, async () => {
      const session = 'pi-replay-session';
      const cwd = '/workspaces/pi-replay';
      writeFileSync(join(home, 'config.yaml'), 'collector:\n  endpoint: "http://127.0.0.1:4318"\n  traces: { enabled: true }\n  logs: { enabled: true, local: false }\n');
      const arm = () => {
        writeFileSync(join(home, 'monitored-sessions.json'), JSON.stringify({
          sessions: { [session]: { armed_at: Date.now(), cwd } },
        }));
      };
      if (rejected !== 'prompt') arm();
      const entry = (id: string, text: string) => ({
        type: 'message', id, message: { id, role: 'assistant', timestamp: Date.now(), content: [{ type: 'text', text }] },
      });
      const transcript = join(home, 'pi.jsonl');
      const tracer = makeInMemoryTracer();
      const exporter = new InMemoryLogRecordExporter();
      const logger = new LoggerProvider({ processors: [new BatchLogRecordProcessor(exporter)] });
      const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
      registerPiExtension({ on(name, handler) { handlers.set(name, handler); }, registerCommand() {} }, {
        tracerProvider: tracer.provider, meterProvider: null, loggerProvider: logger,
      });
      const ctx = { cwd, hasUI: false, sessionManager: { getSessionId: () => session, getSessionFile: () => transcript } };
      const call = async (name: string, event: unknown = {}) => { await handlers.get(name)!(event, ctx); };
      try {
        await call('session_start');
        await call('input', { text: rejected === 'prompt' ? 'unconsented prompt' : 'initial prompt' });
        const fileEntry = entry('file-message', 'file-only-response');
        writeFileSync(transcript, JSON.stringify(fileEntry) + '\n');
        if (rejected === 'message') {
          writeFileSync(join(home, 'monitored-sessions.json'), '{"sessions":{}}');
          await call('message_end', { message: fileEntry.message });
        }
        arm();
        if (rejected !== 'none') await call('input', { text: 'eligible prompt' });
        await call('message_end', { message: entry('live-message', 'eligible-live-response').message });
        await call('agent_end');
        await logger.forceFlush();
        const outputs = exporter.getFinishedLogRecords().filter(record => record.attributes['gen_ai.output.messages']);
        const expectedTexts = rejected === 'none'
          ? ['file-only-response', 'eligible-live-response'] : ['eligible-live-response'];
        assert.equal(outputs.length, expectedTexts.length);
        assert.deepEqual(outputs.flatMap(record =>
          (record.attributes['gen_ai.output.messages'] as { role: string; parts: { type: string; content: string }[] }[])
            .flatMap(message => message.parts.map(part => part.content))), expectedTexts);
        const firstTurn = tracer.finished().find(span => span.attributes['gen_ai.operation.name'] === 'invoke_agent');
        assert.ok(firstTurn);
        assert.equal(outputs[0]!.spanContext?.traceId, firstTurn.spanContext().traceId);
        assert.equal(outputs[0]!.spanContext?.spanId, firstTurn.spanContext().spanId);

        // Rejection is turn-scoped, not a permanent ban on this session's transcript.
        await call('input', { text: 'next turn' });
        writeFileSync(transcript, JSON.stringify(entry('next-file-message', 'next-turn-replay')) + '\n');
        await call('agent_end');
        await logger.forceFlush();
        const next = exporter.getFinishedLogRecords().filter(record => record.attributes['gen_ai.output.messages']);
        assert.equal(next.length, expectedTexts.length + 1);
        const nextOutput = next.at(-1)!;
        assert.deepEqual(nextOutput.attributes['gen_ai.output.messages'], [{
          role: 'assistant', finish_reason: 'unknown', parts: [{ type: 'text', content: 'next-turn-replay' }],
        }]);
        assert.notEqual(nextOutput.spanContext?.traceId, outputs[0]!.spanContext?.traceId);
      } finally {
        await logger.shutdown();
        await tracer.shutdown();
      }
    });
  }

  it('Pi session header and old assistant replay do not suppress current observed output', () => {
    const path = join(home, 'pi-fallback.jsonl');
    writeFileSync(path, [
      { type: 'session', id: 'session-header' },
      { type: 'message', id: 'old-assistant', message: { role: 'assistant', timestamp: 10, content: 'old content' } },
      { type: 'message', id: 'current-tool-only', message: { role: 'assistant', timestamp: 100, content: [{ type: 'toolCall', name: 'bash' }] } },
    ].map(entry => JSON.stringify(entry)).join('\n'));
    const messages = createPiSource(path, [{ type: 'message', id: 'observed-current', message: {
      role: 'assistant', timestamp: 100, content: [{ type: 'text', text: 'current response' }],
    } }]).messagesSince(50);
    assert.deepEqual(messages.map(message => ({ id: message.id, blocks: message.blocks })), [{
      id: 'observed-current', blocks: [{ type: 'text', index: 0, content: 'current response', sourceId: undefined }],
    }]);
  });

  it('Pi merges partially flushed replay with live messages without duplicating the same observed occurrence', () => {
    const path = join(home, 'pi-partial.jsonl');
    const message = { role: 'assistant', timestamp: 100, content: [{ type: 'text', text: 'repeat' }] };
    writeFileSync(path, JSON.stringify({ type: 'message', id: 'real-entry-id', message }) + '\n');
    const observed = { type: 'message', message };
    const messages = createPiSource(path, [observed, observed]).messagesSince(50);
    assert.deepEqual(messages.map(message => message.blocks.map(block => block.content)), [['repeat'], ['repeat']]);
    assert.equal(messages[0]!.id, 'real-entry-id');
    assert.notEqual(messages[1]!.id, messages[0]!.id);
  });

  it('Claude explicit sidechain content cannot merge into a parent message with the same host ID', () => {
    const path = join(home, 'claude.jsonl');
    writeFileSync(path, [
      { type: 'assistant', uuid: 'parent-entry', timestamp: '2026-01-01T00:00:01Z', message: { id: 'host-message', content: [{ type: 'text', text: 'parent response' }] } },
      { type: 'assistant', uuid: 'child-entry', isSidechain: true, timestamp: '2026-01-01T00:00:02Z', message: { id: 'host-message', content: [{ type: 'text', text: 'private child response' }] } },
      { type: 'assistant', uuid: 'child-other', isSidechain: true, timestamp: '2026-01-01T00:00:03Z', message: { id: 'child-message', content: [{ type: 'thinking', thinking: 'private child reasoning' }] } },
    ].map(entry => JSON.stringify(entry)).join('\n'));
    const messages = createClaudeCodeSource(path).messagesSince(Date.parse('2026-01-01T00:00:00Z'));
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.id, 'host-message');
    assert.deepEqual(messages[0]!.blocks.map(block => block.content), ['parent response']);
  });
});
