// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

// Every event below is hand-synthesised from the shapes in opencode's
// SDK type definitions (`packages/sdk/js/src/gen/types.gen.ts`). The
// source is a pure in-memory transform: these tests read no session
// file and touch no directory under the developer's home.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenCodeSource } from '../scripts/lib/conversation/opencode-source.js';
import { blockOrderIsSane } from '../scripts/lib/conversation/types.js';

// One assistant message with reasoning, text and a tool part, in the
// shape the binding accumulates from message.updated / message.part.updated.
const EVENTS: unknown[] = [
  {
    kind: 'message',
    info: {
      id: 'msg_1', sessionID: 'sess_1', role: 'assistant',
      modelID: 'claude-sonnet-4-5', providerID: 'anthropic',
      tokens: { input: 10, output: 20, reasoning: 7, cache: { read: 5, write: 2 } },
      time: { created: 1785060002000, completed: 1785060004000 },
    },
  },
  { kind: 'part', part: { id: 'prt_1', type: 'reasoning', messageID: 'msg_1', text: 'Consider the options.', time: { start: 1785060002100, end: 1785060002500 } } },
  { kind: 'part', part: { id: 'prt_2', type: 'text', messageID: 'msg_1', text: 'Here is the answer.' } },
  { kind: 'part', part: { id: 'prt_3', type: 'tool', messageID: 'msg_1', callID: 'call_9', tool: 'bash', state: { input: { command: 'ls' } } } },
];

/** The assistant envelope from EVENTS, re-usable with an overridden field. */
function assistantMessage(over: Record<string, unknown> = {}): unknown {
  return {
    kind: 'message',
    info: {
      id: 'msg_1', sessionID: 'sess_1', role: 'assistant',
      modelID: 'claude-sonnet-4-5', providerID: 'anthropic',
      tokens: { input: 10, output: 20, reasoning: 7, cache: { read: 5, write: 2 } },
      time: { created: 1785060002000, completed: 1785060004000 },
      ...over,
    },
  };
}

const TEXT_PART = {
  kind: 'part',
  part: { id: 'prt_2', type: 'text', messageID: 'msg_1', text: 'Here is the answer.' },
};

