// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for isNioSelfInvocation.
 *
 * Covers every branch of the whitelist regex: path-segment requirement,
 * script-name whitelist, metacharacter exclusion, empty-input handling.
 * Security-critical — false positives are bypasses, so each no-match
 * case below encodes a concrete attack or mistake we want to reject.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isNioSelfInvocation } from '../adapters/self-invocation.js';

const BASE = '/Users/ab/.claude/plugins/nio/skills/nio/scripts';

// ── Positive cases ──────────────────────────────────────────────────────

describe('isNioSelfInvocation: matches legitimate self-calls', () => {
  it('bare action-cli with no args', () => {
    assert.equal(isNioSelfInvocation(`node ${BASE}/action-cli.js`), true);
  });

  it('action-cli with typical skill args (single-quoted command)', () => {
    assert.equal(
      isNioSelfInvocation(
        `node ${BASE}/action-cli.js evaluate --type exec_command --command 'rm -rf /'`,
      ),
      true,
    );
  });

  it('action-cli with double-quoted command arg', () => {
    assert.equal(
      isNioSelfInvocation(
        `node ${BASE}/action-cli.js evaluate --type exec_command --command "rm -rf /"`,
      ),
      true,
    );
  });

  it('action-cli with decide subcommand', () => {
    assert.equal(
      isNioSelfInvocation(`node ${BASE}/action-cli.js decide --type exec_command --command "ls"`),
      true,
    );
  });

  it('allows each of the six whitelisted script names', () => {
    for (const name of [
      'action-cli',
      'hook-cli',
      'scanner-hook',
      'guard-hook',
      'config-cli',
      'collector-hook',
    ]) {
      assert.equal(
        isNioSelfInvocation(`node ${BASE}/${name}.js`),
        true,
        `expected ${name}.js to match`,
      );
    }
  });

  it('leading whitespace is tolerated', () => {
    assert.equal(isNioSelfInvocation(`  node ${BASE}/action-cli.js`), true);
  });

  it('trailing whitespace is tolerated', () => {
    assert.equal(isNioSelfInvocation(`node ${BASE}/action-cli.js  `), true);
  });

  it('alternative install roots (/tmp/..., ~/.openclaw/..., symlink-style)', () => {
    assert.equal(
      isNioSelfInvocation(
        `node /tmp/nio-test/skills/nio/scripts/action-cli.js decide --type exec_command --command "ls"`,
      ),
      true,
    );
    assert.equal(
      isNioSelfInvocation(
        `node /Users/ab/.openclaw/plugins/nio/skills/nio/scripts/action-cli.js evaluate --type read_file --path /etc/hosts`,
      ),
      true,
    );
  });
});

// ── Negative cases ──────────────────────────────────────────────────────

describe('isNioSelfInvocation: rejects non-self or unsafe inputs', () => {
  it('empty / nullish / whitespace-only command', () => {
    assert.equal(isNioSelfInvocation(undefined), false);
    assert.equal(isNioSelfInvocation(null), false);
    assert.equal(isNioSelfInvocation(''), false);
    assert.equal(isNioSelfInvocation('   '), false);
  });

  it('command without /skills/nio/scripts/ segment', () => {
    assert.equal(
      isNioSelfInvocation('node /other/path/action-cli.js'),
      false,
    );
    assert.equal(
      isNioSelfInvocation('node /Users/ab/skills/other/scripts/action-cli.js'),
      false,
    );
  });

  it('script name not in whitelist', () => {
    assert.equal(
      isNioSelfInvocation(`node ${BASE}/evil.js`),
      false,
    );
    assert.equal(
      isNioSelfInvocation(`node ${BASE}/index.js`),
      false,
    );
  });

  it('leading wrapper like bash -c', () => {
    assert.equal(
      isNioSelfInvocation(`bash -c 'node ${BASE}/action-cli.js'`),
      false,
    );
    assert.equal(
      isNioSelfInvocation(`sh -c "node ${BASE}/action-cli.js"`),
      false,
    );
    assert.equal(
      isNioSelfInvocation(`env NODE_OPTIONS=--no-warnings node ${BASE}/action-cli.js`),
      false,
    );
  });

  it('trailing && rm -rf / injection', () => {
    assert.equal(
      isNioSelfInvocation(`node ${BASE}/action-cli.js && rm -rf /`),
      false,
    );
  });

  it('semicolon injection via arg', () => {
    assert.equal(
      isNioSelfInvocation(`node ${BASE}/action-cli.js decide ; echo pwn`),
      false,
    );
  });

  it('pipe injection', () => {
    assert.equal(
      isNioSelfInvocation(`node ${BASE}/action-cli.js decide | cat /etc/passwd`),
      false,
    );
  });

  it('backtick command substitution', () => {
    assert.equal(
      isNioSelfInvocation(
        `node ${BASE}/action-cli.js decide --command \`echo pwn\``,
      ),
      false,
    );
  });

  it('dollar command substitution', () => {
    assert.equal(
      isNioSelfInvocation(`node ${BASE}/action-cli.js decide --command $(echo pwn)`),
      false,
    );
  });

  it('redirect operators', () => {
    assert.equal(
      isNioSelfInvocation(`node ${BASE}/action-cli.js decide > /tmp/out`),
      false,
    );
    assert.equal(
      isNioSelfInvocation(`node ${BASE}/action-cli.js decide < /etc/passwd`),
      false,
    );
  });

  it('unrelated node script', () => {
    assert.equal(
      isNioSelfInvocation('node /usr/local/lib/some-package/bin.js --port 8080'),
      false,
    );
  });

  it('npx or ts-node wrapper', () => {
    assert.equal(
      isNioSelfInvocation(`npx tsx ${BASE}/action-cli.js`),
      false,
    );
  });

  it('missing .js suffix', () => {
    assert.equal(
      isNioSelfInvocation(`node ${BASE}/action-cli`),
      false,
    );
  });

  it('path segment typo (skill/ not skills/)', () => {
    assert.equal(
      isNioSelfInvocation('node /path/skill/nio/scripts/action-cli.js'),
      false,
    );
  });
});
