// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Test bootstrap — pin NIO_HOME to a per-process tmpdir BEFORE any
 * production module that reads `process.env.NIO_HOME` gets imported.
 *
 * Loaded via `node --import` (see package.json's `test` script), so it
 * runs at the very top of every test file's process. Without this, any
 * test that ends up calling `evaluateHook` / `writeAuditLog` / scan-
 * cache / external-auth state-store without an explicit override
 * silently falls back to `~/.nio/audit.jsonl`, polluting the
 * developer's real audit log on every `pnpm test`.
 *
 * Subprocess-spawning tests (hook-cli.test.ts, nio-cli.test.ts) already
 * pass an isolated NIO_HOME via the spawned child's env — they're
 * unaffected because that env scope wins inside the child.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.NIO_HOME) {
  const home = mkdtempSync(join(tmpdir(), 'nio-test-home-'));
  process.env.NIO_HOME = home;
  // Remove it again on the way out. This module runs via `node --import`,
  // BEFORE node:test exists, so `after()` is not available here — but a
  // 'exit' listener is, and it is synchronous, which `rmSync` needs.
  //
  // Without this, every test FILE leaves one directory behind: 16 922 of
  // them had accumulated in $TMPDIR on the author's machine, the single
  // largest contributor to a 50 918-directory pile (review finding M2).
  // `trackTempDir` covers the directories tests create for themselves;
  // this covers the one the harness creates for them.
  process.on('exit', () => {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // Best-effort: a leftover directory is not worth failing a run over.
    }
  });
}
