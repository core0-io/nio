// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { allocateSpanKey, spanKey } from '../scripts/lib/collector-core.js';
import type { CollectorState } from '../scripts/lib/traces-state-store.js';

function emptyState(): CollectorState {
  return {
    session_id: 'sess-1',
    turn_number: 1,
    turn_trace_id: 'a'.repeat(32),
    turn_start_ms: 1700000000000,
    pending_spans: {},
    pending_task_spans: {},
  };
}

const input = { tool_name: 'terminal', tool_input: { command: 'ls' } };

describe('allocateSpanKey', () => {
  it('returns the plain key when nothing is pending', () => {
    assert.equal(allocateSpanKey(emptyState(), input), 'terminal:ls');
  });

  it('appends a suffix when the plain key is already pending', () => {
    const s = emptyState();
    s.pending_spans['terminal:ls'] = {
      tool_name: 'terminal', tool_summary: 'ls',
      start_ms: 1, span_id: 'b'.repeat(16),
    };
    assert.equal(allocateSpanKey(s, input), 'terminal:ls#2');
  });

  it('keeps incrementing for a third concurrent call', () => {
    const s = emptyState();
    for (const k of ['terminal:ls', 'terminal:ls#2']) {
      s.pending_spans[k] = {
        tool_name: 'terminal', tool_summary: 'ls',
        start_ms: 1, span_id: 'b'.repeat(16),
      };
    }
    assert.equal(allocateSpanKey(s, input), 'terminal:ls#3');
  });

  it('prefers tool_use_id and never suffixes it', () => {
    const s = emptyState();
    s.pending_spans['toolu_x'] = {
      tool_name: 'Bash', tool_summary: 'ls',
      start_ms: 1, span_id: 'b'.repeat(16),
    };
    // A real tool_use_id is unique by construction; colliding on it would
    // mean the host reused an id, which we must not paper over.
    assert.equal(allocateSpanKey(s, { ...input, tool_use_id: 'toolu_x' }), 'toolu_x');
  });

  it('does not mutate the input state', () => {
    const s = emptyState();
    allocateSpanKey(s, input);
    assert.deepEqual(s.pending_spans, {});
  });

  it('spanKey itself stays pure and unsuffixed', () => {
    assert.equal(spanKey(input), 'terminal:ls');
  });
});
