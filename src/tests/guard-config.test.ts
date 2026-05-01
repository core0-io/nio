/**
 * Unit tests for top-level guard.* config fields that aren't covered
 * elsewhere:
 *   - protection_level       (strict / balanced / permissive threshold map)
 *   - allowed_commands       (Phase 1 allowlist bypass)
 *   - scoring_weights        (weighted phase aggregation)
 *
 * Intentionally NOT covered:
 *   - confirm_action         — pure adapter-level logic that maps 'confirm'
 *                              decision to allow/deny/ask. Lives inline in
 *                              src/scripts/guard-hook.ts and
 *                              src/adapters/openclaw-plugin.ts; not
 *                              unit-testable without refactoring an
 *                              extraction. Covered via manual adapter paths.
 *   - permitted_tools / blocked_tools / native_tool_mapping — already covered
 *                              in integration.test.ts (B2/B3) and
 *                              adapter.test.ts.
 *   - llm_analyser / external_analyser — config flags, covered implicitly
 *                              by orchestrator.test.ts phase toggles.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ActionOrchestrator } from '../core/action-orchestrator.js';
import {
  aggregateScores,
  DEFAULT_WEIGHTS,
} from '../core/scoring.js';
import {
  scoreToDecision,
  shouldShortCircuit,
} from '../core/action-decision.js';
import { makeExecEnvelope } from './helpers/envelope.js';

// ── protection_level ────────────────────────────────────────────────────
//
// Uses the threshold table in decision.ts:
//   strict      deny≥0.5                    (no confirm zone)
//   balanced    deny≥0.8  confirm≥0.5
//   permissive  deny≥0.9                    (no confirm zone)
//
// Borderline envelope: exec_command matching a user-added SYSTEM_COMMAND
// entry. SYSTEM_COMMAND has severity=high (0.75) and confidence=0.9, so
// findingsToScore → ~0.675. Only Phase 2 runs for exec_command, so the
// final score equals the runtime score.

describe('guard.protection_level', () => {
  const systemCmdEnv = makeExecEnvelope('mycorp-sysctl reboot');
  const rules = { system_commands: ['mycorp-sysctl'] };

  it('strict blocks a high-severity borderline action (score ~0.675 ≥ 0.5)', async () => {
    const analyser = new ActionOrchestrator({ level: 'strict', actionGuardRules: rules });
    const result = await analyser.evaluate(systemCmdEnv);
    assert.equal(result.decision, 'deny');
    assert.equal(result.phase_stopped, 2, 'should short-circuit at Phase 2 under strict');
  });

  it('balanced asks for confirmation on the same action (0.5 ≤ score < 0.8)', async () => {
    const analyser = new ActionOrchestrator({ level: 'balanced', actionGuardRules: rules });
    const result = await analyser.evaluate(systemCmdEnv);
    assert.equal(result.decision, 'confirm');
  });

  it('permissive allows the same action (score < 0.9)', async () => {
    const analyser = new ActionOrchestrator({ level: 'permissive', actionGuardRules: rules });
    const result = await analyser.evaluate(systemCmdEnv);
    assert.equal(result.decision, 'allow');
  });

  it('scoreToDecision is consistent with the threshold table', () => {
    assert.equal(scoreToDecision(0.4, 'strict'), 'allow');
    assert.equal(scoreToDecision(0.5, 'strict'), 'deny');
    assert.equal(scoreToDecision(0.5, 'balanced'), 'confirm');
    assert.equal(scoreToDecision(0.8, 'balanced'), 'deny');
    assert.equal(scoreToDecision(0.85, 'permissive'), 'allow');
    assert.equal(scoreToDecision(0.9, 'permissive'), 'deny');
  });

  it('shouldShortCircuit uses the current level deny threshold', () => {
    assert.equal(shouldShortCircuit(0.6, 'strict'), true);
    assert.equal(shouldShortCircuit(0.6, 'balanced'), false);
    assert.equal(shouldShortCircuit(0.6, 'permissive'), false);
  });
});

// ── allowed_commands ────────────────────────────────────────────────────
//
// Phase 1 allowlist: exact-match OR prefix-match (command starts with
// "prefix "). Shell metacharacters disqualify. Matching short-circuits
// the pipeline at Phase 1.

describe('guard.allowed_commands', () => {
  // These tests pin allowlist_mode: 'exit' to verify the allowed_commands
  // feature interacts correctly with the short-circuit path. See the
  // `guard.allowlist_mode` describe block below for the default behavior.
  it('allows a user-listed prefix and exits at Phase 1 (exit mode)', async () => {
    const analyser = new ActionOrchestrator({
      allowedCommands: ['mycorp-safe-tool'],
      allowlistMode: 'exit',
    });
    const result = await analyser.evaluate(makeExecEnvelope('mycorp-safe-tool do thing'));
    assert.equal(result.decision, 'allow');
    assert.equal(result.phase_stopped, 1, 'should exit at Phase 1 under exit mode');
    assert.equal(result.findings.length, 0);
  });

  it('allows an exact command match', async () => {
    const analyser = new ActionOrchestrator({
      allowedCommands: ['mycorp-exact'],
      allowlistMode: 'exit',
    });
    const result = await analyser.evaluate(makeExecEnvelope('mycorp-exact'));
    assert.equal(result.decision, 'allow');
    assert.equal(result.phase_stopped, 1);
  });

  it('does NOT apply when shell metacharacters are present (safety guard)', async () => {
    const analyser = new ActionOrchestrator({
      allowedCommands: ['mycorp-safe-tool'],
      allowlistMode: 'exit',
    });
    // Pipe disqualifies from allowlist → continues into Phase 2+
    const result = await analyser.evaluate(
      makeExecEnvelope('mycorp-safe-tool do thing | cat'),
    );
    assert.notEqual(result.phase_stopped, 1,
      'shell metachar should prevent Phase 1 bypass');
  });

  it('does not exit when prefix does not match', async () => {
    const analyser = new ActionOrchestrator({
      allowedCommands: ['mycorp-safe-tool'],
      allowlistMode: 'exit',
    });
    const result = await analyser.evaluate(makeExecEnvelope('unrelated-cmd'));
    assert.notEqual(result.phase_stopped, 1);
  });
});

// ── allowlist_mode ──────────────────────────────────────────────────────
//
// Controls Phase 1 behavior on match:
//   continue (default) — treat as hint, still run Phase 2-6 so external/LLM
//                        policy is not bypassed
//   exit               — allow + exit immediately (fast path)

describe('guard.allowlist_mode', () => {
  it('defaults to continue — allowlist match falls through to Phase 2+', async () => {
    const analyser = new ActionOrchestrator({
      allowedCommands: ['mycorp-safe-tool'],
    });
    const result = await analyser.evaluate(makeExecEnvelope('mycorp-safe-tool do thing'));
    assert.notEqual(result.phase_stopped, 1,
      'default (continue) should not exit at Phase 1');
    assert.equal(result.decision, 'allow',
      'benign command still allowed when no later phase flags it');
  });

  it('exit — allowlist match exits at Phase 1', async () => {
    const analyser = new ActionOrchestrator({
      allowedCommands: ['mycorp-safe-tool'],
      allowlistMode: 'exit',
    });
    const result = await analyser.evaluate(makeExecEnvelope('mycorp-safe-tool do thing'));
    assert.equal(result.phase_stopped, 1);
    assert.equal(result.decision, 'allow');
  });

  it('continue (default) — lets Phase 2 deny a dangerous allowlisted command', async () => {
    // SAFE prefix "ls" + dangerous_patterns match → exit mode would skip
    // Phase 2 and miss the deny. continue mode preserves it.
    const analyser = new ActionOrchestrator({
      actionGuardRules: { dangerous_patterns: ['/ls\\s+--secrets/'] },
    });
    const result = await analyser.evaluate(makeExecEnvelope('ls --secrets'));
    assert.equal(result.decision, 'deny',
      'dangerous_pattern should fire despite Phase 1 match');
    assert.notEqual(result.phase_stopped, 1);
  });

  it('exit — Phase 2 is bypassed for the same dangerous input', async () => {
    const analyser = new ActionOrchestrator({
      allowlistMode: 'exit',
      actionGuardRules: { dangerous_patterns: ['/ls\\s+--secrets/'] },
    });
    const result = await analyser.evaluate(makeExecEnvelope('ls --secrets'));
    assert.equal(result.decision, 'allow',
      'exit mode allows the command despite the dangerous_pattern');
    assert.equal(result.phase_stopped, 1);
  });
});

// ── scoring_weights ─────────────────────────────────────────────────────
//
// final_score = Σ(wi × si) / Σ(wi), only phases that ran. Custom weights
// let users bias the final score toward specific phases.

describe('guard.scoring_weights', () => {
  it('defaults match the documented DEFAULT_WEIGHTS table', () => {
    assert.deepEqual(DEFAULT_WEIGHTS, {
      runtime: 1.0,
      static: 1.0,
      behavioural: 2.0,
      llm: 1.0,
      external: 2.0,
    });
  });

  it('equal weights → plain average of phase scores', () => {
    const score = aggregateScores(
      { runtime: 0.5, static: 1.0 },
      { runtime: 1, static: 1, behavioural: 1, llm: 1, external: 1 },
    );
    assert.equal(score, 0.75);
  });

  it('high runtime weight biases final score toward Phase 2', () => {
    const score = aggregateScores(
      { runtime: 0.5, static: 1.0 },
      { runtime: 10, static: 1, behavioural: 1, llm: 1, external: 1 },
    );
    // (0.5 × 10 + 1.0 × 1) / (10 + 1) = 6/11 ≈ 0.545
    assert.ok(Math.abs(score - 0.5454545454545454) < 1e-9);
  });

  it('weights only apply to phases that actually ran', () => {
    // Only runtime produced a score; other weights do not pollute the denominator
    const score = aggregateScores(
      { runtime: 0.8 },
      { runtime: 1, static: 1, behavioural: 5, llm: 1, external: 1 },
    );
    assert.equal(score, 0.8);
  });

  it('zero scores aggregate to zero', () => {
    const score = aggregateScores(
      { runtime: 0, static: 0 },
      DEFAULT_WEIGHTS,
    );
    assert.equal(score, 0);
  });

  it('empty scores → 0', () => {
    const score = aggregateScores({}, DEFAULT_WEIGHTS);
    assert.equal(score, 0);
  });
});
