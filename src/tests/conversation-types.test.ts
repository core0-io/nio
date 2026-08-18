// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { blockOrderIsSane, type ChatCall } from '../scripts/lib/conversation/types.js';

function call(overrides: Partial<ChatCall> = {}): ChatCall {
  return {
    callId: 'req_1',
    startMs: 1000,
    endMs: 2000,
    timing: 'exact',
    blocks: [],
    isSidechain: false,
    ...overrides,
  };
}

describe('blockOrderIsSane', () => {
  it('accepts contiguous zero-based indices', () => {
    const c = call({ blocks: [
      { type: 'thinking', index: 0, content: 'x', fidelity: 'full' },
      { type: 'text', index: 1, content: 'y' },
      { type: 'tool_use', index: 2, content: '{}', toolUse: { id: 't1', name: 'Bash', input: '{}' } },
    ] });
    assert.equal(blockOrderIsSane(c), true);
  });

  it('accepts an empty block list', () => {
    assert.equal(blockOrderIsSane(call()), true);
  });

  it('rejects a gap in the sequence', () => {
    const c = call({ blocks: [
      { type: 'text', index: 0, content: 'a' },
      { type: 'text', index: 2, content: 'b' },
    ] });
    assert.equal(blockOrderIsSane(c), false);
  });

  it('rejects duplicate indices', () => {
    const c = call({ blocks: [
      { type: 'text', index: 0, content: 'a' },
      { type: 'text', index: 0, content: 'b' },
    ] });
    assert.equal(blockOrderIsSane(c), false);
  });

  it('rejects blocks that are not sorted by index', () => {
    const c = call({ blocks: [
      { type: 'text', index: 1, content: 'b' },
      { type: 'text', index: 0, content: 'a' },
    ] });
    assert.equal(blockOrderIsSane(c), false);
  });
});
