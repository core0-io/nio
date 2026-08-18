// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `lib/flush-budget.ts`.
 *
 * Review finding I3: this module had ZERO unit tests. The two spawn-based
 * suites that exercise it (`collector-flush-timeout`,
 * `guard-hook-flush-timeout`) both run against fixtures that leave
 * `collector.timeout` at its 5000 default — which is *exactly*
 * `FLUSH_BACKSTOP_MS`. With the two operands equal, `Math.min` and
 * `Math.max` are indistinguishable and the backstop constant is inert:
 *
 *   b10: `Math.min(...)` → `Math.max(...)`     SURVIVED (whole suite green)
 *   b11: `FLUSH_BACKSTOP_MS = 5000` → `60000`  SURVIVED (whole suite green)
 *
 * Under b10 a user who sets `collector.timeout: 30000` — a perfectly
 * reasonable thing to do, it is a *request* timeout — gets a 30-second
 * agent freeze on every hook, which is the precise failure this module
 * exists to prevent. The implementation is correct; only the coverage was
 * missing.
 *
 * The clamp tests below therefore use configured/backstop pairs that are
 * DELIBERATELY UNEQUAL and small, so the direction of the clamp is
 * observable in milliseconds rather than in seconds. The constant itself
 * is pinned with node:test's mock timers, so asserting the real 5000 ms
 * deadline costs no wall-clock time.
 *
 * A companion end-to-end case lives in `collector-flush-timeout.test.ts`
 * ("a large collector.timeout does NOT lengthen the freeze — the backstop
 * still wins"), which spawns the real bundle with
 * `collector.timeout: 30000`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFlushBudget, FLUSH_BACKSTOP_MS } from '../scripts/lib/flush-budget.js';

/** A promise that never settles — stands in for a stuck OTLP export. */
function never<T>(): Promise<T> {
  return new Promise<T>(() => { /* deliberately never resolves */ });
}

async function elapsedOf(fn: () => Promise<unknown>): Promise<number> {
  const start = Date.now();
  await fn();
  return Date.now() - start;
}

describe('createFlushBudget: collector.timeout can only SHORTEN the budget', () => {
  it('a configured timeout LARGER than the backstop is clamped down to the backstop', async () => {
    // min(1000, 100) = 100ms. Under `Math.max` this would be 1000ms.
    const budget = createFlushBudget(1000, 100);
    let result: string | undefined;
    const elapsed = await elapsedOf(async () => {
      result = await budget(never<string>(), 'timed-out');
    });
    assert.equal(result, 'timed-out');
    assert.ok(
      elapsed < 500,
      `a configured timeout of 1000ms must be clamped to the 100ms backstop, but the ` +
      `budget took ${elapsed}ms — collector.timeout is making the agent freeze LONGER, ` +
      `which is exactly what flush-budget exists to prevent`,
    );
  });

  it('a configured timeout SMALLER than the backstop wins', async () => {
    // min(40, 800) = 40ms. Under `Math.max` this would be 800ms.
    const budget = createFlushBudget(40, 800);
    let result: string | undefined;
    const elapsed = await elapsedOf(async () => {
      result = await budget(never<string>(), 'timed-out');
    });
    assert.equal(result, 'timed-out');
    assert.ok(
      elapsed < 400,
      `a user who lowers collector.timeout to 40ms is asking for a snappier hook, but ` +
      `the budget took ${elapsed}ms`,
    );
  });

  it('no configured timeout falls back to the backstop', async () => {
    const budget = createFlushBudget(undefined, 80);
    const elapsed = await elapsedOf(async () => {
      assert.equal(await budget(never<string>(), 'timed-out'), 'timed-out');
    });
    assert.ok(elapsed < 400, `expected the 80ms backstop to apply, took ${elapsed}ms`);
  });
});

/**
 * Spelled out as a LITERAL rather than as `FLUSH_BACKSTOP_MS`. Asserting
 * the constant against itself is mutation-invariant — b11 (5000 → 60000)
 * sails straight through a self-referential test. The whole point of the
 * suite below is that the number is a published contract (the module doc,
 * COLLECTOR-SIGNALS.md, and the 20s bound the spawn suites are sized
 * against all quote it), so it is written out here independently.
 */
const EXPECTED_BACKSTOP_MS = 5000;

describe('createFlushBudget: the default backstop is 5s', () => {
  it('a budget opened with no arguments fires at exactly 5s, not sooner and not later', async (t) => {
    // Mock timers so the real 5s deadline is asserted without waiting 5s.
    // `Date` is mocked too because createFlushBudget derives its deadline
    // from `Date.now()`, not from the timer alone.
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });

    const budget = createFlushBudget();          // no args at all: the production shape
    let settled: string | null = null;
    void budget(never<string>(), 'timed-out').then((v) => { settled = v; });

    t.mock.timers.tick(EXPECTED_BACKSTOP_MS - 1);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(
      settled, null,
      `the budget resolved before ${EXPECTED_BACKSTOP_MS}ms — the backstop got shorter than ` +
      'the documented ceiling, so healthy-but-slow exporters start losing spans',
    );

    t.mock.timers.tick(2);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(
      settled, 'timed-out',
      `the budget had still not fired at ${EXPECTED_BACKSTOP_MS + 1}ms — raising the backstop ` +
      'lengthens every hook freeze on every fork-per-event platform',
    );
  });

  it('FLUSH_BACKSTOP_MS is the 5s ceiling the rest of the codebase is sized against', () => {
    assert.equal(FLUSH_BACKSTOP_MS, EXPECTED_BACKSTOP_MS);
  });
});

describe('createFlushBudget: one deadline SHARED by every await on the hook run', () => {
  it('a second bounded await gets the REMAINING budget, not a fresh one', async () => {
    const budget = createFlushBudget(undefined, 150);
    const elapsed = await elapsedOf(async () => {
      assert.equal(await budget(never<string>(), 'first'), 'first');
      assert.equal(await budget(never<string>(), 'second'), 'second');
      assert.equal(await budget(never<string>(), 'third'), 'third');
    });
    assert.ok(
      elapsed < 500,
      `three sequential bounded awaits took ${elapsed}ms — a per-call timer instead of a ` +
      'shared deadline turns an N-await hook path into an N x budget ceiling',
    );
  });

  it('an already-expired budget resolves onTimeout without waiting at all', async () => {
    const budget = createFlushBudget(0, 0);
    const elapsed = await elapsedOf(async () => {
      assert.equal(await budget(never<string>(), 'expired'), 'expired');
    });
    assert.ok(elapsed < 200, `an expired budget must not block, took ${elapsed}ms`);
  });
});

describe('createFlushBudget: the budget never damages a flush that completes in time', () => {
  it('resolves with the real value when the bounded promise wins the race', async () => {
    const budget = createFlushBudget(undefined, 5000);
    const value = await budget(Promise.resolve('flushed'), 'timed-out');
    assert.equal(value, 'flushed', 'a fast export must return its own value, not the fallback');
  });

  it('a rejection propagates rather than being swallowed as a timeout', async () => {
    const budget = createFlushBudget(undefined, 5000);
    await assert.rejects(
      () => budget(Promise.reject(new Error('exporter blew up')), 'timed-out'),
      /exporter blew up/,
      'the budget races the promise; it does not catch it — callers keep their own error handling',
    );
  });
});