describe('opencode-source', () => {
  it('yields one call per assistant message', () => {
    assert.equal(createOpenCodeSource(EVENTS).callsSince(0).length, 1);
  });

  it('preserves part order as block order', () => {
    const [call] = createOpenCodeSource(EVENTS).callsSince(0);
    assert.deepEqual(call.blocks.map((b) => b.type), ['thinking', 'text', 'tool_use']);
    assert.ok(blockOrderIsSane(call));
  });

  it('reads reasoning text out of the reasoning part', () => {
    const [call] = createOpenCodeSource(EVENTS).callsSince(0);
    assert.equal(call.blocks[0].content, 'Consider the options.');
    assert.equal(call.blocks[1].content, 'Here is the answer.');
  });

  it('carries the message id as the call id and modelID as the model', () => {
    const [call] = createOpenCodeSource(EVENTS).callsSince(0);
    assert.equal(call.callId, 'msg_1');
    assert.equal(call.model, 'claude-sonnet-4-5');
    assert.equal(call.isSidechain, false);
  });

  it('marks a Claude-model call as full fidelity', () => {
    const [call] = createOpenCodeSource(EVENTS).callsSince(0);
    assert.equal(call.blocks[0].fidelity, 'full');
  });

  // The other direction of the same wiring. Pinning only the Claude side
  // would let a hard-coded `'full'` through undetected.
  it('marks a withheld-CoT model as summary fidelity', () => {
    const events = [
      assistantMessage({ providerID: 'openai', modelID: 'gpt-5-codex' }),
      ...EVENTS.slice(1),
    ];
    const [call] = createOpenCodeSource(events).callsSince(0);
    assert.equal(call.blocks[0].type, 'thinking');
    assert.equal(call.blocks[0].fidelity, 'summary');
  });

  // opencode must hand `modelID` to the fidelity rule. These three all
  // arrive through the SAME aggregator providerID, exactly as observed
  // in the field, so a rule reading providerID cannot tell them apart —
  // it would report one value for all three.
  it('reads fidelity from modelID, not from the aggregator providerID', () => {
    const verdicts = (['glm-5.2', 'gpt-oss:120b', 'mystery-thinker-9'] as const).map((modelID) => {
      const events = [
        assistantMessage({ providerID: 'ollama-cloud', modelID }),
        ...EVENTS.slice(1),
      ];
      return createOpenCodeSource(events).callsSince(0)[0].blocks[0].fidelity;
    });
    assert.deepEqual(verdicts, ['full', 'summary', 'unknown']);
  });

  it('extracts the tool call id, name and serialised input', () => {
    const [call] = createOpenCodeSource(EVENTS).callsSince(0);
    const tool = call.blocks.find((b) => b.type === 'tool_use');
    assert.equal(tool?.toolUse?.id, 'call_9');
    assert.equal(tool?.toolUse?.name, 'bash');
    assert.equal(tool?.toolUse?.input, JSON.stringify({ command: 'ls' }));
  });

  // opencode is the ONLY platform reporting both ends of a call, so it is
  // the only one that earns 'exact'. Downgrading this to 'synthetic'
  // silently disables buildSpanTree's time-window tool attribution.
  it('reports exact timing from the message time range', () => {
    const [call] = createOpenCodeSource(EVENTS).callsSince(0);
    assert.equal(call.timing, 'exact');
    assert.equal(call.startMs, 1785060002000);
    assert.equal(call.endMs, 1785060004000);
  });

  it('maps the nested cache token shape and the reasoning count', () => {
    const [call] = createOpenCodeSource(EVENTS).callsSince(0);
    assert.deepEqual(call.usage, {
      input: 10, output: 20, cacheRead: 5, cacheWrite: 2, reasoning: 7,
    });
  });

  it('falls back to inferred timing when the message has not completed', () => {
    const open = [
      { kind: 'message', info: { id: 'm', sessionID: 's', role: 'assistant', providerID: 'anthropic', time: { created: 1000 } } },
      { kind: 'part', part: { id: 'p', type: 'text', messageID: 'm', text: 'partial' } },
    ];
    const [call] = createOpenCodeSource(open).callsSince(0);
    assert.equal(call.timing, 'inferred');
    assert.equal(call.startMs, 1000);
    assert.equal(call.endMs, 1000);
    assert.equal(call.usage, undefined);
  });

  it('ignores user messages and returns empty for no events', () => {
    const userOnly = [{ kind: 'message', info: { id: 'u', role: 'user', time: { created: 1 } } }];
    assert.deepEqual(createOpenCodeSource(userOnly).callsSince(0), []);
    assert.deepEqual(createOpenCodeSource([]).callsSince(0), []);
  });

  // A part whose message envelope never arrives (or arrived as a user
  // message) must not conjure a call out of nothing.
  it('produces no call for parts with no assistant envelope', () => {
    const orphaned = [
      { kind: 'message', info: { id: 'u', role: 'user', time: { created: 1 } } },
      { kind: 'part', part: { id: 'p1', type: 'text', messageID: 'u', text: 'user text' } },
      { kind: 'part', part: { id: 'p2', type: 'text', messageID: 'nobody', text: 'orphan' } },
    ];
    assert.deepEqual(createOpenCodeSource(orphaned).callsSince(0), []);
  });

  it('never throws on malformed events', () => {
    const junk = [null, 'string', 42, [], {}, { kind: 'part', part: null }];
    assert.deepEqual(createOpenCodeSource(junk).callsSince(0), []);
    assert.deepEqual(createOpenCodeSource(null as unknown as unknown[]).callsSince(0), []);
  });

  // The malformed-only case above is satisfied by any implementation
  // that returns nothing. This one feeds the SAME junk interleaved with
  // a real message and pins the exact surviving output, so a source that
  // aborts its loop on the first bad record cannot pass.
  it('skips malformed events without losing the surrounding call', () => {
    const mixed: unknown[] = [
      null,
      'string',
      42,
      [{ kind: 'message' }],
      { kind: 'message' },
      { kind: 'message', info: null },
      { kind: 'message', info: 'nope' },
      { kind: 'message', info: { role: 'assistant', time: { created: 1 } } }, // no id
      EVENTS[0],
      { kind: 'part', part: null },
      { kind: 'part', part: 7 },
      { kind: 'part', part: {} }, // no messageID
      { kind: 'part', part: { id: 'x', type: 'text', messageID: 99, text: 'bad id type' } },
      EVENTS[1],
      { kind: 'unknown-kind', part: { type: 'text', messageID: 'msg_1', text: 'wrong kind' } },
      EVENTS[2],
      { kind: 'part', part: { id: 'prt_9', type: 'step-start', messageID: 'msg_1' } },
      EVENTS[3],
      undefined,
    ];
    const calls = createOpenCodeSource(mixed).callsSince(0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].blocks.map((b) => b.type), ['thinking', 'text', 'tool_use']);
    assert.equal(calls[0].blocks[0].content, 'Consider the options.');
    assert.equal(calls[0].blocks[1].content, 'Here is the answer.');
    assert.equal(calls[0].callId, 'msg_1');
    assert.ok(blockOrderIsSane(calls[0]));
  });

  // Unlike every other ConversationSource, this one is NOT reading
  // `JSON.parse` output: the module doc says so explicitly, and the
  // binding hands over the live SDK objects opencode published. A
  // property read on one of those is a call into host code, so a getter
  // or a Proxy trap can throw where a parsed record never could — and
  // `callsSince` runs inside a host-blocking hook. `serialiseInput`
  // already guarded the one place that stringifies; the bare reads
  // (`info.role`, `part.id`, `p.type`, …) did not, and a throwing getter
  // on `e.info` or a hostile Proxy part took the whole turn's
  // reconstruction with it.
  //
  // The surviving good call is what makes this discriminating: a source
  // that simply returned `[]` on any throw would satisfy "does not
  // throw" while still losing everything.
  it('survives host objects whose property reads throw, keeping the calls around them', () => {
    const throwingInfo = {
      kind: 'message',
      get info(): never { throw new Error('host getter exploded'); },
    };
    const hostileProxyPart = {
      kind: 'part',
      part: new Proxy({}, {
        get(): never { throw new Error('proxy trap exploded'); },
      }),
    };
    // A part that accumulates cleanly but blows up when the call is
    // built — this one gets past the first loop and into `callFrom`.
    const lateThrowingPart = {
      kind: 'part',
      part: {
        id: 'prt_late', messageID: 'msg_late',
        get type(): never { throw new Error('late getter exploded'); },
      },
    };
    const lateMessage = {
      kind: 'message',
      info: {
        id: 'msg_late', sessionID: 'sess_1', role: 'assistant',
        modelID: 'claude-sonnet-4-5', providerID: 'anthropic',
        time: { created: 1785060002000, completed: 1785060004000 },
      },
    };

    const events: unknown[] = [
      throwingInfo,
      hostileProxyPart,
      lateMessage,
      lateThrowingPart,
      EVENTS[0], EVENTS[1], EVENTS[2], EVENTS[3],
    ];

    let calls: ReturnType<ReturnType<typeof createOpenCodeSource>['callsSince']> = [];
    assert.doesNotThrow(() => { calls = createOpenCodeSource(events).callsSince(0); });
    assert.equal(
      calls.length, 1,
      'the healthy message must still produce its call — msg_late contributes none because its ' +
        'only part threw while its blocks were being read',
    );
    assert.equal(calls[0].callId, 'msg_1');
    assert.deepEqual(calls[0].blocks.map((b) => b.type), ['thinking', 'text', 'tool_use']);
  });

  // `message.updated` is a SNAPSHOT: opencode republishes the whole
  // assistant message on every change. Appending instead of replacing
  // gives one call per republish and N× the tokens — the same N(N+1)/2
  // replay amplification Hermes was bitten by.
  it('collapses a republished message envelope to one un-doubled call', () => {
    const republished = [EVENTS[0], EVENTS[1], EVENTS[2], EVENTS[3], EVENTS[0]];
    const calls = createOpenCodeSource(republished).callsSince(0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].blocks.length, 3);
    assert.deepEqual(calls[0].usage, {
      input: 10, output: 20, cacheRead: 5, cacheWrite: 2, reasoning: 7,
    });
  });

  // Snapshots are cumulative, so the LAST envelope is the truth — not
  // the first, and never the sum.
  it('takes the latest snapshot of a growing envelope, not the sum', () => {
    const growing = [
      assistantMessage({ tokens: { input: 10, output: 20, reasoning: 7, cache: { read: 5, write: 2 } } }),
      TEXT_PART,
      assistantMessage({
        tokens: { input: 10, output: 35, reasoning: 11, cache: { read: 5, write: 2 } },
        time: { created: 1785060002000, completed: 1785060009000 },
      }),
    ];
    const calls = createOpenCodeSource(growing).callsSince(0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].usage, {
      input: 10, output: 35, cacheRead: 5, cacheWrite: 2, reasoning: 11,
    });
    assert.equal(calls[0].endMs, 1785060009000);
  });

  // `message.part.updated` is a snapshot too: a streaming text part is
  // republished once per chunk, each time carrying the full text so far.
  // Appending would emit one block per chunk, each a longer prefix of
  // the same sentence.
  it('collapses a streamed part republished under one id', () => {
    const streamed = [
      assistantMessage(),
      { kind: 'part', part: { id: 'prt_2', type: 'text', messageID: 'msg_1', text: 'Here' } },
      { kind: 'part', part: { id: 'prt_2', type: 'text', messageID: 'msg_1', text: 'Here is' } },
      { kind: 'part', part: { id: 'prt_2', type: 'text', messageID: 'msg_1', text: 'Here is the answer.' } },
    ];
    const [call] = createOpenCodeSource(streamed).callsSince(0);
    assert.equal(call.blocks.length, 1);
    assert.equal(call.blocks[0].content, 'Here is the answer.');
  });

  // The other direction: collapsing must key on the PART id, not the
  // message id, or a message's second text block would swallow its first.
  it('keeps distinct parts of one message as distinct blocks', () => {
    const twoTexts = [
      assistantMessage(),
      { kind: 'part', part: { id: 'prt_a', type: 'text', messageID: 'msg_1', text: 'first' } },
      { kind: 'part', part: { id: 'prt_b', type: 'text', messageID: 'msg_1', text: 'second' } },
      { kind: 'part', part: { id: 'prt_a', type: 'text', messageID: 'msg_1', text: 'first (final)' } },
    ];
    const [call] = createOpenCodeSource(twoTexts).callsSince(0);
    assert.deepEqual(call.blocks.map((b) => b.content), ['first (final)', 'second']);
    assert.ok(blockOrderIsSane(call));
  });

  it('yields one call per assistant message id, in first-seen order', () => {
    const two = [
      assistantMessage(),
      TEXT_PART,
      { kind: 'message', info: { id: 'msg_2', role: 'assistant', providerID: 'anthropic', modelID: 'gpt-5', time: { created: 1785060005000, completed: 1785060006000 } } },
      { kind: 'part', part: { id: 'prt_7', type: 'text', messageID: 'msg_2', text: 'second message' } },
    ];
    const calls = createOpenCodeSource(two).callsSince(0);
    assert.deepEqual(calls.map((c) => c.callId), ['msg_1', 'msg_2']);
    assert.equal(calls[1].blocks[0].content, 'second message');
  });

  it('drops calls that started before sinceMs', () => {
    const two = [
      assistantMessage(),
      TEXT_PART,
      { kind: 'message', info: { id: 'msg_2', role: 'assistant', providerID: 'anthropic', time: { created: 1785060005000, completed: 1785060006000 } } },
      { kind: 'part', part: { id: 'prt_7', type: 'text', messageID: 'msg_2', text: 'second message' } },
    ];
    const src = createOpenCodeSource(two);
    assert.deepEqual(src.callsSince(0).map((c) => c.callId), ['msg_1', 'msg_2']);
    assert.deepEqual(src.callsSince(1785060003000).map((c) => c.callId), ['msg_2']);
    assert.deepEqual(src.callsSince(1785060099000), []);
  });

  // Parts arrive as live SDK objects, not as JSON.parse output, so a
  // cycle or a BigInt in a tool's input is reachable. JSON.stringify
  // throws on both, and callsSince runs inside a host-blocking hook.
  it('never throws on tool input that cannot be serialised', () => {
    const cyclic: Record<string, unknown> = { command: 'ls' };
    cyclic.self = cyclic;
    const events = [
      assistantMessage(),
      { kind: 'part', part: { id: 'prt_2', type: 'text', messageID: 'msg_1', text: 'answer' } },
      { kind: 'part', part: { id: 'prt_c', type: 'tool', messageID: 'msg_1', callID: 'call_c', tool: 'bash', state: { input: cyclic } } },
      { kind: 'part', part: { id: 'prt_b', type: 'tool', messageID: 'msg_1', callID: 'call_b', tool: 'read', state: { input: { size: 10n } } } },
    ];
    const calls = createOpenCodeSource(events).callsSince(0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].blocks.map((b) => b.type), ['text', 'tool_use', 'tool_use']);
    assert.equal(calls[0].blocks[1].toolUse?.id, 'call_c');
    assert.equal(calls[0].blocks[1].toolUse?.input, '{}');
    assert.equal(calls[0].blocks[2].toolUse?.input, '{}');
  });

  // `synthetic: true` is opencode's marker for text the HOST injected
  // into the assistant message (interruption notices, re-prompts,
  // compaction stubs). Recording it as a `text` block would quote the
  // harness as the assistant — a wrong record, not merely an incomplete
  // one — so it is skipped like the orchestration parts below. The real
  // model text either side of it must survive, otherwise this would pass
  // for an implementation that simply dropped every text part.
  it('skips host-injected synthetic text parts, keeping the model\'s own', () => {
    const injected = [
      assistantMessage(),
      { kind: 'part', part: { id: 'p1', type: 'text', messageID: 'msg_1', text: 'genuine model text' } },
      { kind: 'part', part: { id: 'p2', type: 'text', messageID: 'msg_1', text: '[Request interrupted by user]', synthetic: true } },
      { kind: 'part', part: { id: 'p3', type: 'text', messageID: 'msg_1', text: 'more model text' } },
    ];
    const [call] = createOpenCodeSource(injected).callsSince(0);
    assert.deepEqual(
      call.blocks.map((b) => b.content),
      ['genuine model text', 'more model text'],
      'a synthetic text part is not the model speaking and must not be recorded as such',
    );
    assert.ok(blockOrderIsSane(call), 'block indices must stay zero-based and contiguous after the skip');
  });

  // `synthetic: false` is the ordinary shape for a real text part, so the
  // skip above must key on `=== true`, not on the property being present.
  it('keeps a text part that explicitly marks itself non-synthetic', () => {
    const explicit = [
      assistantMessage(),
      { kind: 'part', part: { id: 'p1', type: 'text', messageID: 'msg_1', text: 'model text', synthetic: false } },
    ];
    const [call] = createOpenCodeSource(explicit).callsSince(0);
    assert.deepEqual(call.blocks.map((b) => b.content), ['model text']);
  });

  // Orchestration parts describe the harness, not the model's output.
  it('skips orchestration parts and empty text', () => {
    const noisy = [
      assistantMessage(),
      { kind: 'part', part: { id: 'p1', type: 'step-start', messageID: 'msg_1' } },
      { kind: 'part', part: { id: 'p2', type: 'snapshot', messageID: 'msg_1', snapshot: 'abc' } },
      { kind: 'part', part: { id: 'p3', type: 'text', messageID: 'msg_1', text: '' } },
      { kind: 'part', part: { id: 'p4', type: 'reasoning', messageID: 'msg_1', text: '' } },
      { kind: 'part', part: { id: 'p5', type: 'patch', messageID: 'msg_1' } },
      { kind: 'part', part: { id: 'p6', type: 'text', messageID: 'msg_1', text: 'the only output' } },
      { kind: 'part', part: { id: 'p7', type: 'step-finish', messageID: 'msg_1' } },
    ];
    const [call] = createOpenCodeSource(noisy).callsSince(0);
    assert.deepEqual(call.blocks.map((b) => b.type), ['text']);
    assert.equal(call.blocks[0].content, 'the only output');
  });

  // An assistant message that produced no model output is not a call.
  it('drops an assistant message with no content blocks', () => {
    const empty = [
      assistantMessage(),
      { kind: 'part', part: { id: 'p1', type: 'step-start', messageID: 'msg_1' } },
    ];
    assert.deepEqual(createOpenCodeSource(empty).callsSince(0), []);
  });

  // Parts can legitimately land before the envelope that owns them.
  it('accepts parts that arrive before their message envelope', () => {
    const outOfOrder = [EVENTS[1], EVENTS[2], EVENTS[0], EVENTS[3]];
    const [call] = createOpenCodeSource(outOfOrder).callsSince(0);
    assert.deepEqual(call.blocks.map((b) => b.type), ['thinking', 'text', 'tool_use']);
    assert.equal(call.timing, 'exact');
  });

  it('falls back to a placeholder tool name and empty input', () => {
    const partial = [
      assistantMessage(),
      { kind: 'part', part: { id: 'p1', type: 'tool', messageID: 'msg_1', callID: 'call_x', state: null } },
      { kind: 'part', part: { id: 'p2', type: 'tool', messageID: 'msg_1', tool: 'bash' } }, // no callID
    ];
    const [call] = createOpenCodeSource(partial).callsSince(0);
    assert.equal(call.blocks.length, 1);
    assert.equal(call.blocks[0].toolUse?.name, 'unknown');
    assert.equal(call.blocks[0].toolUse?.input, '{}');
  });

  it('omits usage entirely when no token counts are present', () => {
    const noTokens = [assistantMessage({ tokens: undefined }), TEXT_PART];
    const [call] = createOpenCodeSource(noTokens).callsSince(0);
    assert.equal(call.usage, undefined);
  });

  it('keeps the token fields the message does report', () => {
    const partialTokens = [
      assistantMessage({ tokens: { output: 20, cache: { write: 2 } } }),
      TEXT_PART,
    ];
    const [call] = createOpenCodeSource(partialTokens).callsSince(0);
    assert.deepEqual(call.usage, { output: 20, cacheWrite: 2 });
  });
});
