// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression test for the shutdown-timeout backstop on scanner-hook.ts's
 * exit path (`SHUTDOWN_BACKSTOP_MS`, next to the `_loggerProvider`
 * shutdown block in scanner-hook.ts).
 *
 * Before this fix: once the monitor gate (isSessionMonitored) was added
 * to scanner-hook.ts, exiting from an armed session required draining the
 * OTEL logs pipeline with `forceFlush()` + `shutdown()` instead of a bare
 * `process.exit(0)` — the log record processor's `forceFlush()` does not
 * await the in-flight HTTP POST, so exiting immediately after it can tear
 * the process down mid-request. `shutdown()` fixes that, but it has no
 * timeout of its own and `collector.timeout` does NOT bound it end to
 * end: that config only governs the request timeout once a TCP
 * connection exists, not the connect() call itself. Pointed at an
 * endpoint that silently drops every packet (firewalled, unroutable,
 * VPN torn down), connect() blocks until the OS-level TCP connect
 * timeout — about 75s on macOS, 100s+ on Linux — which blows straight
 * through the 30s hook-timeout budget `hooks.json` gives scanner-hook,
 * so every session start on such a network would burn the full 30s
 * before the host force-kills the hook (and the audit entry still never
 * ships). This test pins the fix: a `Promise.race` between the
 * flush+shutdown and a bounded backstop timer.
 *
 * The test arms a session before spawning the hook — an unarmed session
 * short-circuits before the exporter is ever constructed (the very gate
 * this branch added), which would make this test pass without touching
 * the code path it's meant to guard.
 *
 * Environment caveat: this test's discriminating power depends on
 * connect() to an RFC 5737 TEST-NET-1 address (192.0.2.1, reserved for
 * documentation and guaranteed unroutable on the public Internet)
 * actually blocking rather than failing fast. On a host/network where
 * that connect() is rejected immediately — some container-network
 * setups emit an immediate ICMP unreachable, or a transparent proxy
 * intercepts all outbound traffic and RSTs it — the connect() returns
 * quickly with or without the timeout backstop in place, and this test
 * will pass without having exercised the fix at all. That's a loss of
 * discriminating power on such hosts, not a false positive: it never
 * fails for a change that's actually correct. See the final-fix report
 * for this branch for confirmation that the failure mode reproduces (and
 * the fix's absence turns this test red) on the author's machine.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { trackTempDir } from './helpers/tmp-dirs.js';

// Bundled by bun into plugins/claude-code/skills/nio/scripts/, not
// dist/scripts/ — same resolution as monitor-scanner-hook.test.ts.
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(
  HERE, '..', '..', 'plugins', 'claude-code', 'skills', 'nio', 'scripts', 'scanner-hook.js',
);

// RFC 5737 TEST-NET-1: reserved for documentation, guaranteed unroutable.
// Nothing will ever ACK/RST/ICMP-unreachable a connection attempt to it,
// so a well-behaved TCP stack blocks in connect() until its own
// OS-level timeout rather than failing fast — exactly the failure mode
// the shutdown backstop exists to bound.
const UNROUTABLE_ENDPOINT = 'http://192.0.2.1:4318';

// Generous upper bound for the whole hook run: SHUTDOWN_BACKSTOP_MS
// (5s, see scanner-hook.ts) plus skill-scan time and process startup,
// which together are well under a second for a single fixture skill.
// Blowing past this means the shutdown timeout backstop regressed.
const EXIT_BOUND_MS = 15000;

/**
 * A fake $HOME holding one installed skill for the hook to discover.
 * scanner-hook resolves its search roots through `os.homedir()`, which on
 * POSIX honours $HOME — so pointing the child's HOME here keeps the test
 * off the developer's real ~/.claude/skills. Mirrors
 * monitor-scanner-hook.test.ts's helper of the same shape.
 */
function fakeHomeWithSkill(skillName: string): string {
  const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-scanner-shutdown-home-')));
  const skillDir = join(home, '.claude', 'skills', skillName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    [
      '---',
      `name: ${skillName}`,
      'description: fixture skill for the scanner-hook shutdown-timeout test',
      '---',
      '',
      '# Fixture',
      '',
      'Nothing interesting here — this skill only needs to exist so the',
      'hook has something to scan and export.',
      '',
    ].join('\n'),
    'utf-8',
  );
  return home;
}

/** A fresh NIO_HOME whose config points telemetry at an unroutable endpoint. */
function nioHomeFor(endpoint: string): string {
  const home = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-scanner-shutdown-nio-')));
  writeFileSync(join(home, 'config.yaml'), `collector:\n  endpoint: "${endpoint}"\n`, 'utf-8');
  return home;
}

/** Arm a session in the store, mirroring what `monitor-cli on` persists. */
function armSession(nioHome: string, sessionId: string, cwd: string): void {
  writeFileSync(
    join(nioHome, 'monitored-sessions.json'),
    JSON.stringify({ sessions: { [sessionId]: { armed_at: Date.now(), cwd } } }),
    'utf-8',
  );
}

describe('scanner-hook shutdown timeout backstop', () => {
  it('exits within bound when the OTLP endpoint is unroutable', () => {
    const nioHome = nioHomeFor(UNROUTABLE_ENDPOINT);
    const home = fakeHomeWithSkill('fixture-skill');
    const sessionId = 'sess-scanner-unroutable';
    armSession(nioHome, sessionId, nioHome);

    const payload = JSON.stringify({
      hook_event_name: 'SessionStart',
      source: 'startup',
      session_id: sessionId,
      cwd: nioHome,
    });

    const start = Date.now();
    let elapsed = 0;
    try {
      // execFileSync (not spawn) is deliberate: the `timeout` option turns
      // a hang into a thrown error instead of a suite that never ends, and
      // there's no in-process sink here to deadlock against (unlike
      // monitor-scanner-hook.test.ts's tests against a real HTTP server).
      execFileSync('node', [CLI, '--platform', 'claude-code'], {
        input: payload,
        env: { ...process.env, NIO_HOME: nioHome, HOME: home },
        cwd: nioHome,
        timeout: EXIT_BOUND_MS,
      });
      elapsed = Date.now() - start;
    } catch (e) {
      elapsed = Date.now() - start;
      assert.fail(
        `scanner-hook did not exit within ${EXIT_BOUND_MS}ms against an unroutable ` +
        `endpoint (elapsed ${elapsed}ms) — the shutdown() timeout backstop appears to ` +
        `have regressed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    assert.ok(
      elapsed < EXIT_BOUND_MS,
      `expected scanner-hook to exit well under ${EXIT_BOUND_MS}ms, took ${elapsed}ms`,
    );
  });
});
