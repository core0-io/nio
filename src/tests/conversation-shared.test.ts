// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fidelityForProvider, toUsage } from '../scripts/lib/conversation/shared.js';

describe('fidelityForProvider', () => {
  it('marks Anthropic providers as full fidelity', () => {
    assert.equal(fidelityForProvider('anthropic'), 'full');
    assert.equal(fidelityForProvider('Anthropic'), 'full');
    assert.equal(fidelityForProvider('anthropic-vertex'), 'full');
  });

  // Fidelity follows the MODEL PROVIDER, never the platform name. The same
  // host reports 'full' or 'summary' depending on which model is configured;
  // getting this backwards makes a 40-character step summary look like a
  // complete reasoning trace.
  it('marks every non-Anthropic provider as summary fidelity', () => {
    assert.equal(fidelityForProvider('openai'), 'summary');
    assert.equal(fidelityForProvider('google'), 'summary');
    assert.equal(fidelityForProvider(undefined), 'summary');
    assert.equal(fidelityForProvider(42), 'summary');
  });
});

describe('toUsage', () => {
  it('reads the four token fields', () => {
    assert.deepEqual(
      toUsage({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }),
      { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    );
  });

  it('keeps only the fields actually present', () => {
    assert.deepEqual(toUsage({ input: 5 }), { input: 5 });
  });

  it('returns undefined rather than an empty object when nothing usable is present', () => {
    assert.equal(toUsage({}), undefined);
    assert.equal(toUsage(null), undefined);
    assert.equal(toUsage('nonsense'), undefined);
    assert.equal(toUsage({ input: 'not-a-number' }), undefined);
  });
});
