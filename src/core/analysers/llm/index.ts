// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * LLM Analyser — Phase 2 semantic security analysis using Claude.
 *
 * This analyser uses the Anthropic API to perform deep semantic analysis
 * of skill code, enriched by Phase 1 findings from the Static and
 * Behavioural analysers.
 *
 * Key features:
 *   - Random delimiter injection protection (Cisco pattern)
 *   - Scoped analysis: only sends files with Phase 1 findings
 *   - Structured JSON output with fallback parsing
 *   - Gated: disabled without ANTHROPIC_API_KEY
 */

import { BaseAnalyser, type AnalysisContext } from '../base.js';
import type { Finding, AnalyserName } from '../../models.js';
import { findingId } from '../../models.js';
import type { ScanPolicy } from '../../scan-policy.js';
import {
  buildAnalysisPrompt,
  generateDelimiter,
  selectFilesForLLM,
  estimateTokens,
} from './prompts.js';
import { mapCategory, mapSeverity, type LLMResponse } from './taxonomy.js';

// ── Configuration ────────────────────────────────────────────────────────

/** Maximum tokens to send to the LLM (input budget). */
const DEFAULT_MAX_INPUT_TOKENS = 50_000;

/** Model to use. */
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

// ── LLM Analyser ─────────────────────────────────────────────────────────

export class LLMAnalyser extends BaseAnalyser {
  readonly name: AnalyserName = 'llm';
  readonly phase: 2 = 2;

  private apiKey: string | undefined;
  private model: string;
  private maxInputTokens: number;

  constructor(opts?: {
    apiKey?: string;
    model?: string;
    maxInputTokens?: number;
  }) {
    super();
    this.apiKey = opts?.apiKey;
    this.model = opts?.model ?? DEFAULT_MODEL;
    this.maxInputTokens = opts?.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
  }

  isEnabled(policy: ScanPolicy): boolean {
    return policy.analysers.llm && !!this.apiKey;
  }

  async analyze(ctx: AnalysisContext): Promise<Finding[]> {
    if (!this.apiKey) return [];

    const priorFindings = ctx.priorFindings ?? [];

    // Select files to analyze (prioritize files with Phase 1 findings)
    const allFiles = ctx.files.map((f) => ({
      path: f.relativePath,
      content: f.content,
    }));

    // Reserve tokens for prompt overhead
    const filesBudget = this.maxInputTokens - 2000;
    const selectedFiles = selectFilesForLLM(allFiles, priorFindings, filesBudget);

    if (selectedFiles.length === 0) return [];

    // Build prompt with injection protection
    const delimiter = generateDelimiter();
    const prompt = buildAnalysisPrompt({
      files: selectedFiles,
      priorFindings,
      delimiter,
    });

    // Check for injection attempts in the prompt itself
    const injectionFindings = detectPromptInjection(selectedFiles, delimiter);
    if (injectionFindings.length > 0) {
      // Still proceed with analysis but include the injection findings
    }

    // Call Claude API
    const response = await this.callClaude(prompt);
    if (!response) return injectionFindings;

    // Parse response into findings
    const llmFindings = this.parseResponse(response);

    return [...injectionFindings, ...llmFindings];
  }

  /**
   * Call the Anthropic API with retry on rate limits.
   */
  private async callClaude(prompt: string): Promise<string | null> {
    try {
      // Dynamic import to avoid loading SDK when not needed
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: this.apiKey });

      const message = await client.messages.create({
        model: this.model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      });

      // Extract text from response
      const textBlock = message.content.find((b) => b.type === 'text');
      return textBlock?.text ?? null;
    } catch (err: unknown) {
      const error = err as { status?: number; message?: string };

      // Retry once on rate limit
      if (error.status === 429) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const { default: Anthropic } = await import('@anthropic-ai/sdk');
          const client = new Anthropic({ apiKey: this.apiKey });
          const message = await client.messages.create({
            model: this.model,
            max_tokens: 4096,
            messages: [{ role: 'user', content: prompt }],
          });
          const textBlock = message.content.find((b) => b.type === 'text');
          return textBlock?.text ?? null;
        } catch {
          return null;
        }
      }

      console.warn('[LLMAnalyser] API call failed:', error.message);
      return null;
    }
  }

  /**
   * Parse the LLM response text into structured findings.
   * Tries JSON parsing first, then regex extraction as fallback.
   */
  private parseResponse(text: string): Finding[] {
    const parsed = parseLLMJson(text);
    if (!parsed) return [];

    const findings: Finding[] = [];

    for (const f of parsed.findings) {
      // Skip false positives flagged by the LLM
      if (f.is_false_positive) continue;

      findings.push({
        id: findingId(f.rule_id || 'LLM_FINDING', f.file || 'unknown', f.line || 0),
        rule_id: f.rule_id || 'LLM_FINDING',
        category: mapCategory(f.category || 'policy_violation'),
        severity: mapSeverity(f.severity || 'medium'),
        title: f.title || 'LLM-detected threat',
        description: f.description || '',
        location: {
          file: f.file || 'unknown',
          line: f.line || 0,
        },
        remediation: f.remediation,
        analyser: 'llm',
        confidence: 0.7, // LLM findings have lower confidence than deterministic
        metadata: {
          references: f.references,
          llm_model: this.model,
        },
      });
    }

    return findings;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Try to parse the LLM response as JSON.
 * Handles responses wrapped in markdown code fences.
 */
function parseLLMJson(text: string): LLMResponse | null {
  // Strip markdown code fences if present
  const stripped = text
    .replace(/^```(?:json)?\s*\n?/m, '')
    .replace(/\n?```\s*$/m, '')
    .trim();

  try {
    return JSON.parse(stripped) as LLMResponse;
  } catch {
    // Try to extract JSON object from surrounding text
    const match = stripped.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as LLMResponse;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Check if any file content contains our delimiter (injection attempt).
 */
function detectPromptInjection(
  files: Array<{ path: string; content: string }>,
  delimiter: string,
): Finding[] {
  const findings: Finding[] = [];

  for (const file of files) {
    // Check for attempts to break out of the delimiter
    if (file.content.includes(`[${delimiter}]`)) {
      findings.push({
        id: findingId('LLM_INJECTION', file.path, 0),
        rule_id: 'LLM_INJECTION',
        category: 'injection',
        severity: 'high',
        title: 'Prompt Injection Attempt',
        description:
          'Code contains the analysis delimiter, suggesting a prompt injection attempt ' +
          'targeting the LLM analyser.',
        location: { file: file.path, line: 0 },
        remediation: 'Remove injection payloads from the skill code.',
        analyser: 'llm',
        confidence: 0.95,
      });
    }
  }

  return findings;
}
