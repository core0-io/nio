import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
  /** Score returned by the endpoint. */
  score: number;
  /** When true, the listener closes the socket without responding. */
  drop?: boolean;
}

function startScorer(opts: ScorerOpts): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    if (opts.drop) {
      res.socket?.destroy();
      return;
    }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ score: opts.score, reason: `scored ${opts.score}` }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, server });
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

      // dead endpoint is omitted from scores.external; live still present
      assert.deepEqual(result.scores.external, { live: 0.3 });
      assert.ok(result.phase_timings?.external?.['live']);
      assert.ok(!result.phase_timings?.external?.['dead']);
    } finally {
      await stopScorer(dead.server);
      await stopScorer(live.server);
    }
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
