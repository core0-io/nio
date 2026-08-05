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
 * The first call in a given test file registers a single `after()` hook
 * (via node:test) that sweeps every directory tracked by that file. Safe
 * to call from a helper invoked many times per test — directories
 * accumulate in a module-local list and are only rmSync'd at the very
 * end, so tests that depend on a directory staying alive across multiple
 * calls within the same run are unaffected.
 */

import { rmSync } from 'node:fs';
import { after } from 'node:test';

const created: string[] = [];
let registered = false;

export function trackTempDir<T extends string>(dir: T): T {
  created.push(dir);
  if (!registered) {
    registered = true;
    after(() => {
      for (const d of created) {
        try {
          rmSync(d, { recursive: true, force: true });
        } catch {
          // Best-effort: a test may have already removed or chmod'd it
          // in a way that makes cleanup irrelevant.
        }
      }
    });
  }
  return dir;
}
