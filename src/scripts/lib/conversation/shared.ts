// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Helpers shared by more than one ConversationSource.
 *
 * These started out private to openclaw-source.ts. Pi and opencode need
 * the same two decisions — how much to trust a thinking block, and how to
 * read a usage record defensively — so they live here rather than being
 * copied three times.
 *
 * The thinking-fidelity decision is the interesting one, and it is keyed
 * to the MODEL. Adding support for a new model family means adding one
 * entry to `MODEL_RULES` with the reason it earns its value; until then
 * that family reports `'unknown'`, which is a real answer and not a
 * placeholder for `'summary'`.
 */

import type { ChatCall, ThinkingFidelity } from './types.js';

/**
 * One fidelity rule: a model FAMILY, and why that family gets its value.
 *
 * Deliberately family-level, not a roster of model ids. New model ids
 * ship every week and a roster would be stale on arrival; a family
 * pattern survives a version bump (`claude-opus-4-6` → `claude-opus-5`),
 * and anything the patterns do not recognise is reported `unknown`
 * rather than silently defaulted.
 */
interface FidelityRule {
  /** Matched against the lowercased model id, prefixes and tags included. */
  match: RegExp;
  fidelity: 'full' | 'summary';
  /** Why this family earns that value. Kept in code so a rule cannot be added without one. */
  why: string;
}

/**
 * Model-family rules, first match wins.
 *
 * `summary` rules come first: an id can name both an OpenAI family and a
 * distillation base (`deepseek-r1-distill-qwen`), and the withheld-CoT
 * case is the one a consumer must not get wrong in the optimistic
 * direction.
 */
const MODEL_RULES: readonly FidelityRule[] = [
  {
    match: /gpt-oss/,
    fidelity: 'summary',
    why: "OpenAI's open-weight reasoning family; its reasoning output is a step "
      + 'narration, not a verbatim chain-of-thought contract. Measured mean 213 '
      + 'characters per block over 802 blocks — summary-shaped next to the 3589 '
      + 'served by glm-5.2 through the same provider.',
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

/**
 * Provider-family rules — a FALLBACK only, consulted when the model id
 * decided nothing.
 *
 * Only first-party provider names appear here, because only those imply
 * a model family. Aggregators and cloud routes (`ollama-cloud`,
 * `openrouter`, `amazon-bedrock`, `azure`, `groq`, `vertex`, …) are the
 * whole reason the old provider-based rule was wrong: they are access
 * channels and carry no fidelity information. They match nothing here
 * and correctly fall through to `unknown`.
 */
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

/**
 * How much of the model's reasoning a thinking block actually contains.
 *
 * Judged from the MODEL, because that is where the property lives. The
 * previous rule read the provider string and reported `full` for
 * anything containing "anthropic" — which, on real data, labelled a
 * 125-character `us.anthropic.claude-opus-4-6-v1` block `full` while
 * labelling 55088 characters of glm-5.2 reasoning `summary`, because
 * glm arrived through `ollama-cloud`. Provider names the channel; the
 * model decides what comes down it.
 *
 * `provider` is a fallback, used only when the model id matched no rule
 * (including when there is no model id at all), and only first-party
 * provider names carry a verdict — see `PROVIDER_RULES`.
 *
 * Returns `unknown` when neither decides. That is the point of the
 * third value: an unrecognised model must not be reported as `summary`,
 * because a consumer discounting a `summary` block would then discount
 * a complete reasoning trace it was never told about.
 */
export function fidelityForModel(model: unknown, provider?: unknown): ThinkingFidelity {
  return applyRules(MODEL_RULES, model) ?? applyRules(PROVIDER_RULES, provider) ?? 'unknown';
}

/** Read a usage record defensively; undefined when nothing usable is present. */
export function toUsage(raw: unknown): NonNullable<ChatCall['usage']> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const out: NonNullable<ChatCall['usage']> = {};
  if (typeof u.input === 'number') out.input = u.input;
  if (typeof u.output === 'number') out.output = u.output;
  if (typeof u.cacheRead === 'number') out.cacheRead = u.cacheRead;
  if (typeof u.cacheWrite === 'number') out.cacheWrite = u.cacheWrite;
  return Object.keys(out).length > 0 ? out : undefined;
}
