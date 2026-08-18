// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * `nio.turn.user_prompt` — the attribute that was empty on every
 * `invoke_agent` span in production while looking fully covered here.
 *
 * Two properties of the REAL host behaviour make the difference, and
 * both are encoded in the fixtures below rather than assumed:
 *
 *  1. Claude Code's UserPromptSubmit payload has NO `prompt` field. It
 *     carries `prompt_id`. Every pre-existing fixture in this suite
 *     invented a `prompt`, so the only branch that ever set the
 *     attribute was one production never took.
 *  2. The transcript line for that prompt is stamped BEFORE the hook
 *     runs (measured: 164–758 ms earlier, 19/19 prompts). So a filter
 *     anchored at the turn's start — which is taken inside the hook —
 *     excludes the very message it is looking for. The fixtures stamp
 *     their user lines in the past for exactly this reason; a fixture
 *     that stamped them "now" would pass against a reader that can
 *     never work live.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-node';

import { dispatchCollectorEvent } from '../scripts/lib/collector-core.js';
import { lastUserMessageSince } from '../scripts/lib/conversation/claude-code-source.js';
import type { ResolvedMetricsConfig, CollectorLogsConfig } from '../adapters/common.js';
import { makeInMemoryTracer } from './helpers/tracer.js';
import { trackTempDir } from './helpers/tmp-dirs.js';

// The payload shape Claude Code ACTUALLY sends: prompt_id, no prompt.
const REAL_PAYLOAD = {
  hook_event_name: 'UserPromptSubmit',
  session_id: 'sess-prompt',
  prompt_id: 'pr_123',
  cwd: '/work',
  permission_mode: 'default',
};

const baseConfig: ResolvedMetricsConfig = {
  endpoint: '',
  api_key: '',
  timeout: 5000,
  protocol: 'http',
  enabled: true,
  metrics_enabled: true,
  traces_enabled: true,
  logs_enabled: true,
};

function userLine(opts: {
  ms: number;
  content: unknown;
  isMeta?: boolean;
  isSidechain?: boolean;
}): string {
  return JSON.stringify({
    type: 'user',
    timestamp: new Date(opts.ms).toISOString(),
    promptId: 'pr_123',
    ...(opts.isMeta ? { isMeta: true } : {}),
    ...(opts.isSidechain ? { isSidechain: true } : {}),
    message: { role: 'user', content: opts.content },
  });
}

function turnRoots(spans: readonly ReadableSpan[]): readonly ReadableSpan[] {
  return spans.filter((s) => s.attributes['gen_ai.operation.name'] === 'invoke_agent');
}

