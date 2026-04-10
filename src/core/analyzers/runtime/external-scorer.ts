/**
 * Phase 6: External Scoring API — pluggable HTTP endpoint.
 *
 * Sends action context + prior scores/findings to an external API and
 * receives a 0-1 score. Configured via `guard.scoring_endpoint` in config.yaml.
 */

import type { ActionEnvelope } from '../../../types/action.js';
import type { Finding } from '../../models.js';
import type { PhaseScores } from './scoring.js';

// ── Types ───────────────────────────────────────────────────────────────

export interface ExternalScorerOptions {
  endpoint: string;
  apiKey?: string;
  timeout?: number; // ms, default 3000
}

export interface ExternalScoreRequest {
  tool_name: string;
  tool_input: Record<string, unknown>;
  prior_scores: PhaseScores;
  prior_findings: Array<{
    rule_id: string;
    severity: string;
    title: string;
    file: string;
  }>;
  initiating_skill?: string;
}

export interface ExternalScoreResponse {
  score: number;
  reason?: string;
}

// ── External Scorer ─────────────────────────────────────────────────────

export class ExternalScorer {
  private endpoint: string;
  private apiKey?: string;
  private timeout: number;

  constructor(opts: ExternalScorerOptions) {
    this.endpoint = opts.endpoint;
    this.apiKey = opts.apiKey;
    this.timeout = opts.timeout ?? 3000;
  }

  /**
   * Call the external scoring endpoint.
   * Returns a 0-1 score, or null if the call fails.
   */
  async score(
    envelope: ActionEnvelope,
    priorScores: PhaseScores,
    priorFindings: Finding[],
  ): Promise<{ score: number; reason?: string } | null> {
    const body: ExternalScoreRequest = {
      tool_name: envelope.action.type,
      tool_input: envelope.action.data as unknown as Record<string, unknown>,
      prior_scores: priorScores,
      prior_findings: priorFindings.map(f => ({
        rule_id: f.rule_id,
        severity: f.severity,
        title: f.title,
        file: f.location.file,
      })),
      initiating_skill: envelope.context.initiating_skill,
    };

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        console.warn(`[ExternalScorer] HTTP ${response.status}: ${response.statusText}`);
        return null;
      }

      const data = await response.json() as ExternalScoreResponse;

      // Clamp score to [0, 1]
      const score = Math.max(0, Math.min(1, data.score ?? 0));
      return { score, reason: data.reason };
    } catch (err: unknown) {
      const error = err as { name?: string; message?: string };
      if (error.name === 'AbortError') {
        console.warn(`[ExternalScorer] Request timed out after ${this.timeout}ms`);
      } else {
        console.warn(`[ExternalScorer] Request failed: ${error.message}`);
      }
      return null;
    }
  }
}
