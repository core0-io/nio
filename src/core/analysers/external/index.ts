// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * ExternalAnalyser — pluggable HTTP endpoint for external security analysis.
 *
 * A generalized scorer that sends context to a user-configured API and
 * receives a 0-1 score + optional findings. Usable by both pipelines:
 *
 *   - Dynamic Guard (RuntimeAnalyser Phase 6): action context + prior scores
 *   - Static Scan (ScanOrchestrator): file content + prior findings
 */

import type { Finding } from '../../models.js';

// ── Types ───────────────────────────────────────────────────────────────

export interface ExternalAnalyserOptions {
  endpoint: string;
  apiKey?: string;
  timeout?: number; // ms, default 3000
}

/** Payload sent to the external endpoint. */
export interface ExternalScoreRequest {
  /** What is being analyzed: "action" or "scan" */
  mode: 'action' | 'scan';
  /** Action context (guard pipeline) */
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  initiating_skill?: string;
  /** Scan context (scan pipeline) */
  files?: Array<{ path: string; content_preview: string }>;
  skill_id?: string;
  /** Common: prior analysis results */
  prior_scores?: Record<string, number | undefined>;
  prior_findings?: Array<{
    rule_id: string;
    severity: string;
    title: string;
    file: string;
  }>;
}

/** Response from the external endpoint. */
export interface ExternalScoreResponse {
  score: number;
  reason?: string;
}

// ── ExternalAnalyser ────────────────────────────────────────────────────

export class ExternalAnalyser {
  private endpoint: string;
  private apiKey?: string;
  private timeout: number;

  constructor(opts: ExternalAnalyserOptions) {
    this.endpoint = opts.endpoint;
    this.apiKey = opts.apiKey;
    this.timeout = opts.timeout ?? 3000;
  }

  /**
   * Score an action (guard pipeline — RuntimeAnalyser Phase 6).
   */
  async scoreAction(
    toolName: string,
    toolInput: Record<string, unknown>,
    priorScores: Record<string, number | undefined>,
    priorFindings: Finding[],
    initiatingSkill?: string,
  ): Promise<{ score: number; reason?: string } | null> {
    return this.call({
      mode: 'action',
      tool_name: toolName,
      tool_input: toolInput,
      prior_scores: priorScores,
      prior_findings: this.compactFindings(priorFindings),
      initiating_skill: initiatingSkill,
    });
  }

  /**
   * Score a scan result (scan pipeline — ScanOrchestrator post-phase).
   */
  async scoreScan(
    skillId: string,
    files: Array<{ path: string; content_preview: string }>,
    priorFindings: Finding[],
  ): Promise<{ score: number; reason?: string } | null> {
    return this.call({
      mode: 'scan',
      skill_id: skillId,
      files,
      prior_findings: this.compactFindings(priorFindings),
    });
  }

  /**
   * Low-level call — send any ExternalScoreRequest and get a score back.
   */
  async call(body: ExternalScoreRequest): Promise<{ score: number; reason?: string } | null> {
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
        console.warn(`[ExternalAnalyser] HTTP ${response.status}: ${response.statusText}`);
        return null;
      }

      const data = await response.json() as ExternalScoreResponse;

      // Clamp score to [0, 1]
      const score = Math.max(0, Math.min(1, data.score ?? 0));
      return { score, reason: data.reason };
    } catch (err: unknown) {
      const error = err as { name?: string; message?: string };
      if (error.name === 'AbortError') {
        console.warn(`[ExternalAnalyser] Request timed out after ${this.timeout}ms`);
      } else {
        console.warn(`[ExternalAnalyser] Request failed: ${error.message}`);
      }
      return null;
    }
  }

  private compactFindings(findings: Finding[]): ExternalScoreRequest['prior_findings'] {
    return findings.map(f => ({
      rule_id: f.rule_id,
      severity: f.severity,
      title: f.title,
      file: f.location.file,
    }));
  }
}
