// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression guard for C1 (span-layer review): the session-trace feature
 * (`startSessionTrace` / `emitSessionSpan`, see session-trace.test.ts)
 * only fires when SessionStart / SessionEnd actually reach
 * `dispatchCollectorEvent` — i.e. when the platform's `hooks.json` routes
 * those events to `collector-hook.js`.
 *
 * Before this fix, Claude Code's and Codex's SessionStart block only
 * listed `scanner-hook.js`. `session-trace.test.ts`'s five cases all
 * call `dispatchCollectorEvent` directly, so they were green despite the
 * real hook wiring never invoking the collector on session start — a
 * turn's root span would carry zero links on both platforms, and
 * SessionEnd (Claude Code) would never mint/clear a session trace at
 * all. This test reads the actual shipped `hooks.json` files (not a
 * fixture) and asserts collector-hook.js is present, so a future
 * regression that drops the entry fails here instead of hiding behind
 * the dispatch-level unit tests.
 *
 * Codex has no SessionEnd-equivalent hook event (see
 * `src/adapters/codex.ts`'s module doc and docs/COLLECTOR-SIGNALS.md) —
 * this test does NOT assert a Codex SessionEnd wiring because there is
 * nothing to wire it to.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

interface HookEntry {
  command: string;
}
interface HookBlock {
  matcher?: string;
  hooks: HookEntry[];
}
interface HooksFile {
  hooks: Record<string, HookBlock[]>;
}

function loadHooksJson(relPath: string): HooksFile {
  const raw = readFileSync(join(REPO_ROOT, relPath), 'utf-8');
  return JSON.parse(raw) as HooksFile;
}

/** Every hook command string registered under a given event name, across
 * all matcher blocks — order doesn't matter for these assertions. */
function commandsFor(file: HooksFile, event: string): string[] {
  const blocks = file.hooks[event] ?? [];
  return blocks.flatMap((b) => b.hooks.map((h) => h.command));
}

describe('hooks-wiring: SessionStart routes to collector-hook.js (C1 regression)', () => {
  it('Claude Code hooks.json registers collector-hook.js on SessionStart, alongside scanner-hook.js', () => {
    const file = loadHooksJson('plugins/claude-code/hooks/hooks.json');
    const commands = commandsFor(file, 'SessionStart');

    assert.ok(
      commands.some((c) => c.includes('collector-hook.js')),
      'Claude Code SessionStart must route to collector-hook.js — otherwise startSessionTrace ' +
      'never runs and no turn root ever carries a session link',
    );
    assert.ok(
      commands.some((c) => c.includes('scanner-hook.js')),
      'scanner-hook.js must still be wired — this test guards an addition, not a replacement',
    );
  });

  it('Claude Code hooks.json registers collector-hook.js on SessionEnd', () => {
    const file = loadHooksJson('plugins/claude-code/hooks/hooks.json');
    const commands = commandsFor(file, 'SessionEnd');

    assert.ok(
      commands.some((c) => c.includes('collector-hook.js')),
      'Claude Code SessionEnd must route to collector-hook.js — otherwise emitSessionSpan never runs ' +
      'and session_trace_id/session_span_id are never cleared from state',
    );
  });

  it('Codex hooks.json registers collector-hook.js on SessionStart, alongside scanner-hook.js', () => {
    const file = loadHooksJson('plugins/codex/hooks/hooks.json');
    const commands = commandsFor(file, 'SessionStart');

    assert.ok(
      commands.some((c) => c.includes('collector-hook.js')),
      'Codex SessionStart must route to collector-hook.js — otherwise startSessionTrace never runs ' +
      'on Codex either',
    );
    assert.ok(
      commands.some((c) => c.includes('scanner-hook.js')),
      'scanner-hook.js must still be wired — this test guards an addition, not a replacement',
    );
  });

  it('Codex hooks.json has no SessionEnd block — Codex has no SessionEnd-equivalent event', () => {
    const file = loadHooksJson('plugins/codex/hooks/hooks.json');
    assert.equal(
      file.hooks['SessionEnd'], undefined,
      'Codex genuinely has no SessionEnd hook event (see src/adapters/codex.ts); if this ever ' +
      'starts failing because Codex gained one, wire collector-hook.js to it and update this test ' +
      'and docs/COLLECTOR-SIGNALS.md together rather than leaving this assertion stale',
    );
  });
});
