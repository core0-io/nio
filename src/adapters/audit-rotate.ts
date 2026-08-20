// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Audit-log rotation, shared by the two writers that append to the file.
 *
 * `writeAuditLog()` (common.ts) writes agent events; `reportDiagnostic()`
 * (diagnostics.ts) writes collector/config diagnostics. They append to the
 * SAME path, so rotation has to mean the same thing to both — the smaller
 * ceiling would otherwise win and silently override the configured one.
 *
 * This module exists so neither has to import the other: common.ts already
 * depends on diagnostics.ts, and the reverse edge would be a cycle.
 *
 * Rotation keeps exactly ONE previous generation: `path` is renamed to
 * `path.1`, overwriting whatever was there. That is deliberately cheap,
 * and it is the reason floods are dangerous — a writer that fills the
 * live file twice over erases all history. Flood control on the
 * diagnostics leg exists to keep that from happening.
 */

import { renameSync, statSync } from 'node:fs';

/** Ceiling applied when nothing has configured `collector.logs.max_size_mb`. */
export const DEFAULT_MAX_AUDIT_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Roll `auditPath` over to `auditPath + '.1'` if it has reached the
 * ceiling. Best-effort: a missing file is the normal first-run case, and
 * any IO error here must never break the write that follows.
 */
export function rotateIfNeeded(auditPath: string, maxSizeMb?: number): void {
  const maxBytes = (maxSizeMb && maxSizeMb > 0)
    ? maxSizeMb * 1024 * 1024
    : DEFAULT_MAX_AUDIT_BYTES;
  try {
    const stats = statSync(auditPath);
    if (stats.size >= maxBytes) {
      renameSync(auditPath, auditPath + '.1');
    }
  } catch {
    // File may not exist yet — that's fine
  }
}
