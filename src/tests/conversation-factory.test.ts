// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSourceForPlatform } from '../scripts/lib/conversation/factory.js';

describe('createSourceForPlatform', () => {
  it('dispatches claude-code to the claude-code-transcript source', () => {
    const source = createSourceForPlatform('claude-code', { transcriptPath: '/some/transcript.jsonl' });
    assert.ok(source);
    assert.equal(source!.name, 'claude-code-transcript');
  });

  it('dispatches codex to the codex-rollout source', () => {
    const source = createSourceForPlatform('codex', { transcriptPath: '/some/rollout.jsonl' });
    assert.ok(source);
    assert.equal(source!.name, 'codex-rollout');
  });

  it('dispatches hermes to the hermes-post-llm-call source', () => {
    const source = createSourceForPlatform('hermes', { payload: { conversation_history: [] } });
    assert.ok(source);
    assert.equal(source!.name, 'hermes-post-llm-call');
  });

  it('dispatches openclaw to the openclaw-event-stream source', () => {
    const source = createSourceForPlatform('openclaw', { events: [] });
    assert.ok(source);
    assert.equal(source!.name, 'openclaw-event-stream');
  });

  // Pi and opencode both dispatch on a field another platform already
  // uses — Pi on `transcriptPath` (shared with claude-code and codex),
  // opencode on `events` (shared with openclaw) — so only the returned
  // source's name distinguishes a correct branch from a copy-paste of
  // its neighbour.
  it('dispatches pi to the pi-session source', () => {
    const source = createSourceForPlatform('pi', { transcriptPath: '/some/session.jsonl' });
    assert.ok(source);
    assert.equal(source!.name, 'pi-session');
  });

  it('dispatches opencode to the opencode-events source', () => {
    const source = createSourceForPlatform('opencode', { events: [] });
    assert.ok(source);
    assert.equal(source!.name, 'opencode-events');
  });

  it('returns null for claude-code when transcriptPath is missing', () => {
    assert.equal(createSourceForPlatform('claude-code', {}), null);
  });

  it('returns null for codex when transcriptPath is missing', () => {
    assert.equal(createSourceForPlatform('codex', {}), null);
  });

  it('returns null for hermes when payload is missing', () => {
    assert.equal(createSourceForPlatform('hermes', {}), null);
  });

  it('returns null for openclaw when events is missing', () => {
    assert.equal(createSourceForPlatform('openclaw', {}), null);
  });

  it('returns null for pi when transcriptPath is missing', () => {
    assert.equal(createSourceForPlatform('pi', {}), null);
  });

  it('returns null for opencode when events is missing', () => {
    assert.equal(createSourceForPlatform('opencode', {}), null);
  });

  it('returns null for an unknown platform', () => {
    assert.equal(createSourceForPlatform('some-future-platform', { transcriptPath: '/x.jsonl' }), null);
  });
});
