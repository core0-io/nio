// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import type { ThinkingFidelity } from './types.js';

interface FidelityRule {
  /** Matched against the lowercased model id, prefixes and tags included. */
  match: RegExp;
  fidelity: 'full' | 'summary';
  /** Why this family earns that value. Kept in code so a rule cannot be added without one. */
  why: string;
}

const MODEL_RULES: readonly FidelityRule[] = [
  {
    match: /gpt-oss/,
    fidelity: 'summary',
    why: "OpenAI's open-weight reasoning family; its reasoning output is a step "
      + 'narration, not a verbatim chain-of-thought contract.',
  },
  {
    match: /(^|[^a-z0-9])gpt-?[5-9]/,
    fidelity: 'summary',
    why: "OpenAI's reasoning series: the Responses API returns `reasoning.summary` "
      + 'and withholds the raw chain-of-thought (~3% of the underlying reasoning by volume).',
  },
  {
    match: /(^|[^a-z0-9])o[1-4]($|[^a-z0-9])/,
    fidelity: 'summary',
    why: 'OpenAI o-series (o1/o3/o4-mini) — same withheld-CoT contract as gpt-5.',
  },
  {
    match: /(^|[^a-z0-9])codex/,
    fidelity: 'summary',
    why: "OpenAI's codex reasoning variants, same API contract.",
  },
  {
    match: /gemini/,
    fidelity: 'summary',
    why: 'Gemini returns *thought summaries* on its thinking models, not raw thoughts.',
  },
  {
    match: /claude/,
    fidelity: 'full',
    why: 'Anthropic extended thinking returns the complete reasoning text. Matches the '
      + 'bare id and every routed form (`us.anthropic.claude-opus-4-6-v1`, `anthropic/claude-…`).',
  },
  {
    match: /deepseek/,
    fidelity: 'full',
    why: 'DeepSeek R1-lineage models emit the raw chain-of-thought in `reasoning_content`.',
  },
  {
    match: /(^|[^a-z0-9])(chatglm|glm)/,
    fidelity: 'full',
    why: 'Zhipu GLM reasoning models stream the raw chain-of-thought.',
  },
  {
    match: /(^|[^a-z0-9])(qwen|qwq)/,
    fidelity: 'full',
    why: "Qwen thinking mode emits the raw `<think>` content, not a summary of it.",
  },
];

const PROVIDER_RULES: readonly FidelityRule[] = [
  {
    match: /anthropic/,
    fidelity: 'full',
    why: "Anthropic's own API/route serves only the Claude family.",
  },
  {
    match: /openai/,
    fidelity: 'summary',
    why: "OpenAI's own API (and `azure-openai`) withholds raw chain-of-thought on its "
      + 'reasoning models. Does not match `openrouter`, which is an aggregator.',
  },
];

function applyRules(rules: readonly FidelityRule[], id: unknown): ThinkingFidelity | undefined {
  if (typeof id !== 'string') return undefined;
  const normalised = id.trim().toLowerCase();
  if (normalised.length === 0) return undefined;
  for (const rule of rules) if (rule.match.test(normalised)) return rule.fidelity;
  return undefined;
}

export function fidelityForModel(model: unknown, provider?: unknown): ThinkingFidelity {
  // A known but unrecognized model must not inherit a gateway/provider's fidelity.
  if (typeof model === 'string' && model.trim()) return applyRules(MODEL_RULES, model) ?? 'unknown';
  return applyRules(PROVIDER_RULES, provider) ?? 'unknown';
}


/** Stable fallback identity; occurrence distinguishes legitimate identical source messages. */
export function sourceFingerprint(prefix: string, value: unknown, occurrences: Map<string, number>): string {
  const digest = createHash('sha256').update(JSON.stringify(value) ?? '').digest('hex');
  const occurrence = occurrences.get(digest) ?? 0;
  occurrences.set(digest, occurrence + 1);
  return `${prefix}-${digest}-${occurrence}`;
}
