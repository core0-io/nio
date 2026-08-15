// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Where a diagnostic lands on disk.
 *
 * `reportDiagnostic` cannot import `common.ts` (cycle), so it re-derives
 * the default audit path inline. That copy has to agree with
 * `common.ts`'s `defaultAuditPath()` — a diagnostic written to a
 * different file than the audit entries around it is a diagnostic nobody
 * finds, and the local JSONL is the only post-hoc evidence there is.
 *
 * The case that used to diverge: a host launched without `HOME` in its
 * environment (launchd, a container entry point, a daemonised host).
 * `common.ts` resolves through `os.homedir()`, which falls back to the
 * passwd entry; the old inline copy fell back to the RELATIVE string
 * `.nio`, scattering diagnostics into whatever directory each session
 * started in.
 *
 * Deliberately assertion-only — nothing here writes to a real home.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { _resolveDiagnosticsAuditPathForTests } from '../adapters/diagnostics.js';

const savedHome = process.env.HOME;
const savedUserProfile = process.env.USERPROFILE;
const savedNioHome = process.env.NIO_HOME;

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  restore('HOME', savedHome);
  restore('USERPROFILE', savedUserProfile);
  restore('NIO_HOME', savedNioHome);
});

describe('diagnostics audit path', () => {
  it('honours NIO_HOME', () => {
    process.env.NIO_HOME = '/tmp/nio-home-under-test';
    assert.equal(
      _resolveDiagnosticsAuditPathForTests(),
      join('/tmp/nio-home-under-test', 'audit.jsonl'),
    );
  });

  it('is absolute even with no HOME in the environment', () => {
    delete process.env.NIO_HOME;
    delete process.env.HOME;
    delete process.env.USERPROFILE;

    const resolved = _resolveDiagnosticsAuditPathForTests();
    assert.ok(isAbsolute(resolved), `expected an absolute path, got ${resolved}`);
    assert.doesNotMatch(resolved, /^\.nio\//, 'never cwd-relative');
    // Same rule common.ts uses, so both legs land in one file.
    assert.equal(resolved, join(homedir(), '.nio', 'audit.jsonl'));
  });
});
