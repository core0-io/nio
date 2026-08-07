// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fidelityForModel, toUsage } from '../scripts/lib/conversation/shared.js';

/**
 * The provider|model combinations below are the ones actually observed
 * in the field, not idealised inputs. They come from a forensic pass
 * over 16 real sessions (1298 thinking blocks with a body):
 *
 *   provider       | model                            blocks   max    mean
 *   ollama-cloud   | glm-5.2                            154  55088   3589
 *   ollama-cloud   | gpt-oss:120b                       802   9168    213
 *   ollama-cloud   | deepseek-v4-flash                  248   9325    570
 *   openrouter     | qwen/qwen3.5-122b-a10b             103   1347    339
 *   amazon-bedrock | us.anthropic.claude-opus-4-6-v1      1    125    125
 *
 * The previous rule ("provider contains 'anthropic'") got this exactly
 * backwards: the 125-character bedrock block was the only one it called
 * 'full', and 55088 characters of glm-5.2 reasoning were called
 * 'summary'. No test caught it because every test input was an
 * idealised bare 'anthropic' / 'openai' provider string — a shape that
 * never appears in any of the 16 sessions.
 */
const OBSERVED: ReadonlyArray<readonly [provider: string, model: string, expected: string]> = [
  // Raw chain-of-thought reaches the client verbatim.
  ['ollama-cloud', 'glm-5.2', 'full'],
  ['ollama-cloud', 'deepseek-v4-flash', 'full'],
  ['openrouter', 'qwen/qwen3.5-122b-a10b', 'full'],
  ['amazon-bedrock', 'us.anthropic.claude-opus-4-6-v1', 'full'],
  // OpenAI reasoning family — step narration, not a verbatim CoT contract.
  ['ollama-cloud', 'gpt-oss:120b', 'summary'],
];

describe('fidelityForModel', () => {
  for (const [provider, model, expected] of OBSERVED) {
    it(`judges the observed combination ${provider} | ${model} as ${expected}`, () => {
      assert.equal(fidelityForModel(model, provider), expected);
    });
  }

  // The single assertion that kills the old implementation outright:
  // three different providers, and the verdict tracks the model in every
  // one of them. A rule keyed on the provider cannot produce this row.
  it('gives the same verdict for one model no matter which channel it arrived through', () => {
    for (const provider of ['ollama-cloud', 'openrouter', 'amazon-bedrock', 'anthropic', undefined]) {
      assert.equal(fidelityForModel('glm-5.2', provider), 'full', `glm-5.2 via ${provider}`);
    }
    for (const provider of ['ollama-cloud', 'openrouter', 'anthropic', undefined]) {
      assert.equal(fidelityForModel('gpt-oss:120b', provider), 'summary', `gpt-oss via ${provider}`);
    }
  });

  // The model always decides. `anthropic` as a provider is a 'full'
  // signal on its own (see the fallback test below), so a model rule
  // that did not take precedence would be invisible here.
  it('lets the model override a provider that would say otherwise', () => {
    assert.equal(fidelityForModel('gpt-oss:120b', 'anthropic'), 'summary');
    assert.equal(fidelityForModel('claude-opus-4-6', 'openai'), 'full');
  });

  it('recognises a model family through routing prefixes and tag suffixes', () => {
    assert.equal(fidelityForModel('anthropic/claude-sonnet-4-5'), 'full');
    assert.equal(fidelityForModel('us.anthropic.claude-opus-4-6-v1'), 'full');
    assert.equal(fidelityForModel('deepseek-r1:70b'), 'full');
    assert.equal(fidelityForModel('QWEN/Qwen3.5-122B-A10B'), 'full');
    assert.equal(fidelityForModel('  glm-5.2  '), 'full');
  });

  it('marks the OpenAI reasoning series summary across its naming schemes', () => {
    assert.equal(fidelityForModel('gpt-5-codex'), 'summary');
    assert.equal(fidelityForModel('gpt-5.2'), 'summary');
    assert.equal(fidelityForModel('o3-mini'), 'summary');
    assert.equal(fidelityForModel('o1'), 'summary');
    assert.equal(fidelityForModel('codex-mini-latest'), 'summary');
    // Gemini's thinking models return thought *summaries*, not thoughts.
    assert.equal(fidelityForModel('gemini-3-pro'), 'summary');
  });

  // Provider is a fallback, and only first-party provider names imply a
  // model family at all.
  it('falls back to the provider only when the model decides nothing', () => {
    assert.equal(fidelityForModel(undefined, 'anthropic'), 'full');
    assert.equal(fidelityForModel('', 'anthropic-vertex'), 'full');
    assert.equal(fidelityForModel('some-unreleased-model', 'openai'), 'summary');
    assert.equal(fidelityForModel(42, 'azure-openai'), 'summary');
  });

  // Aggregators and cloud routes are exactly what made the old rule
  // wrong. None of them may resolve to a verdict on their own — note
  // `openrouter` must not be read as OpenAI, and `amazon-bedrock` must
  // not be read as Anthropic even though it does serve Claude.
  it('reads no fidelity out of an aggregator or cloud-route provider name', () => {
    for (const provider of ['ollama-cloud', 'ollama', 'openrouter', 'amazon-bedrock', 'vertex', 'groq']) {
      assert.equal(fidelityForModel(undefined, provider), 'unknown', provider);
      assert.equal(fidelityForModel('some-unreleased-model', provider), 'unknown', provider);
    }
  });

  // The third value exists so an unrecognised model is not silently
  // filed under 'summary'. A consumer discounting a 'summary' block
  // would otherwise discount a complete reasoning trace it was never
  // told about.
  it('reports unknown — never summary — when nothing recognises the model', () => {
    assert.equal(fidelityForModel('mystery-thinker-9'), 'unknown');
    assert.equal(fidelityForModel(undefined, undefined), 'unknown');
    assert.equal(fidelityForModel(null, 42), 'unknown');
    assert.equal(fidelityForModel('   ', '   '), 'unknown');
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
    // The `input` guard alone was pinned originally; weakening any of the
    // other three to a bare `'output' in u` / `'cacheRead' in u` /
    // `'cacheWrite' in u` left the suite green. This line closes all three
    // at once — each surviving mutation turns one of these non-numbers
    // into a returned field, so the result stops being undefined.
    assert.equal(toUsage({ output: 'x', cacheRead: {}, cacheWrite: null }), undefined);
  });
});
