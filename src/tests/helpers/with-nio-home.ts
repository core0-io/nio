// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Point `NIO_HOME` at a fresh tmpdir for the duration of `fn`, optionally
 * seeding it with a `config.yaml`, then restore the previous `NIO_HOME`
 * and delete the tmpdir.
 *
 * Shared by config-loader.test.ts and monitor-config.test.ts, which each
 * used to carry their own near-identical copy of this fixture (`withNioHome`
 * / `withConfig`).
 *
 * Pass `null` for `yaml` to get an isolated home with no config.yaml at
 * all (the "no config file" case) instead of writing an empty one.
 *
 * NOTE on `process.env` mutation: this reaches into the process-global
 * `process.env.NIO_HOME` rather than passing an isolated handle, because
 * the production config loader (`config-loader.ts`'s `readRawConfig` /
 * `nioDir`) itself reads `process.env.NIO_HOME` directly — there is no
 * injectable seam to target instead. That makes this helper safe ONLY
 * under node:test's default serial-within-a-file execution; two
 * `withNioHome` calls racing concurrently (e.g. via `Promise.all` over
 * async `fn`s, or a future switch to parallel test execution) would
 * stomp each other's env var. The try/finally below exists specifically
 * so a thrown assertion inside `fn` still restores the prior value
 * instead of leaking a stale `NIO_HOME` into whatever test runs next in
 * the same file.
 */
export function withNioHome<T>(yaml: string | null, fn: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'nio-test-home-'));
  if (yaml !== null) writeFileSync(join(dir, 'config.yaml'), yaml, 'utf-8');
  const previous = process.env['NIO_HOME'];
  process.env['NIO_HOME'] = dir;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env['NIO_HOME'];
    else process.env['NIO_HOME'] = previous;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; nothing downstream depends on it succeeding.
    }
  }
}
