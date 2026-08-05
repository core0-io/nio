// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Track a directory created via `mkdtempSync` so it gets removed once the
 * importing test file finishes, instead of leaking into the OS tmpdir on
 * every `pnpm test` run forever.
 *
 * Usage: wrap every `mkdtempSync(...)` call site with `trackTempDir(...)`:
 *
 *   const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-foo-')));
 *
 * The `after()` hook below is registered at MODULE LOAD TIME — i.e. when
 * a test file `import`s this module, not lazily on first `trackTempDir`
 * call. That is not a style choice: node:test's top-level `after()`
 * attaches to whatever suite/test is "current" at the moment it runs.
 * Registering it eagerly, before any test body executes, attaches it to
 * the whole file's implicit root suite, so it fires once at the very
 * end. Registering it lazily from inside a running test attaches it to
 * *that individual test* instead — confirmed by hand: it fires right
 * after the first test that calls it, before any later test in the same
 * file runs, so only that first test's directory ever gets cleaned up.
 * Do not move this call inside a function.
 */

import { rmSync } from 'node:fs';
import { after } from 'node:test';

const created: string[] = [];

after(() => {
  for (const d of created) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // Best-effort: a test may have already removed or chmod'd it in a
      // way that makes cleanup irrelevant.
    }
  }
});

export function trackTempDir<T extends string>(dir: T): T {
  created.push(dir);
  return dir;
}
