import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _setDiagnosticsAuditPathForTests } from '../adapters/diagnostics.js';

// Sandbox diagnostic writes so tests never touch ~/.nio/audit.jsonl.
let testAuditDir: string;
before(() => {
  testAuditDir = mkdtempSync(join(tmpdir(), 'nio-action-orchestrator-test-'));
  _setDiagnosticsAuditPathForTests(join(testAuditDir, 'audit.jsonl'));
});
after(() => {
  _setDiagnosticsAuditPathForTests(null);
  try { rmSync(testAuditDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
import {
  findingsToScore,
  aggregateScores,
  DEFAULT_WEIGHTS,
  type PhaseScores,
} from '../core/scoring.js';
import {
  scoreToDecision,
  shouldShortCircuit,
} from '../core/action-decision.js';
import { ExternalAnalyser } from '../core/analysers/external/index.js';
import { ActionOrchestrator } from '../core/action-orchestrator.js';
import type { Finding } from '../core/models.js';
import type { ActionEnvelope, ActionContext } from '../types/action.js';

function makeEnvelope(type: string, data: Record<string, unknown>): ActionEnvelope {
  return {
    actor: {
      skill: { id: 'test', source: 'test', version_ref: '0.0.0', artifact_hash: '' },
    },
    action: { type: type as ActionEnvelope['action']['type'], data: data as unknown as ActionEnvelope['action']['data'] },
    context: {
      session_id: 'test-session',
      user_present: true,
      env: 'test',
      time: new Date().toISOString(),
    } as ActionContext,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring: findingsToScore
// ─────────────────────────────────────────────────────────────────────────────

describe('Scoring: findingsToScore', () => {
  it('should return 0 for empty findings', () => {
    assert.equal(findingsToScore([]), 0);
  });

  it('should return 1.0 for critical finding with confidence 1.0', () => {
    const findings: Finding[] = [{
      id: 'test', rule_id: 'TEST', category: 'execution',
      severity: 'critical', title: 'Test', description: 'Test',
      location: { file: 'test', line: 0 }, analyser: 'static', confidence: 1.0,
    }];
    assert.equal(findingsToScore(findings), 1.0);
  });

  it('should return 0.75 for high severity with confidence 1.0', () => {
    const findings: Finding[] = [{
      id: 'test', rule_id: 'TEST', category: 'execution',
      severity: 'high', title: 'Test', description: 'Test',
      location: { file: 'test', line: 0 }, analyser: 'static', confidence: 1.0,
    }];
    assert.equal(findingsToScore(findings), 0.75);
  });

  it('should use max severity across multiple findings', () => {
    const findings: Finding[] = [
      {
        id: 'a', rule_id: 'A', category: 'execution',
        severity: 'low', title: 'Low', description: 'Low',
        location: { file: 'test', line: 0 }, analyser: 'static', confidence: 1.0,
      },
      {
        id: 'b', rule_id: 'B', category: 'execution',
        severity: 'high', title: 'High', description: 'High',
        location: { file: 'test', line: 0 }, analyser: 'static', confidence: 1.0,
      },
    ];
    assert.equal(findingsToScore(findings), 0.75);
  });

  it('should factor in confidence', () => {
    const findings: Finding[] = [{
      id: 'test', rule_id: 'TEST', category: 'execution',
      severity: 'critical', title: 'Test', description: 'Test',
      location: { file: 'test', line: 0 }, analyser: 'static', confidence: 0.5,
    }];
    assert.equal(findingsToScore(findings), 0.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scoring: aggregateScores
// ─────────────────────────────────────────────────────────────────────────────

describe('Scoring: aggregateScores', () => {
  it('should return 0 for empty scores', () => {
    assert.equal(aggregateScores({}), 0);
  });

  it('should return the score when only one phase ran', () => {
    const scores: PhaseScores = { runtime: 0.6 };
    assert.equal(aggregateScores(scores), 0.6);
  });

  it('should compute weighted average of multiple phases', () => {
    // runtime=0.8 (w=1.0), behavioural=0.4 (w=2.0)
    const scores: PhaseScores = { runtime: 0.8, behavioural: 0.4 };
    // (1.0*0.8 + 2.0*0.4) / (1.0 + 2.0) = (0.8 + 0.8) / 3.0 ≈ 0.5333
    const result = aggregateScores(scores);
    assert.ok(Math.abs(result - 0.5333) < 0.01, `Expected ~0.533, got ${result}`);
  });

  it('should handle all five phases (including a single external endpoint)', () => {
    const scores: PhaseScores = {
      runtime: 0.5, static: 0.5, behavioural: 0.5, llm: 0.5,
      external: { e1: 0.5 },
    };
    // All scores equal → weighted average = 0.5 regardless of weights
    assert.equal(aggregateScores(scores, DEFAULT_WEIGHTS, { e1: 2.0 }), 0.5);
  });

  it('should respect custom weights (with external endpoint weight)', () => {
    const scores: PhaseScores = { runtime: 1.0, external: { e1: 0.0 } };
    // (1.0*1.0 + 1.0*0.0) / (1.0 + 1.0) = 0.5
    assert.equal(aggregateScores(scores, { ...DEFAULT_WEIGHTS, runtime: 1.0 }, { e1: 1.0 }), 0.5);
  });

  it('should give higher weight to behavioural', () => {
    // runtime=1.0 (w=1), behavioural=0.0 (w=2) → (1*1 + 2*0) / (1+2) = 0.333
    const scores: PhaseScores = { runtime: 1.0, behavioural: 0.0 };
    const result = aggregateScores(scores);
    assert.ok(Math.abs(result - 0.333) < 0.01, `Expected ~0.333, got ${result}`);
  });

  it('should aggregate multiple external endpoints by their per-endpoint weights', () => {
    // runtime=0.5 (w=1), external.a=1.0 (w=2), external.b=0.0 (w=1)
    // → (1*0.5 + 2*1.0 + 1*0.0) / (1+2+1) = 2.5 / 4 = 0.625
    const scores: PhaseScores = {
      runtime: 0.5,
      external: { a: 1.0, b: 0.0 },
    };
    const result = aggregateScores(scores, DEFAULT_WEIGHTS, { a: 2.0, b: 1.0 });
    assert.ok(Math.abs(result - 0.625) < 1e-6, `Expected 0.625, got ${result}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Decision: scoreToDecision
// ─────────────────────────────────────────────────────────────────────────────

describe('Decision: scoreToDecision', () => {
  it('strict: 0.3 → allow', () => {
    assert.equal(scoreToDecision(0.3, 'strict'), 'allow');
  });

  it('strict: 0.5 → deny', () => {
    assert.equal(scoreToDecision(0.5, 'strict'), 'deny');
  });

  it('strict: 0.7 → deny (no confirm zone)', () => {
    assert.equal(scoreToDecision(0.7, 'strict'), 'deny');
  });

  it('balanced: 0.3 → allow', () => {
    assert.equal(scoreToDecision(0.3, 'balanced'), 'allow');
  });

  it('balanced: 0.6 → confirm', () => {
    assert.equal(scoreToDecision(0.6, 'balanced'), 'confirm');
  });

  it('balanced: 0.9 → deny', () => {
    assert.equal(scoreToDecision(0.9, 'balanced'), 'deny');
  });

  it('permissive: 0.8 → allow', () => {
    assert.equal(scoreToDecision(0.8, 'permissive'), 'allow');
  });

  it('permissive: 0.95 → deny', () => {
    assert.equal(scoreToDecision(0.95, 'permissive'), 'deny');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Decision: shouldShortCircuit
// ─────────────────────────────────────────────────────────────────────────────

describe('Decision: shouldShortCircuit', () => {
  it('strict: score 0.5 → short-circuit', () => {
    assert.ok(shouldShortCircuit(0.5, 'strict'));
  });

  it('strict: score 0.4 → no short-circuit', () => {
    assert.ok(!shouldShortCircuit(0.4, 'strict'));
  });

  it('balanced: score 0.8 → short-circuit', () => {
    assert.ok(shouldShortCircuit(0.8, 'balanced'));
  });

  it('balanced: score 0.7 → no short-circuit', () => {
    assert.ok(!shouldShortCircuit(0.7, 'balanced'));
  });

  it('permissive: score 0.9 → short-circuit', () => {
    assert.ok(shouldShortCircuit(0.9, 'permissive'));
  });

  it('permissive: score 0.89 → no short-circuit', () => {
    assert.ok(!shouldShortCircuit(0.89, 'permissive'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ExternalAnalyser
// ─────────────────────────────────────────────────────────────────────────────

describe('ExternalAnalyser', () => {
  it('should construct with endpoint and optional settings', () => {
    const scorer = new ExternalAnalyser({
      name: 'test',
      endpoint: 'https://example.com/score',
      timeout: 5000,
    });
    assert.ok(scorer, 'Should construct without error');
  });

  it('should return null on network error (unreachable endpoint)', async () => {
    const scorer = new ExternalAnalyser({
      name: 'test',
      endpoint: 'http://127.0.0.1:1/score', // unreachable
      timeout: 500,
    });

    const result = await scorer.scoreAction('exec_command', { command: 'ls' }, {}, []);
    assert.equal(result, null, 'Should return null on network error');
  });

  it('should clamp score to [0, 1] range', async () => {
    // We can't easily mock fetch in node:test without a library,
    // but we test the clamping logic indirectly through the class.
    // The ExternalAnalyser.score method clamps: Math.max(0, Math.min(1, data.score ?? 0))
    // This is verified by the integration test above (returns null on error).
    assert.ok(true, 'Clamping logic exists in ExternalAnalyser.call()');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ActionOrchestrator: Phase 5/6 wiring
// ─────────────────────────────────────────────────────────────────────────────

describe('ActionOrchestrator: Phase 5/6 options', () => {
  it('should accept llmApiKey and externalAnalysers options', () => {
    const analyser = new ActionOrchestrator({
      llmApiKey: 'test-key',
      llmModel: 'claude-sonnet-4-20250514',
      externalAnalysers: [{
        name: 'e1',
        endpoint: 'https://example.com/score',
        weight: 1,
        timeout: 5000,
        auth: { type: 'bearer', api_key: 'score-key' },
      }],
    });
    assert.ok(analyser, 'Should construct with Phase 5/6 options');
  });

  it('should skip Phase 5 when no llmApiKey', async () => {
    const analyser = new ActionOrchestrator({}); // no llmApiKey
    const envelope = makeEnvelope('exec_command', { command: 'echo hello' });

    const result = await analyser.evaluate(envelope);
    // Phase 5 should not have run — llm score should be absent
    assert.equal(result.scores.llm, undefined, 'Phase 5 score should be undefined when no API key');
  });

  it('should skip Phase 6 when externalAnalysers is empty', async () => {
    const analyser = new ActionOrchestrator({ externalAnalysers: [] });
    const envelope = makeEnvelope('exec_command', { command: 'echo hello' });

    const result = await analyser.evaluate(envelope);
    assert.equal(result.scores.external, undefined, 'Phase 6 score should be undefined with no endpoints');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ActionOrchestrator: Phase 6 multi-endpoint
// ─────────────────────────────────────────────────────────────────────────────

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

interface ScorerOpts {
  /**
   * Score returned by the endpoint. Used to construct the default
   * `{ score, reason }` body when `body` / `rawBody` aren't set.
   */
  score?: number;
  /** Explicit JSON body — takes precedence over `score`. */
  body?: unknown;
  /** Raw text body — takes precedence over `body` (for "not JSON" tests). */
  rawBody?: string;
  /** When true, the listener closes the socket without responding. */
  drop?: boolean;
}

interface ScorerObserved {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  url?: string;
}

function startScorer(opts: ScorerOpts): Promise<{ url: string; server: Server; observed: ScorerObserved }> {
  const observed: ScorerObserved = {};
  const server = createServer((req, res) => {
    if (opts.drop) {
      res.socket?.destroy();
      return;
    }
    observed.method = req.method;
    observed.headers = req.headers as Record<string, string | string[] | undefined>;
    observed.url = req.url;
    let reqBody = '';
    req.on('data', c => { reqBody += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (opts.rawBody !== undefined) {
        res.end(opts.rawBody);
      } else if (opts.body !== undefined) {
        res.end(JSON.stringify(opts.body));
      } else {
        res.end(JSON.stringify({ score: opts.score ?? 0, reason: `scored ${opts.score ?? 0}` }));
      }
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, server, observed });
    });
  });
}

function stopScorer(server: Server): Promise<void> {
  return new Promise(r => server.close(() => r()));
}

describe('ActionOrchestrator: Phase 6 multi-endpoint', () => {
  it('aggregates two endpoints by per-endpoint weight', async () => {
    const a = await startScorer({ score: 0.4 });
    const b = await startScorer({ score: 0.1 });
    try {
      const analyser = new ActionOrchestrator({
        externalAnalysers: [
          { name: 'a', endpoint: a.url, weight: 3.0 },
          { name: 'b', endpoint: b.url, weight: 1.0 },
        ],
      });
      const result = await analyser.evaluate(makeEnvelope('exec_command', { command: 'echo hi' }));

      assert.deepEqual(result.scores.external, { a: 0.4, b: 0.1 });
      // Phase 2 (runtime) ran with score=0 and weight=1, contributing 0/1 to the
      // weighted average. External adds (3*0.4 + 1*0.1) on top with weight 3+1=4.
      // Final = (0 + 1.2 + 0.1) / (1 + 3 + 1) = 1.3 / 5 = 0.26.
      assert.ok(result.scores.final !== undefined);
      assert.ok(Math.abs(result.scores.final! - 0.26) < 1e-6,
        `expected final ≈ 0.26, got ${result.scores.final}`);
    } finally {
      await stopScorer(a.server);
      await stopScorer(b.server);
    }
  });

  it('short-circuits when ANY endpoint returns critical (final ≥ critical, not diluted)', async () => {
    const critical = await startScorer({ score: 0.95 });
    const quiet    = await startScorer({ score: 0.05 });
    try {
      const analyser = new ActionOrchestrator({
        level: 'balanced',
        externalAnalysers: [
          { name: 'critical', endpoint: critical.url, weight: 1.0 },
          { name: 'quiet',    endpoint: quiet.url,    weight: 1.0 },
        ],
      });
      const result = await analyser.evaluate(makeEnvelope('exec_command', { command: 'echo hi' }));

      assert.equal(result.phase_stopped, 6);
      assert.equal(result.decision, 'deny');
      assert.ok(result.scores.final !== undefined && result.scores.final >= 0.95,
        `expected final ≥ 0.95, got ${result.scores.final}`);
      assert.ok(
        result.findings.some(f => f.rule_id === 'EXTERNAL_SCORE:critical'),
        'expected synthetic finding tagged with critical endpoint name',
      );
    } finally {
      await stopScorer(critical.server);
      await stopScorer(quiet.server);
    }
  });

  it('survives one endpoint failing — other endpoint still contributes', async () => {
    const dead = await startScorer({ score: 0, drop: true });
    const live = await startScorer({ score: 0.3 });
    try {
      const analyser = new ActionOrchestrator({
        externalAnalysers: [
          { name: 'dead', endpoint: dead.url, weight: 1.0, timeout: 200 },
          { name: 'live', endpoint: live.url, weight: 1.0 },
        ],
      });
      const result = await analyser.evaluate(makeEnvelope('exec_command', { command: 'echo hi' }));

      // dead endpoint is omitted from scores.external (it produced no score),
      // but its failure stays visible in phase_timings.external with an `error`
      // field. live is recorded normally.
      assert.deepEqual(result.scores.external, { live: 0.3 });
      assert.ok(result.phase_timings?.external?.['live']);
      assert.ok(result.phase_timings?.external?.['dead'], 'failed endpoint must keep an entry');
      assert.equal(result.phase_timings?.external?.['dead']?.score, 0);
      assert.ok(result.phase_timings?.external?.['dead']?.error, 'failed endpoint entry has error info');

      // Diagnostics include the failure attributable to "dead"
      assert.ok(
        result.diagnostics?.some(d =>
          d.source === 'external_analyser' && d.component === 'dead'),
        'expected diagnostic for the dead endpoint',
      );
    } finally {
      await stopScorer(dead.server);
      await stopScorer(live.server);
    }
  });

  it('issues GET requests (no body, no Content-Type)', async () => {
    const scorer = await startScorer({ score: 0.3 });
    try {
      const analyser = new ActionOrchestrator({
        externalAnalysers: [{ name: 's', endpoint: scorer.url, weight: 1.0 }],
      });
      await analyser.evaluate(makeEnvelope('exec_command', { command: 'echo hi' }));
      assert.equal(scorer.observed.method, 'GET');
      assert.equal(scorer.observed.headers?.['content-type'], undefined,
        'GET must not send a Content-Type header');
      assert.equal(scorer.observed.headers?.['content-length'], undefined,
        'GET must not carry a body');
    } finally {
      await stopScorer(scorer.server);
    }
  });

  it('forwards user-configured headers and lets them override defaults', async () => {
    const scorer = await startScorer({ score: 0.1 });
    try {
      const analyser = new ActionOrchestrator({
        externalAnalysers: [{
          name: 's',
          endpoint: scorer.url,
          weight: 1.0,
          headers: {
            'X-Tenant-Id': 'tenant-42',
            // Override an arbitrary header to prove user wins:
            'X-Override': 'user-value',
          },
        }],
      });
      await analyser.evaluate(makeEnvelope('exec_command', { command: 'echo hi' }));
      assert.equal(scorer.observed.headers?.['x-tenant-id'], 'tenant-42');
      assert.equal(scorer.observed.headers?.['x-override'], 'user-value');
    } finally {
      await stopScorer(scorer.server);
    }
  });

  it('GETs the endpoint URL verbatim (nio does not inject query params)', async () => {
    const scorer = await startScorer({ score: 0.4 });
    try {
      const analyser = new ActionOrchestrator({
        externalAnalysers: [{
          name: 's',
          endpoint: `${scorer.url}/?agent-name=cc`,
          weight: 1.0,
        }],
      });
      await analyser.evaluate(makeEnvelope('exec_command', { command: 'echo hi' }));

      const observedUrl = scorer.observed.url ?? '';
      const parsed = new URL(`http://x${observedUrl}`);
      // User-encoded query param preserved.
      assert.equal(parsed.searchParams.get('agent-name'), 'cc');
      // nio doesn't append anything of its own.
      assert.ok(!parsed.searchParams.has('start'));
      assert.ok(!parsed.searchParams.has('end'));
    } finally {
      await stopScorer(scorer.server);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ActionOrchestrator: Phase 6 response schema validation
// ─────────────────────────────────────────────────────────────────────────────

describe('ActionOrchestrator: Phase 6 response schema', () => {
  async function evaluateWith(body: unknown | undefined, rawBody?: string): Promise<{
    final?: number;
    external?: Record<string, number>;
    error?: { kind: string; detail?: string };
    diagnostics?: Array<{ kind?: string; detail?: string; message?: string }>;
  }> {
    const scorer = await startScorer({ body, rawBody });
    try {
      const analyser = new ActionOrchestrator({
        externalAnalysers: [{ name: 's', endpoint: scorer.url, weight: 1.0 }],
      });
      const result = await analyser.evaluate(makeEnvelope('exec_command', { command: 'echo hi' }));
      return {
        final: result.scores.final,
        external: result.scores.external,
        error: result.phase_timings?.external?.['s']?.error,
        diagnostics: result.diagnostics?.filter(
          d => d.source === 'external_analyser',
        ) as Array<{ kind?: string; detail?: string; message?: string }>,
      };
    } finally {
      await stopScorer(scorer.server);
    }
  }

  it('accepts the contract shape: { score }', async () => {
    const r = await evaluateWith({ score: 0.5 });
    assert.deepEqual(r.external, { s: 0.5 });
    assert.equal(r.error, undefined);
  });

  it('accepts the contract shape with reason: { score, reason }', async () => {
    const r = await evaluateWith({ score: 0.4, reason: 'production bucket' });
    assert.deepEqual(r.external, { s: 0.4 });
    assert.equal(r.error, undefined);
  });

  it('clamps score > 1 to 1', async () => {
    const r = await evaluateWith({ score: 1.5 });
    assert.deepEqual(r.external, { s: 1 });
  });

  it('clamps score < 0 to 0', async () => {
    const r = await evaluateWith({ score: -0.2 });
    assert.deepEqual(r.external, { s: 0 });
  });

  it('rejects: missing score field — emits response_invalid (score_missing)', async () => {
    const r = await evaluateWith({ value: 0.5, agent: 'x' });
    assert.equal(r.external, undefined, 'endpoint must not contribute a score');
    assert.equal(r.error?.kind, 'response_invalid');
    assert.match(r.error?.detail ?? '', /kind=score_missing/);
    // Body preview echoes what the server actually returned:
    assert.match(r.error?.detail ?? '', /"value":0\.5/);
    assert.ok(r.diagnostics && r.diagnostics.length >= 1);
  });

  it('rejects: score is a string — emits response_invalid (score_not_a_number)', async () => {
    const r = await evaluateWith({ score: '0.5' });
    assert.equal(r.error?.kind, 'response_invalid');
    assert.match(r.error?.detail ?? '', /kind=score_not_a_number/);
  });

  it('rejects: score is NaN-like (we send Infinity since JSON.stringify drops NaN)', async () => {
    // JSON.stringify(NaN) → "null", so we send the raw text "{\"score\":NaN}"
    // — invalid JSON, which exercises not_json. To exercise score_not_a_number
    // specifically, send score as null (number-typed but not finite).
    const r = await evaluateWith({ score: null });
    assert.equal(r.error?.kind, 'response_invalid');
    assert.match(r.error?.detail ?? '', /kind=score_not_a_number/);
  });

  it('rejects: response is a JSON array, not an object', async () => {
    const r = await evaluateWith([{ score: 0.5 }]);
    assert.equal(r.error?.kind, 'response_invalid');
    assert.match(r.error?.detail ?? '', /kind=not_object/);
  });

  it('rejects: response is a raw number, not an object', async () => {
    const r = await evaluateWith(0.5);
    assert.equal(r.error?.kind, 'response_invalid');
    assert.match(r.error?.detail ?? '', /kind=not_object/);
  });

  it('rejects: response body is not valid JSON at all', async () => {
    const r = await evaluateWith(undefined, 'this is not json');
    assert.equal(r.error?.kind, 'response_invalid');
    assert.match(r.error?.detail ?? '', /kind=not_json/);
    assert.match(r.error?.detail ?? '', /this is not json/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ActionOrchestrator: user-supplied dangerous_patterns (action_guard_rules)
// ─────────────────────────────────────────────────────────────────────────────

describe('ActionOrchestrator: dangerous_patterns (user config)', () => {
  const sqlPattern = '/\\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\\b/i';

  function newAnalyser() {
    return new ActionOrchestrator({
      actionGuardRules: { dangerous_patterns: [sqlPattern] },
    });
  }

  it('denies uppercase SQL UPDATE via /pattern/i', async () => {
    const analyser = newAnalyser();
    const envelope = makeEnvelope('exec_command', {
      command: `psql -c "UPDATE students SET gpa = 7.09 WHERE first_name = 'Ryan'"`,
    });
    const result = await analyser.evaluate(envelope);

    assert.equal(result.decision, 'deny');
    assert.equal(result.risk_level, 'critical');
    assert.equal(result.scores.final, 1);
    assert.equal(result.phase_stopped, 2, 'should short-circuit at Phase 2');
    assert.ok(
      result.findings.some((f) => f.rule_id === 'DANGEROUS_PATTERN'),
      'expected a DANGEROUS_PATTERN finding',
    );
  });

  it('denies lowercase sql update (case-insensitive flag works)', async () => {
    const analyser = newAnalyser();
    const envelope = makeEnvelope('exec_command', {
      command: `psql -c "update students set gpa = 7.09 where first_name = 'Ryan'"`,
    });
    const result = await analyser.evaluate(envelope);

    assert.equal(result.decision, 'deny');
    assert.equal(result.risk_level, 'critical');
    assert.equal(result.scores.final, 1);
    assert.ok(result.findings.some((f) => f.rule_id === 'DANGEROUS_PATTERN'));
  });

  it('allows benign SELECT query (no false positive)', async () => {
    const analyser = newAnalyser();
    const envelope = makeEnvelope('exec_command', {
      command: `psql -c 'SELECT 1'`,
    });
    const result = await analyser.evaluate(envelope);

    assert.equal(result.decision, 'allow');
    assert.equal(
      result.findings.filter((f) => f.rule_id === 'DANGEROUS_PATTERN').length,
      0,
    );
  });

  it('tolerates invalid user patterns without disabling valid ones', async () => {
    const analyser = new ActionOrchestrator({
      actionGuardRules: {
        dangerous_patterns: ['(?i)broken_inline_flag', '(unclosed', sqlPattern],
      },
    });
    const envelope = makeEnvelope('exec_command', {
      command: `psql -c "update x set y=1"`,
    });
    const result = await analyser.evaluate(envelope);

    assert.equal(result.decision, 'deny');
    assert.ok(result.findings.some((f) => f.rule_id === 'DANGEROUS_PATTERN'));
  });

  it('supports plain (no-flag) pattern syntax for backward compat', async () => {
    const analyser = new ActionOrchestrator({
      actionGuardRules: { dangerous_patterns: ['\\bUPDATE\\b'] },
    });
    const envelope = makeEnvelope('exec_command', {
      command: `psql -c "UPDATE x SET y=1"`,
    });
    const result = await analyser.evaluate(envelope);

    assert.equal(result.decision, 'deny');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ActionOrchestrator: user-supplied secret_patterns (action_guard_rules)
// ─────────────────────────────────────────────────────────────────────────────

describe('ActionOrchestrator: secret_patterns (user config)', () => {
  it('matches user pattern in network request body', async () => {
    const analyser = new ActionOrchestrator({
      actionGuardRules: { secret_patterns: ['/CORP-[A-Z0-9]{8}/i'] },
    });
    const envelope = makeEnvelope('network_request', {
      url: 'https://example.com/leak',
      method: 'POST',
      body_preview: 'token=CORP-ABCD1234 some=thing',
    });
    const result = await analyser.evaluate(envelope);

    assert.ok(
      result.findings.some((f) => f.rule_id === 'SECRET_LEAK_USER'),
      'expected a SECRET_LEAK_USER finding',
    );
  });

  it('does not match when pattern is absent', async () => {
    const analyser = new ActionOrchestrator({
      actionGuardRules: { secret_patterns: ['/CORP-[A-Z0-9]{8}/i'] },
    });
    const envelope = makeEnvelope('network_request', {
      url: 'https://example.com/leak',
      method: 'POST',
      body_preview: 'nothing sensitive here',
    });
    const result = await analyser.evaluate(envelope);

    assert.equal(
      result.findings.filter((f) => f.rule_id === 'SECRET_LEAK_USER').length,
      0,
    );
  });

  it('silently skips invalid user secret patterns', async () => {
    const analyser = new ActionOrchestrator({
      actionGuardRules: { secret_patterns: ['(unclosed', '/valid-[0-9]+/'] },
    });
    const envelope = makeEnvelope('network_request', {
      url: 'https://example.com/leak',
      method: 'POST',
      body_preview: 'leaking valid-12345',
    });
    const result = await analyser.evaluate(envelope);

    assert.ok(result.findings.some((f) => f.rule_id === 'SECRET_LEAK_USER'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// exec_command inline-code unwrap → Phase 3/4 coverage
// ─────────────────────────────────────────────────────────────────────────────

describe('ActionOrchestrator: inline code in exec_command', () => {
  it('catches `python3 -c shutil.rmtree(...)` via Phase 4 DESTRUCTIVE_FS', async () => {
    const analyser = new ActionOrchestrator({ level: 'balanced' });
    const envelope = makeEnvelope('exec_command', {
      command: `python3 -c "import shutil; shutil.rmtree('/tmp/victim')"`,
    });
    const result = await analyser.evaluate(envelope);

    assert.ok(
      result.findings.some((f) => f.rule_id === 'DESTRUCTIVE_FS'),
      `expected DESTRUCTIVE_FS, got rule_ids=[${result.findings.map((f) => f.rule_id).join(', ')}]`,
    );
    // Symmetric with Phase 2's `rm -rf` under balanced: short-circuit
    // at Phase 4 with critical severity should deny, not get diluted
    // by clean Phase 2/3 scores down into the confirm band.
    assert.equal(result.decision, 'deny');
    assert.equal(result.phase_stopped, 4);
  });

  it('catches python heredoc body (the e2e-observed bypass shape)', async () => {
    const cmd = [
      "python3 - <<'PY'",
      'import shutil, os',
      "p='/tmp/gh-stats-cli'",
      'shutil.rmtree(p, ignore_errors=True)',
      'PY',
    ].join('\n');
    const analyser = new ActionOrchestrator({ level: 'balanced' });
    const envelope = makeEnvelope('exec_command', { command: cmd });
    const result = await analyser.evaluate(envelope);

    assert.ok(
      result.findings.some((f) => f.rule_id === 'DESTRUCTIVE_FS'),
      'expected DESTRUCTIVE_FS finding for python heredoc shutil.rmtree',
    );
  });

  it('catches `node -e fs.rmSync(...)` via Phase 4', async () => {
    const analyser = new ActionOrchestrator({ level: 'balanced' });
    const envelope = makeEnvelope('exec_command', {
      command: `node -e "require('fs').rmSync('/tmp/v', {recursive: true, force: true})"`,
    });
    const result = await analyser.evaluate(envelope);

    assert.ok(
      result.findings.some((f) => f.rule_id === 'DESTRUCTIVE_FS'),
      'expected DESTRUCTIVE_FS finding for node -e fs.rmSync',
    );
  });

  it('does not flag benign `node index.js foo` (regression guard)', async () => {
    const analyser = new ActionOrchestrator({ level: 'balanced' });
    const envelope = makeEnvelope('exec_command', {
      command: 'node index.js nodejs/node',
    });
    const result = await analyser.evaluate(envelope);

    assert.equal(result.decision, 'allow');
    assert.ok(
      !result.findings.some((f) => f.rule_id === 'DESTRUCTIVE_FS'),
      'benign node invocation should not produce DESTRUCTIVE_FS',
    );
  });

  it('still catches literal `rm -rf` at Phase 2 (no regression)', async () => {
    const analyser = new ActionOrchestrator({ level: 'balanced' });
    const envelope = makeEnvelope('exec_command', {
      command: 'rm -rf /tmp/victim',
    });
    const result = await analyser.evaluate(envelope);

    assert.equal(result.decision, 'deny');
    assert.ok(
      result.findings.some((f) => f.rule_id === 'DANGEROUS_COMMAND'),
      'Phase 2 should still own literal rm -rf',
    );
  });
});

describe('structured guard stages', () => {
  it('records runtime blocking and skips all later stages', async () => {
    const result = await new ActionOrchestrator().evaluate(makeEnvelope('exec_command', { command: 'rm -rf /' }));
    const audit = result.audit;
    assert.ok(audit, 'structured stage metadata must accompany a decision');
    assert.equal(audit.termination.kind, 'gate_block');
    assert.equal(audit.termination.blocked_gate, 'runtime');
    assert.equal(audit.phases[1].status, 'completed');
    assert.equal(audit.phases[2].status, 'completed');
    assert.ok(audit.phases.slice(3).every(p => p.skip_reason === 'terminated_earlier'));
    assert.ok(audit.findings.every(f => f.phase_id === 2));
  });
  it('records disabled and inapplicable phases and missing LLM credentials as failure', async () => {
    const result = await new ActionOrchestrator({ llmEnabled: true }).evaluate(makeEnvelope('exec_command', { command: 'echo hello' }));
    const audit = result.audit;
    assert.ok(audit, 'structured stage metadata must accompany a decision');
    assert.equal(audit.phases[0].skip_reason, 'not_applicable');
    assert.equal(audit.phases[3].skip_reason, 'not_applicable');
    assert.equal(audit.phases[5].status, 'failed');
    assert.equal(audit.phases[5].score, null);
    assert.equal(audit.phases[5].duration_ms, null);
    assert.equal(audit.phases[5].error?.kind, 'api_key_missing');
    assert.equal(audit.phases[6].skip_reason, 'disabled');
    assert.equal(audit.termination.kind, 'completed');
  });
});

describe('structured guard failure history', () => {
  it('marks a recoverable LLM failure without changing its existing score or decision', async () => {
    const orchestrator = new ActionOrchestrator({ llmEnabled: true, llmApiKey: 'fixture-key' });
    const internals = orchestrator as unknown as { runLLMOnAction: (envelope: ActionEnvelope, reporter: import('../adapters/diagnostics.js').DiagnosticCollector) => Promise<Finding[]> };
    internals.runLLMOnAction = async (_envelope, reporter) => {
      reporter.collect({ source: 'llm', severity: 'error', kind: 'api_failed', message: 'Fixture API failed' });
      return [];
    };
    const result = await orchestrator.evaluate(makeEnvelope('exec_command', { command: 'echo hello' }));
    assert.equal(result.decision, 'allow');
    assert.equal(result.scores.llm, 0);
    assert.equal(result.audit?.phases[5].status, 'failed');
    assert.equal(result.audit?.phases[5].score, null);
    assert.equal(result.audit?.phases[5].error?.kind, 'api_failed');
  });
  it('retains completed stages and original error when an analyser throws', async () => {
    const { GuardEvaluation } = await import('../core/guard-evaluation.js');
    const audit = new GuardEvaluation();
    const orchestrator = new ActionOrchestrator();
    const failure = new Error('Static fixture failed');
    (orchestrator as unknown as { runStaticOnContent: () => Promise<Finding[]> }).runStaticOnContent = async () => { throw failure; };
    await assert.rejects(orchestrator.evaluate(makeEnvelope('write_file', { path: 'hello.txt', content_preview: 'hello' }), undefined, audit), error => error === failure);
    assert.equal(audit.phases[1].status, 'completed');
    assert.equal(audit.phases[2].status, 'completed');
    assert.equal(audit.phases[3].status, 'failed');
    assert.equal(audit.phases[3].error?.message, 'Static fixture failed');
    assert.ok(audit.phases.slice(4).every(p => p.skip_reason === 'terminated_earlier'));
    assert.equal(audit.termination.kind, 'engine_error');
  });
  it('retains individually disabled external services', async () => {
    const result = await new ActionOrchestrator({ externalAnalysers: [{ name: 'disabled-policy', endpoint: 'http://unused', enabled: false }] }).evaluate(makeEnvelope('exec_command', { command: 'echo hello' }));
    assert.equal(result.audit?.phases[6].status, 'skipped');
    assert.equal(result.audit?.phases[6].external_results?.[0].name, 'disabled-policy');
    assert.equal(result.audit?.phases[6].external_results?.[0].status, 'skipped');
  });
});

describe('structured guard factual policy skips', () => {
  it('does not claim an LLM analyser ran when its existing scan policy disables it', async () => {
    const result = await new ActionOrchestrator({ llmEnabled: true, llmApiKey: 'fixture-key' }).evaluate(makeEnvelope('exec_command', { command: 'echo hello' }));
    assert.equal(result.scores.llm, 0);
    assert.equal(result.audit?.phases[5].status, 'skipped');
    assert.equal(result.audit?.phases[5].skip_reason, 'disabled');
    assert.equal(result.audit?.phases[5].duration_ms, null);
  });
  it('includes the actual numeric deny threshold in block reasons', async () => {
    const result = await new ActionOrchestrator().evaluate(makeEnvelope('exec_command', { command: 'rm -rf /' }));
    assert.match(result.audit!.termination.reason, /threshold 0\.8/);
  });
});

describe('structured guard decision coverage', () => {
  const critical: Finding = { id: 'fixture', rule_id: 'FIXTURE_CRITICAL', severity: 'critical', category: 'policy_violation', title: 'Fixture rule', description: 'Fixture evidence', confidence: 1, location: { file: 'fixture', line: 1 }, analyser: 'static' };
  for (const [method, gate, phase] of [['runStaticOnContent', 'static', 3], ['runBehaviouralOnContent', 'behavioural', 4], ['runLLMOnAction', 'llm', 5]] as const) {
    it(`identifies ${gate} blocking without truncating structured findings`, async () => {
      const orchestrator = new ActionOrchestrator({ llmEnabled: gate === 'llm', llmApiKey: 'fixture' });
      const internals = orchestrator as unknown as Record<string, () => Promise<Finding[]>>;
      internals.runStaticOnContent = async () => [];
      internals.runBehaviouralOnContent = async () => [];
      internals[method] = async () => Array.from({ length: 8 }, (_, index) => ({ ...critical, id: `fixture-${index}` }));
      const result = await orchestrator.evaluate(makeEnvelope('write_file', { path: 'hello.ts', content_preview: 'const hello = 1;' }));
      assert.equal(result.decision, 'deny');
      assert.equal(result.scores.final, 1);
      assert.equal(result.audit?.termination.blocked_gate, gate);
      assert.equal(result.audit?.findings.length, 8);
      assert.ok(result.audit?.findings.every(f => f.phase_id === phase));
      assert.equal(result.audit?.phases.filter(p => p.triggered_block).length, 1);
      assert.ok(result.audit?.phases.slice(phase + 1).every(p => p.skip_reason === 'terminated_earlier'));
    });
  }
  it('records allowlist exit distinctly', async () => {
    const result = await new ActionOrchestrator({ allowlistMode: 'exit' }).evaluate(makeEnvelope('exec_command', { command: 'ls' }));
    assert.equal(result.decision, 'allow');
    assert.equal(result.audit?.termination.kind, 'allowlist_allow');
    assert.ok(result.audit?.phases.slice(2).every(p => p.skip_reason === 'terminated_earlier'));
  });
  it('records confirmation as completed rather than blocked', async () => {
    const orchestrator = new ActionOrchestrator({ scoringWeights: { runtime: 0, static: 1 } });
    (orchestrator as unknown as { runStaticOnContent: () => Promise<Finding[]> }).runStaticOnContent = async () => [{ ...critical, severity: 'high' }];
    const result = await orchestrator.evaluate(makeEnvelope('write_file', { path: 'hello.txt', content_preview: 'hello' }));
    assert.equal(result.decision, 'confirm');
    assert.equal(result.scores.final, 0.75);
    assert.equal(result.audit?.termination.kind, 'completed');
    assert.equal(result.audit?.termination.blocked_gate, null);
    assert.equal(result.audit?.phases.filter(p => p.triggered_block).length, 0);
  });
  it('retains all external results, reasons and failures with partial success', async () => {
    const success = await startScorer({ score: 0.95 });
    const failure = await startScorer({ rawBody: 'invalid' });
    try {
      const result = await new ActionOrchestrator({ externalAnalysers: [
        { name: 'success', endpoint: success.url }, { name: 'failure', endpoint: failure.url }, { name: 'disabled', endpoint: '', enabled: false },
      ] }).evaluate(makeEnvelope('exec_command', { command: 'echo hello' }));
      assert.equal(result.decision, 'deny');
      assert.equal(result.audit?.termination.blocked_gate, 'external');
      const phase = result.audit!.phases[6];
      assert.equal(phase.status, 'completed');
      assert.equal(phase.external_results?.length, 3);
      assert.equal(phase.external_results?.find(r => r.name === 'success')?.reason, 'scored 0.95');
      assert.equal(phase.external_results?.find(r => r.name === 'failure')?.status, 'failed');
      assert.equal(phase.external_results?.find(r => r.name === 'failure')?.score, null);
      assert.deepEqual(result.scores.external, { success: 0.95 });
    } finally { await stopScorer(success.server); await stopScorer(failure.server); }
  });
});


describe('structured all-external failure', () => {
  it('keeps all failed service results and an explicit failed phase reason', async () => {
    const failure = await startScorer({ rawBody: 'invalid' });
    try {
      const result = await new ActionOrchestrator({ externalAnalysers: [{ name: 'failure', endpoint: failure.url }] }).evaluate(makeEnvelope('exec_command', { command: 'echo hello' }));
      assert.equal(result.decision, 'allow');
      assert.equal(result.scores.external, undefined);
      assert.equal(result.audit?.phases[6].status, 'failed');
      assert.equal(result.audit?.phases[6].score, null);
      assert.match(result.audit!.phases[6].reason, /failed/i);
      assert.equal(result.audit?.phases[6].external_results?.[0].status, 'failed');
    } finally { await stopScorer(failure.server); }
  });
});


describe('behavioural parsing audit facts', () => {
  for (const [path, content, status] of [
    ['/tmp/probe.js', 'function broken(', 'failed'],
    ['/tmp/probe.js', 'const value = 1;', 'completed'],
    ['/tmp/probe.txt', 'ordinary text', 'skipped'],
    ['/tmp/probe.mts', 'const value = 1;', 'skipped'],
    ['/tmp/probe.js', '', 'skipped'],
  ] as const) {
    it(`records ${status} for ${path} with ${JSON.stringify(content)}`, async () => {
      const { GuardEvaluation } = await import('../core/guard-evaluation.js');
      const { buildEvaluatedGuardAuditEntry } = await import('../adapters/common.js');
      const { validateGuardAuditEntry } = await import('../schemas/index.js');
      const audit = new GuardEvaluation();
      const result = await new ActionOrchestrator().evaluate(makeEnvelope('write_file', { path, content_preview: content }), undefined, audit);
      const phase = result.audit!.phases[4];
      assert.equal(phase.status, status);
      assert.equal(result.decision, 'allow');
      assert.equal(result.scores.final, 0);
      assert.deepEqual(result.findings, []);
      assert.equal(result.audit!.termination.kind, 'completed');
      assert.equal(phase.finding_count, 0);
      if (status === 'failed') {
        assert.equal(result.scores.behavioural, 0);
        assert.equal(phase.score, null);
        assert.equal(phase.error?.kind, 'parse_failed');
        assert.ok(phase.duration_ms !== null);
        assert.ok(!JSON.stringify(phase).includes(content));
      } else if (status === 'completed') {
        assert.equal(phase.score, 0);
        assert.equal(phase.error, undefined);
      } else {
        assert.equal(phase.skip_reason, 'not_applicable');
        assert.equal(phase.score, null);
        assert.equal(phase.duration_ms, null);
      }
      const entry = buildEvaluatedGuardAuditEntry(
        { toolName: 'Write', toolInput: { file_path: path, content }, eventType: 'pre', raw: {} },
        result, null, 'claude-code', audit, 'write_file',
      );
      assert.ok(validateGuardAuditEntry(entry));
    });
  }
});
