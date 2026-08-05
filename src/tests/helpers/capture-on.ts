// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Turn blanket telemetry capture ON for a test's NIO_HOME.
 *
 * Capture is off by default: `InProcessPluginRuntime` consults the
 * per-session monitor gate before it resolves any OTEL provider, so a
 * session nobody armed produces no spans, no metrics and no OTLP audit
 * records. That is the product behaviour, and the gate has its own
 * dedicated tests (`plugin-runtime-monitor.test.ts`,
 * `monitor-openclaw*.test.ts`).
 *
 * Tests that predate the gate assert something else entirely — span
 * shape, guard-attribute plumbing, sub-agent parenting — and inject an
 * in-memory provider to do it. Without capture on, those assertions
 * would all reduce to "nothing was emitted", which is a green test that
 * verifies nothing. Writing `collector.monitor_all_sessions: true` is
 * the real, documented way an operator says "capture everything without
 * arming each session", so it is also the honest way for such a test to
 * say "assume capture is on; now check the wiring".
 *
 * Do NOT use this in a test that pins the gate itself. Those arm (or
 * deliberately don't arm) their sessions inline, next to the assertion,
 * so the arming is visible.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** `collector.monitor_all_sessions: true`, as YAML. */
export const CAPTURE_ON_YAML = 'collector:\n  monitor_all_sessions: true\n';

/**
 * Write `home/config.yaml` with capture on, optionally appending the
 * caller's own YAML. Every current caller's extra YAML is rooted at a
 * different top-level key (`guard:`), so plain concatenation stays valid
 * — a caller that needs its own `collector:` section must merge it into
 * one block itself rather than passing a second `collector:` root.
 */
export function writeCaptureOnConfig(home: string, extraYaml?: string): void {
  writeFileSync(join(home, 'config.yaml'), CAPTURE_ON_YAML + (extraYaml ?? ''), 'utf-8');
}
