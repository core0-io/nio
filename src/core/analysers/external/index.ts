// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * ExternalAnalyser — pluggable HTTP endpoint for external security analysis.
 *
 * Hits a user-configured URL with `GET` and expects a JSON response
 * `{ score: number, reason?: string }`. The endpoint URL (with any query
 * params the user encodes into it) is the entire request — nio does not
 * send a body. Used by both pipelines:
 *
 *   - Dynamic Guard (ActionOrchestrator Phase 6)
 *   - Static Scan  (ScanOrchestrator post-phase)
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
  /**
   * Optional custom request headers, merged over nio's defaults (the
   * Authorization header from `auth`). User entries override defaults.
   */
  headers?: Record<string, string>;
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
  private customHeaders?: Record<string, string>;

  constructor(opts: ExternalAnalyserOptions) {
    this.name = opts.name;
    this.endpoint = opts.endpoint;
    this.timeout = opts.timeout ?? 3000;
    this.weight = opts.weight ?? 1.0;
    this.auth = opts.auth;
    this.customHeaders = opts.headers;
  }

  /**
   * Score an action (guard pipeline — ActionOrchestrator Phase 6).
   *
   * The action context (toolName / toolInput / priorScores / priorFindings)
   * arguments are ignored at the HTTP level — nio just GETs the configured
   * endpoint. The endpoint is expected to score the agent or session based
   * on its own state (e.g. a `/scores/agent?agent-name=X`-style URL where
   * any context the endpoint needs is encoded in the URL itself). The args
   * are still accepted so the call-site contract is stable; future
   * GET-with-query-template support can use them.
   */
  async scoreAction(
    _toolName: string,
    _toolInput: Record<string, unknown>,
    _priorScores: Record<string, number | undefined>,
    _priorFindings: Finding[],
    _initiatingSkill?: string,
    reporter?: DiagnosticCollector,
  ): Promise<{ score: number; reason?: string } | null> {
    return this.call(reporter);
  }

  /**
   * Score a scan result (scan pipeline — ScanOrchestrator post-phase).
   * Same GET semantics as scoreAction.
   */
  async scoreScan(
    _skillId: string,
    _files: Array<{ path: string; content_preview: string }>,
    _priorFindings: Finding[],
    reporter?: DiagnosticCollector,
  ): Promise<{ score: number; reason?: string } | null> {
    return this.call(reporter);
  }

  /**
   * Low-level call — GET the configured endpoint and parse the score.
   * Emits diagnostics through the optional reporter on auth/HTTP/timeout
   * failures so the parent orchestrator can surface them in ActionDecision.
   */
  async call(reporter?: DiagnosticCollector): Promise<{ score: number; reason?: string } | null> {
    let authHeader: string | null = null;
    if (this.auth) {
      authHeader = await this.auth.getAuthHeader(reporter);
      if (!authHeader) {
        // Auth was configured but failed — skip the request entirely; a
        // request without Authorization would just earn a 401 and add noise.
        // The underlying auth strategy already emitted a diagnostic of its
        // own (kind: token_failed / cache_write_failed / etc.); we add a
        // follow-up anchored to THIS endpoint so the failure is also
        // attributable to the scoring endpoint name (not just the OAuth
        // client).
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

      // nio defaults first; user-configured headers override.
      const headers: Record<string, string> = {};
      if (authHeader) headers['Authorization'] = authHeader;
      if (this.customHeaders) Object.assign(headers, this.customHeaders);

      const response = await fetch(this.endpoint, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        // Capture a body preview so the user can see WHY the server rejected
        // (e.g. 422 usually carries a JSON explaining the missing/invalid field).
        let bodyPreview = '';
        try {
          const text = await response.text();
          bodyPreview = text.slice(0, 400);
        } catch { /* ignore */ }
        const detail = bodyPreview
          ? `${response.status} ${response.statusText}: ${bodyPreview}`
          : `${response.status} ${response.statusText}`;
        reporter?.collect({
          severity: 'error',
          source: 'external_analyser',
          kind: 'http_error',
          component: this.name,
          message: `${this.endpoint} returned HTTP ${response.status}`,
          detail,
          hint: 'Check endpoint URL and any required auth in guard.external_analyser[].auth.',
        });
        return null;
      }

      // ── Strict response schema validation ─────────────────────────
      // The endpoint MUST return `{ "score": number, "reason"?: string }`.
      // Anything else is rejected with a `response_invalid` diagnostic
      // carrying a preview of what was actually returned, so users can
      // see expected-vs-actual at a glance. nio does not support custom
      // field names or nested paths — services with a different response
      // shape must adapt via a shim.

      // We read the body as text first so we can both parse JSON AND
      // include the raw bytes in the diagnostic on failure.
      const bodyText = await response.text();
      const preview = bodyText.length > 200 ? bodyText.slice(0, 200) + '…' : bodyText;

      const emitInvalid = (kind: string, message: string): null => {
        reporter?.collect({
          severity: 'error',
          source: 'external_analyser',
          kind: 'response_invalid',
          component: this.name,
          message: `${this.endpoint}: ${message}`,
          detail: `kind=${kind}; body=${preview}`,
          hint: 'Endpoint must return { "score": number, "reason"?: string }. See docs/phases/phase-6-external.html#response-contract.',
        });
        return null;
      };

      let data: unknown;
      try {
        data = JSON.parse(bodyText);
      } catch {
        return emitInvalid('not_json', 'response body was not valid JSON');
      }

      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        return emitInvalid('not_object', 'response was not a JSON object');
      }

      const obj = data as Record<string, unknown>;
      if (!('score' in obj)) {
        return emitInvalid('score_missing', 'response object has no `score` field');
      }
      const raw = obj.score;
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return emitInvalid('score_not_a_number', '`score` is not a finite number');
      }

      const score = Math.max(0, Math.min(1, raw));
      const reasonRaw = obj.reason;
      const reason = typeof reasonRaw === 'string' ? reasonRaw : undefined;
      return { score, reason };
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
}