describe('turn user prompt', () => {
  let dir: string;
  let logsConfig: CollectorLogsConfig;

  beforeEach(() => {
    dir = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-prompt-')));
    logsConfig = { enabled: true, local: true, path: join(dir, 'audit.jsonl'), max_size_mb: 100 };
  });

  it('reads the prompt from the transcript when the payload omits it', () => {
    const t = join(dir, 'transcript.jsonl');
    writeFileSync(t,
      JSON.stringify({ type: 'user', timestamp: '2026-08-06T03:00:00.000Z',
                       message: { role: 'user', content: 'first question' } }) + '\n' +
      JSON.stringify({ type: 'user', timestamp: '2026-08-06T03:05:00.000Z',
                       message: { role: 'user', content: [{ type: 'text', text: 'second question' }] } }) + '\n',
      'utf-8');

    assert.equal(lastUserMessageSince(t, 0), 'second question');
  });

  it('respects sinceMs so a turn does not pick up the previous turn prompt', () => {
    const t = join(dir, 'transcript.jsonl');
    writeFileSync(t,
      JSON.stringify({ type: 'user', timestamp: '2026-08-06T03:00:00.000Z',
                       message: { role: 'user', content: 'old' } }) + '\n', 'utf-8');

    assert.equal(lastUserMessageSince(t, Date.parse('2026-08-06T03:01:00.000Z')), null);
  });

  it('ignores the user-typed lines that are not the user talking', () => {
    // All three shapes are live-observed: of 187 `type: 'user'` lines in
    // six real transcripts, 154 were tool results and 13 were `isMeta`
    // host-injected context carrying a real text block. Picking either
    // up would stamp the turn with something the user never wrote.
    const base = Date.parse('2026-08-06T03:00:00.000Z');
    const t = join(dir, 'transcript.jsonl');
    writeFileSync(t, [
      userLine({ ms: base, content: 'the actual question' }),
      userLine({ ms: base + 1000, content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] }),
      userLine({ ms: base + 2000, content: [{ type: 'text', text: 'injected context' }], isMeta: true }),
      userLine({ ms: base + 3000, content: 'sub-agent instructions', isSidechain: true }),
      '',
    ].join('\n'), 'utf-8');

    assert.equal(lastUserMessageSince(t, 0), 'the actual question');
  });

  it('never throws on a missing or malformed transcript', () => {
    assert.equal(lastUserMessageSince('/nonexistent.jsonl', 0), null);
    const bad = join(dir, 'bad.jsonl');
    // `null`, `[1,2,3]` and `42` all PARSE — JSON.parse does not throw on
    // them — so the per-line try/catch never sees them and only a type
    // guard stops the property read from throwing.
    writeFileSync(bad, 'null\n[1,2,3]\nnot json\n42\n', 'utf-8');
    assert.equal(lastUserMessageSince(bad, 0), null);
  });

  it('sets nio.turn.user_prompt from a payload that has no prompt field', async () => {
    const tracer = makeInMemoryTracer();
    const transcript = join(dir, 'transcript.jsonl');
    // Stamped in the past on purpose: that is where the host puts it.
    writeFileSync(transcript, userLine({ ms: Date.now() - 500, content: 'why is the build red?' }) + '\n', 'utf-8');

    const common = {
      platform: 'claude-code',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: tracer.provider,
      logsConfig,
    } as const;

    await dispatchCollectorEvent({
      ...common,
      event: 'UserPromptSubmit',
      input: { ...REAL_PAYLOAD, transcript_path: transcript },
    });
    await dispatchCollectorEvent({
      ...common,
      event: 'Stop',
      input: { session_id: REAL_PAYLOAD.session_id, cwd: REAL_PAYLOAD.cwd, transcript_path: transcript },
    });

    const roots = turnRoots(await tracer.flushed());
    assert.equal(roots.length, 1, 'the turn must open on UserPromptSubmit and close on Stop');
    assert.equal(
      roots[0]!.attributes['nio.turn.user_prompt'],
      'why is the build red?',
      'the prompt must come off the transcript when the payload has no `prompt` field',
    );
  });

  it('the payload wins when a platform does send the text', async () => {
    const tracer = makeInMemoryTracer();
    const transcript = join(dir, 'transcript.jsonl');
    writeFileSync(transcript, userLine({ ms: Date.now() - 500, content: 'transcript copy' }) + '\n', 'utf-8');

    const common = {
      platform: 'openclaw',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: tracer.provider,
      logsConfig,
    } as const;

    await dispatchCollectorEvent({
      ...common,
      event: 'UserPromptSubmit',
      input: { session_id: 'sess-payload', cwd: '/work', prompt: 'payload text', transcript_path: transcript },
    });
    await dispatchCollectorEvent({
      ...common,
      event: 'Stop',
      input: { session_id: 'sess-payload', cwd: '/work' },
    });

    const roots = turnRoots(await tracer.flushed());
    assert.equal(roots.length, 1);
    assert.equal(roots[0]!.attributes['nio.turn.user_prompt'], 'payload text');
  });

  it('does not adopt a stale transcript prompt as this turn\'s', async () => {
    const tracer = makeInMemoryTracer();
    const transcript = join(dir, 'transcript.jsonl');
    // A resumed transcript: its newest user message belongs to an
    // earlier session, not to the turn opening now.
    writeFileSync(transcript, userLine({ ms: Date.now() - 3_600_000, content: 'an hour-old question' }) + '\n', 'utf-8');

    const common = {
      platform: 'claude-code',
      config: baseConfig,
      meterProvider: null,
      tracerProvider: tracer.provider,
      logsConfig,
    } as const;

    await dispatchCollectorEvent({
      ...common,
      event: 'UserPromptSubmit',
      input: { ...REAL_PAYLOAD, session_id: 'sess-stale', transcript_path: transcript },
    });
    await dispatchCollectorEvent({
      ...common,
      event: 'Stop',
      input: { session_id: 'sess-stale', cwd: REAL_PAYLOAD.cwd, transcript_path: transcript },
    });

    const roots = turnRoots(await tracer.flushed());
    assert.equal(roots.length, 1, 'the turn still opens and closes — only the prompt is withheld');
    assert.equal(
      roots[0]!.attributes['nio.turn.user_prompt'],
      undefined,
      'no prompt is better than the wrong prompt',
    );
  });
});
