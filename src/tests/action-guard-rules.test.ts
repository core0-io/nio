/**
 * Unit tests for guard.action_guard_rules user-supplied extension fields.
 *
 * These tests exercise the user-extension path of each field in
 * src/core/analysers/runtime/denylist.ts. Built-in detection is covered
 * elsewhere (integration.test.ts, runtime-analyser.test.ts); here we
 * verify that config-supplied entries flow through and match as documented
 * in plugins/shared/config.default.yaml.
 *
 * Fields covered:
 *   - dangerous_commands        (case-insensitive substring)
 *   - dangerous_patterns        — already covered in runtime-analyser.test.ts
 *   - sensitive_commands        (case-insensitive substring)
 *   - system_commands           (word-boundary: start OR after space)
 *   - network_commands          (word-boundary: start OR after space)
 *   - webhook_domains           (exact host OR subdomain suffix)
 *   - sensitive_paths           (substring with /-prefix OR endsWith)
 *   - sensitive_path_patterns   (regex on normalized path)
 *   - secret_patterns           — already covered in runtime-analyser.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeAction } from '../core/analysers/runtime/denylist.js';
import type { GuardRulesConfig } from '../core/analysers/runtime/denylist.js';
import {
  makeExecEnvelope,
  makeNetworkEnvelope,
  makeWriteEnvelope,
} from './helpers/envelope.js';

function hasRule(findings: ReturnType<typeof analyzeAction>, ruleId: string): boolean {
  return findings.some((f) => f.rule_id === ruleId);
}

// ── dangerous_commands ──────────────────────────────────────────────────
describe('action_guard_rules.dangerous_commands', () => {
  const extra: GuardRulesConfig = { dangerous_commands: ['format c:', 'SHUTDOWN -h'] };

  it('matches a user-supplied literal (positive)', () => {
    const findings = analyzeAction(makeExecEnvelope('format c:'), extra);
    assert.ok(hasRule(findings, 'DANGEROUS_COMMAND'));
  });

  it('is case-insensitive against the command line', () => {
    const findings = analyzeAction(makeExecEnvelope('Shutdown -h now'), extra);
    assert.ok(hasRule(findings, 'DANGEROUS_COMMAND'));
  });

  it('does not match unrelated commands (negative)', () => {
    const findings = analyzeAction(makeExecEnvelope('echo hello'), extra);
    assert.ok(!hasRule(findings, 'DANGEROUS_COMMAND'));
  });
});

// ── sensitive_commands ──────────────────────────────────────────────────
describe('action_guard_rules.sensitive_commands', () => {
  const extra: GuardRulesConfig = { sensitive_commands: ['cat /vault/', 'gpg --decrypt'] };

  it('matches a user-supplied substring (positive)', () => {
    const findings = analyzeAction(makeExecEnvelope('cat /vault/db-master.key'), extra);
    assert.ok(hasRule(findings, 'SENSITIVE_DATA_ACCESS'));
  });

  it('is case-insensitive', () => {
    const findings = analyzeAction(makeExecEnvelope('GPG --DECRYPT secret.gpg'), extra);
    assert.ok(hasRule(findings, 'SENSITIVE_DATA_ACCESS'));
  });

  it('does not match unrelated commands (negative)', () => {
    const findings = analyzeAction(makeExecEnvelope('ls /tmp'), extra);
    assert.ok(!hasRule(findings, 'SENSITIVE_DATA_ACCESS'));
  });
});

// ── system_commands ─────────────────────────────────────────────────────
describe('action_guard_rules.system_commands', () => {
  const extra: GuardRulesConfig = { system_commands: ['apt-get', 'launchctl'] };

  it('matches when entry appears at the start of the command', () => {
    const findings = analyzeAction(makeExecEnvelope('apt-get install nginx'), extra);
    assert.ok(hasRule(findings, 'SYSTEM_COMMAND'));
  });

  it('matches when entry appears after a space (word boundary)', () => {
    const findings = analyzeAction(makeExecEnvelope('sudo apt-get update'), extra);
    assert.ok(hasRule(findings, 'SYSTEM_COMMAND'));
  });

  it('does not match when entry is embedded in a word (negative)', () => {
    // "launchctl" is in config; "foolaunchctl" is not a word-boundary match
    const findings = analyzeAction(makeExecEnvelope('echo foolaunchctl'), extra);
    assert.ok(!hasRule(findings, 'SYSTEM_COMMAND'));
  });

  it('does not match unrelated commands (negative)', () => {
    const findings = analyzeAction(makeExecEnvelope('echo hello'), extra);
    assert.ok(!hasRule(findings, 'SYSTEM_COMMAND'));
  });
});

// ── network_commands ────────────────────────────────────────────────────
describe('action_guard_rules.network_commands', () => {
  const extra: GuardRulesConfig = { network_commands: ['aria2c', 'httpie'] };

  it('matches when entry appears at the start', () => {
    const findings = analyzeAction(makeExecEnvelope('aria2c https://example.com/x'), extra);
    assert.ok(hasRule(findings, 'NETWORK_COMMAND'));
  });

  it('matches when entry appears after a space', () => {
    const findings = analyzeAction(makeExecEnvelope('timeout 5 httpie GET example.com'), extra);
    assert.ok(hasRule(findings, 'NETWORK_COMMAND'));
  });

  it('does not match when entry is embedded in a word (negative)', () => {
    const findings = analyzeAction(makeExecEnvelope('echo xaria2cy'), extra);
    assert.ok(!hasRule(findings, 'NETWORK_COMMAND'));
  });
});

// ── webhook_domains ─────────────────────────────────────────────────────
describe('action_guard_rules.webhook_domains', () => {
  const extra: GuardRulesConfig = { webhook_domains: ['evil.example.com'] };

  it('matches the exact hostname', () => {
    const findings = analyzeAction(
      makeNetworkEnvelope('https://evil.example.com/drop'),
      extra,
    );
    assert.ok(hasRule(findings, 'WEBHOOK_EXFIL'));
  });

  it('matches any subdomain of the entry', () => {
    const findings = analyzeAction(
      makeNetworkEnvelope('https://bucket.evil.example.com/drop'),
      extra,
    );
    assert.ok(hasRule(findings, 'WEBHOOK_EXFIL'));
  });

  it('does not match a sibling domain sharing a suffix (negative)', () => {
    // "notevil.example.com" is NOT a subdomain of "evil.example.com"
    const findings = analyzeAction(
      makeNetworkEnvelope('https://notevil.example.com/drop'),
      extra,
    );
    assert.ok(!hasRule(findings, 'WEBHOOK_EXFIL'));
  });

  it('does not match unrelated hosts (negative)', () => {
    const findings = analyzeAction(
      makeNetworkEnvelope('https://safe.example.org/hi'),
      extra,
    );
    assert.ok(!hasRule(findings, 'WEBHOOK_EXFIL'));
  });
});

// ── sensitive_paths ─────────────────────────────────────────────────────
describe('action_guard_rules.sensitive_paths', () => {
  it('matches a directory fragment anywhere in an absolute path', () => {
    // Matcher prepends "/" to the pattern and substring-checks; so "var/secrets/"
    // matches "/var/secrets/master.key" via the "/var/secrets/" fragment.
    const extra: GuardRulesConfig = { sensitive_paths: ['var/secrets/'] };
    const findings = analyzeAction(
      makeWriteEnvelope('/var/secrets/master.key'),
      extra,
    );
    assert.ok(hasRule(findings, 'SENSITIVE_PATH'));
  });

  it('does NOT match when pattern is written with a leading slash (common mistake)', () => {
    // "/var/secrets/" gets checked as "//var/secrets/" (double slash) via the
    // includes branch, and as an endsWith which almost never hits. Captured
    // here so the footgun is visible in tests.
    const extra: GuardRulesConfig = { sensitive_paths: ['/var/secrets/'] };
    const findings = analyzeAction(
      makeWriteEnvelope('/var/secrets/master.key'),
      extra,
    );
    assert.ok(!hasRule(findings, 'SENSITIVE_PATH'));
  });

  it('matches a ~/-prefix directory (expanded to /HOME/)', () => {
    const extra: GuardRulesConfig = { sensitive_paths: ['raw_files/'] };
    const findings = analyzeAction(
      makeWriteEnvelope('~/raw_files/tesla_summary.txt'),
      extra,
    );
    assert.ok(hasRule(findings, 'SENSITIVE_PATH'));
  });

  it('matches a filename suffix via endsWith', () => {
    const extra: GuardRulesConfig = { sensitive_paths: ['.env.prod'] };
    const findings = analyzeAction(
      makeWriteEnvelope('config/.env.prod'),
      extra,
    );
    assert.ok(hasRule(findings, 'SENSITIVE_PATH'));
  });

  it('does NOT match a pure relative path with the directory as prefix', () => {
    // This is the documented gap — substring matcher requires a leading /
    // to anchor a directory prefix. Captured here so any future fix to
    // isSensitivePath flips this test intentionally.
    const extra: GuardRulesConfig = { sensitive_paths: ['raw_files/'] };
    const findings = analyzeAction(
      makeWriteEnvelope('raw_files/foo.txt'),
      extra,
    );
    assert.ok(!hasRule(findings, 'SENSITIVE_PATH'));
  });

  it('does not match unrelated paths (negative)', () => {
    const extra: GuardRulesConfig = { sensitive_paths: ['var/secrets/'] };
    const findings = analyzeAction(
      makeWriteEnvelope('/tmp/notes.txt'),
      extra,
    );
    assert.ok(!hasRule(findings, 'SENSITIVE_PATH'));
  });
});

// ── sensitive_path_patterns (new regex field) ───────────────────────────
describe('action_guard_rules.sensitive_path_patterns', () => {
  it('matches a dynamic segment via /pattern/flags regex', () => {
    const extra: GuardRulesConfig = {
      sensitive_path_patterns: ['/^\\/abc\\/[^/]+\\/fff/'],
    };
    const findings = analyzeAction(
      makeWriteEnvelope('/abc/tenant-42/fff'),
      extra,
    );
    assert.ok(hasRule(findings, 'SENSITIVE_PATH'));
  });

  it('matches relative-path-at-start that sensitive_paths cannot (positive)', () => {
    const extra: GuardRulesConfig = {
      sensitive_path_patterns: ['/^raw_files\\//'],
    };
    const findings = analyzeAction(
      makeWriteEnvelope('raw_files/foo.txt'),
      extra,
    );
    assert.ok(hasRule(findings, 'SENSITIVE_PATH'));
  });

  it('supports bare regex (no /.../flags delimiter)', () => {
    const extra: GuardRulesConfig = {
      sensitive_path_patterns: ['^raw_files/'],
    };
    const findings = analyzeAction(
      makeWriteEnvelope('raw_files/foo.txt'),
      extra,
    );
    assert.ok(hasRule(findings, 'SENSITIVE_PATH'));
  });

  it('respects regex flags (case-insensitive match)', () => {
    const extra: GuardRulesConfig = {
      sensitive_path_patterns: ['/\\.env\\.[a-z]+$/i'],
    };
    const findings = analyzeAction(
      makeWriteEnvelope('/app/.ENV.PROD'),
      extra,
    );
    assert.ok(hasRule(findings, 'SENSITIVE_PATH'));
  });

  it('silently skips invalid regex without throwing', () => {
    const extra: GuardRulesConfig = {
      sensitive_path_patterns: ['(unclosed', '/^raw_files\\//'],
    };
    const findings = analyzeAction(
      makeWriteEnvelope('raw_files/foo.txt'),
      extra,
    );
    assert.ok(hasRule(findings, 'SENSITIVE_PATH'),
      'valid pattern should still match even when a sibling pattern is invalid');
  });

  it('does not match unrelated paths (negative)', () => {
    const extra: GuardRulesConfig = {
      sensitive_path_patterns: ['/^\\/abc\\/[^/]+\\/fff/'],
    };
    const findings = analyzeAction(
      makeWriteEnvelope('/xyz/tenant-42/data.json'),
      extra,
    );
    assert.ok(!hasRule(findings, 'SENSITIVE_PATH'));
  });
});
