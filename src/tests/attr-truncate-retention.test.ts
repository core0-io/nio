// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * `redactAndTruncate` must bound the MEMORY of a span attribute, not
 * just its printed length.
 *
 * `s.slice(0, maxBytes)` is answered by V8 with a SlicedString — a view
 * that keeps the entire parent alive. So the function capped the value
 * at 2048 chars while still pinning every byte of the payload it was
 * handed, and the strings it pinned were Nio's own `JSON.stringify`
 * intermediates, collectable the instant it returned. Nowhere does that
 * cost more than `deferred_spans`, which parks one closed tool span —
 * arguments AND result — per call for the whole turn: measured on the
 * real opencode binding with 20 KB payloads, 5000 parked spans held
 * 204 MB (~41 KB/span) rather than the ~740 B/span a cap was once judged
 * unnecessary against.
 *
 * ── Why these cases are not vacuous ───────────────────────────────────
 *
 * The retention case is the only one that can see the bug at all: the
 * returned string is character-identical either way, so nothing about
 * its value, length or content discriminates. It has to be measured, and
 * measured with a forced GC — hence a child process with `--expose-gc`,
 * rather than weakening the main test harness. The threshold sits ~2.5x
 * under the unflattened measurement and ~4x over the flattened one, so
 * neither outcome is a near miss.
 *
 * The identity cases exist because the obvious flattening (a utf8
 * round-trip) is NOT identity: truncating at a fixed number of UTF-16
 * code units can split a surrogate pair, and utf8 rewrites the resulting
 * lone surrogate as U+FFFD. They fail the moment the copy stops being
 * exact.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { redactAndTruncate } from '../scripts/lib/traces-collector.js';

/** Distinct payloads truncated in the child, and their size. */
const SAMPLES = 2000;
const PAYLOAD_CHARS = 50_000;
/**
 * Bytes retained per truncated output, above which the copy is not
 * happening. Unflattened measures ~50 000 (i.e. the whole parent);
 * flattened ~4 200 (the output itself).
 */
const MAX_BYTES_PER_OUTPUT = 20_000;

describe('redactAndTruncate bounds retained memory, not just printed length', () => {
  it('does not pin the payload it truncated', () => {
    const modulePath = fileURLToPath(
      new URL('../scripts/lib/traces-collector.js', import.meta.url),
    );
    const script = `
      const { redactAndTruncate } = await import(${JSON.stringify(modulePath)});
      global.gc(); global.gc();
      const before = process.memoryUsage().heapUsed;
      const kept = [];
      for (let i = 0; i < ${SAMPLES}; i++) {
        // A DISTINCT large payload per iteration, dropped immediately
        // after: nothing but the truncated output can still reference it.
        kept.push(redactAndTruncate({ blob: String(i).padEnd(${PAYLOAD_CHARS}, 'q') }));
      }
      global.gc(); global.gc();
      const after = process.memoryUsage().heapUsed;
      if (kept.length !== ${SAMPLES}) throw new Error('sample count drifted');
      console.log(JSON.stringify({
        perOutput: Math.round((after - before) / ${SAMPLES}),
        outputChars: kept[0].length,
      }));
    `;
    const raw = execFileSync(
      process.execPath,
      ['--expose-gc', '--input-type=module', '-e', script],
      { encoding: 'utf-8' },
    );
    const { perOutput, outputChars } = JSON.parse(raw.trim()) as {
      perOutput: number; outputChars: number;
    };

    assert.ok(
      outputChars < 3000,
      `sanity: the output really was truncated (got ${outputChars} chars)`,
    );
    assert.ok(
      perOutput < MAX_BYTES_PER_OUTPUT,
      `a ${outputChars}-char truncated attribute retained ${perOutput} B — it is holding the ` +
        `${PAYLOAD_CHARS}-char payload it truncated alive through a V8 SlicedString, so the ` +
        '2048-char cap bounds what gets printed and nothing about what gets kept',
    );
  });

  it('truncates to exactly the same characters as a plain slice', () => {
    const cases: Array<[string, string]> = [
      ['ascii', 'x'.repeat(3000)],
      ['multi-byte', 'é'.repeat(3000)],
      // The astral character straddles the 2048 boundary, so the cut
      // lands between its high and low surrogate.
      ['split surrogate pair', 'x'.repeat(2047) + '\u{1F600}' + 'y'.repeat(500)],
      ['lone surrogate', '\uD800' + 'z'.repeat(3000)],
    ];
    for (const [label, input] of cases) {
      assert.equal(
        redactAndTruncate(input, 2048),
        input.slice(0, 2048) + '…[truncated]',
        `${label}: flattening the truncated head must be a copy, not a re-encoding — a utf8 ` +
          'round-trip turns a split surrogate into U+FFFD and silently corrupts the attribute',
      );
    }
  });
});
