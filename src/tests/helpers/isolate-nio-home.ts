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

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.NIO_HOME) {
  process.env.NIO_HOME = mkdtempSync(join(tmpdir(), 'nio-test-home-'));
}
