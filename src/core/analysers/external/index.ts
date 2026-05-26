// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * ExternalAnalyser — pluggable HTTP endpoint for external security analysis.
 *
 * A generalized scorer that sends context to a user-configured API and
 * receives a 0-1 score + optional findings. Usable by both pipelines:
 *
 *   - Dynamic Guard (ActionOrchestrator Phase 6): action context + prior scores
 *   - Static Scan (ScanOrchestrator): file content + prior findings
 */

import type { Finding } from '../../models.js';
import type { AuthStrategy } from './auth.js';
import type { DiagnosticCollector } from '../../../adapters/diagnostics.js';

// ── Types ───────────────────────────────────────────────────────────────

export interface ExternalAnalyserOptions {
  name: string;
  endpoint: string;
  timeout?: number; // ms, default 3000
  weight?: number;
  /** Optional authentication strategy resolving the Authorization header. */
  auth?: AuthStrategy;
}

/** Payload sent to the external endpoint. */
export interface ExternalScoreRequest {
  /** What is being analysed: "action" or "scan" */
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
  public readonly name: string;
  public readonly weight: number;
  private endpoint: string;
  private timeout: number;
  private auth?: AuthStrategy;

  constructor(opts: ExternalAnalyserOptions) {
    this.name = opts.name;
    this.endpoint = opts.endpoint;
    this.timeout = opts.timeout ?? 3000;
    this.weight = opts.weight ?? 1.0;
    this.auth = opts.auth;
  }

  /**
   * Score an action (guard pipeline — ActionOrchestrator Phase 6).
   */
  async scoreAction(
    toolName: string,
    toolInput: Record<string, unknown>,
    priorScores: Record<string, number | undefined>,
    priorFindings: Finding[],
    initiatingSkill?: string,
    reporter?: DiagnosticCollector,
  ): Promise<{ score: number; reason?: string } | null> {
    return this.call({
      mode: 'action',
      tool_name: toolName,
      tool_input: toolInput,
      prior_scores: priorScores,
      prior_findings: this.compactFindings(priorFindings),
      initiating_skill: initiatingSkill,
    }, reporter);
  }

  /**
   * Score a scan result (scan pipeline — ScanOrchestrator post-phase).
   */
  async scoreScan(
    skillId: string,
    files: Array<{ path: string; content_preview: string }>,
    priorFindings: Finding[],
    reporter?: DiagnosticCollector,
  ): Promise<{ score: number; reason?: string } | null> {
    return this.call({
      mode: 'scan',
      skill_id: skillId,
      files,
      prior_findings: this.compactFindings(priorFindings),
    }, reporter);
  }

  /**
   * Low-level call — send any ExternalScoreRequest and get a score back.
   * Emits diagnostics through the optional reporter on auth/HTTP/timeout
   * failures so the parent orchestrator can surface them in ActionDecision.
   */
  async call(body: ExternalScoreRequest, reporter?: DiagnosticCollector): Promise<{ score: number; reason?: string } | null> {
    let authHeader: string | null = null;
    if (this.auth) {
      authHeader = await this.auth.getAuthHeader(reporter);
      if (!authHeader) {
        // Auth was configured but failed — skip the request entirely; a
        // request without Authorization would just earn a 401 and add noise.
        // The underlying auth strategy already emitted a diagnostic of its
        // own (kind: token_failed / cache_write_failed / etc.); we add a follow-up
        // anchored to THIS endpoint so the failure is also attributable to
        // the scoring endpoint name (not just the OAuth client).
        reporter?.collect({
          severity: 'error',
          source: 'external_analyser',
          kind: 'auth_failed',
          component: this.name,
          message: `Skipped ${this.endpoint}: authentication failed`,
          hint: 'See preceding [nio:oauth:*] diagnostic for the underlying cause, or run /nio doctor.',
        });
        return null;
      }
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (authHeader) headers['Authorization'] = authHeader;

      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        reporter?.collect({
          severity: 'error',
          source: 'external_analyser',
          kind: 'http_error',
          component: this.name,
          message: `${this.endpoint} returned HTTP ${response.status}`,
          detail: `${response.status} ${response.statusText}`,
          hint: 'Check endpoint URL and any required auth in guard.external_analyser[].auth.',
        });
        return null;
      }

      const data = await response.json() as ExternalScoreResponse;

      // Clamp score to [0, 1]
      const score = Math.max(0, Math.min(1, data.score ?? 0));
      return { score, reason: data.reason };
    } catch (err: unknown) {
      const error = err as { name?: string; message?: string };
      if (error.name === 'AbortError') {
        reporter?.collect({
          severity: 'error',
          source: 'external_analyser',
          kind: 'timeout',
          component: this.name,
          message: `${this.endpoint} timed out after ${this.timeout}ms`,
          hint: 'Increase guard.external_analyser[].timeout or investigate endpoint latency.',
        });
      } else {
        reporter?.collect({
          severity: 'error',
          source: 'external_analyser',
          kind: 'network_error',
          component: this.name,
          message: `${this.endpoint} request failed`,
          detail: error.message,
        });
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
