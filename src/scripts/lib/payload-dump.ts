// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Hook payload dump — debug-only sampling switch.
 *
 * We're mid-investigation into exactly what each platform's hook payload
 * carries (thinking/reasoning content, full transcript history, transcript
 * file paths, …) that Nio doesn't currently extract. Getting a sample used
 * to mean hand-editing platform config, writing a throwaway probe script,
 * then restoring the config afterward — easy to get wrong and leave a
 * user's real config broken. `NIO_DUMP_PAYLOAD=<dir>` turns that into
 * "set one variable, run the platform once".
 *
 * ── Design intent: independent of the collector monitor gate ──────────
 *
 * This is NOT gated behind `isSessionMonitored()` / `/nio-monitor`. That
 * gate exists to stop telemetry from leaving the machine before a user
 * has explicitly armed a session (see monitor-check.ts). This switch does
 * something categorically different: it writes files to a *local
 * directory the user themselves pointed at*, and never touches the
 * network. Setting `NIO_DUMP_PAYLOAD` is itself the explicit opt-in — a
 * user who exports it is unambiguously asking to sample right now, and
 * making them additionally arm a monitor session first would defeat the
 * entire point of a fast, ad hoc debug switch. If you're reading this
 * because you're about to wire the monitor gate in front of a
 * `dumpPayload()` call site: don't — that's not a gap, it's the design.
 *
 * ── Zero overhead when unset ────────────────────────────────────────
 *
 * Every call is a single `process.env` read guarding an early return; no
 * directory is touched and no work happens unless the variable is set.
 * This is a debug tool, not a product feature — it must never add
 * latency, IO, or failure surface to a hook's normal path.
 *
 * ── Fails silently, always ──────────────────────────────────────────
 *
 * A missing/unwritable directory, a full disk, or a payload that can't be
 * JSON-serialised (circular refs, BigInt) must never throw, never block,
 * and never slow down the hook it's sampling. Deliberately does NOT go
 * through `reportDiagnostic()` (adapters/diagnostics.ts) — that writes to
 * the *product* audit log, and a debug-sampling failure has no business
 * showing up there. Failures here are swallowed outright.
 *
 * ── Verbatim, unredacted ─────────────────────────────────────────────
 *
 * The whole point is to see the real shape of the data, so nothing here
 * sanitises, redacts, or truncates the payload. That also means dump
 * files can contain secrets (API keys, full conversation text, file
 * contents) — see the collector-signals doc for the handling warning
 * this ships with.
 */

import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const ENV_VAR = 'NIO_DUMP_PAYLOAD';

/** Keep filenames filesystem-safe without touching the readable content. */
function sanitizeSegment(value: string): string {
  const trimmed = (value ?? '').trim();
  const safe = trimmed.length > 0 ? trimmed : 'unknown';
  return safe.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/**
 * Dump a hook's raw payload to `$NIO_DUMP_PAYLOAD/<ts>-<platform>-<event>-<rand>.json`
 * when that environment variable is set; a no-op otherwise.
 *
 * The trailing random suffix guards against same-millisecond collisions —
 * e.g. Claude Code's PreToolUse fires both `guard-hook.ts` and
 * `collector-hook.ts` as separate processes, which can both call this
 * with the same platform/event in the same millisecond.
 *
 * Never throws. Never touches the network. Never gated by the collector
 * monitor state (see module doc above).
 */
export function dumpPayload(platform: string, event: string, payload: unknown): void {
  const dir = process.env[ENV_VAR];
  if (!dir) return;
  try {
    const filename =
      `${Date.now()}-${sanitizeSegment(platform)}-${sanitizeSegment(event)}` +
      `-${randomBytes(3).toString('hex')}.json`;
    writeFileSync(join(dir, filename), JSON.stringify(payload, null, 2), 'utf-8');
  } catch {
    // Debug-only sampling tool — a dump failure (missing directory, full
    // disk, no write permission, non-serialisable payload) must never
    // affect the hook it's observing. See module doc: silent by design.
  }
}
