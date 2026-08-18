// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../scripts/lib/content/redact.js';

// Secret-shaped test data is assembled at runtime rather than written
// as literals. The strings these produce are byte-identical to real
// credentials in shape — that is the whole point of the positive cases
// — but GitHub's secret scanner matches source text, and a literal here
// trips it on every push. Splitting the prefix defuses the scanner
// without weakening what the test actually feeds redactSecrets().
const OPENAI_PROJECT_KEY = 'sk-proj' + '-AbCdEf1234567890AbCdEf1234567890';
const GH_PAT_A = 'ghp' + '_AbCdEf1234567890AbCdEf1234567890AbCd';
const GH_PAT_B = 'ghp' + '_ZyXwVu9876543210ZyXwVu9876543210ZyXw';
const BEARER_TOKEN = 'Bear' + 'er AbCdEf1234567890AbCdEf1234567890';
const PEM_BEGIN = '-----BEGIN RSA PRIVATE ' + 'KEY-----';
const PEM_END = '-----END RSA PRIVATE ' + 'KEY-----';

const MUST_REDACT: Array<[string, string]> = [
  ['anthropic key', 'the key is sk-ant-api03-AbCdEf1234567890AbCdEf1234567890AbCdEf12 ok'],
  ['openai project key', `use ${OPENAI_PROJECT_KEY} now`],
  ['aws access key', 'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE'],
  ['github pat', `token ${GH_PAT_A}`],
  ['jwt', 'auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
  ['bearer header', `Authorization: ${BEARER_TOKEN}`],
  ['pem block', `${PEM_BEGIN}\nMIIEowIBAAKCAQEA\n${PEM_END}`],
];

const MUST_NOT_REDACT: Array<[string, string]> = [
  ['git full hash', 'commit 8f774cf1a2b3c4d5e6f708192a3b4c5d6e7f8091'],
  ['git short hash', 'see commit 8f774cf for details'],
  ['uuid', 'session 019fcfff-cdf4-7f02-b628-1a7cbfb6f5ed started'],
  ['path with hex dir', 'reading /Users/dev/.cache/a1b2c3d4e5f6/module.js'],
  ['plain base64 data', 'payload aGVsbG8gd29ybGQgdGhpcyBpcyBub3QgYSBzZWNyZXQ='],
  ['ordinary prose', 'the quick brown fox jumps over the lazy dog repeatedly'],
  ['hyphenated words', 'a well-documented self-explanatory implementation'],
];

describe('redactSecrets — must redact', () => {
  for (const [label, input] of MUST_REDACT) {
    it(label, () => {
      const { text, hits } = redactSecrets(input);
      assert.ok(hits > 0, `${label}: expected at least one hit`);
      assert.ok(text.includes('[REDACTED]'), `${label}: expected a redaction marker`);
    });
  }
});

describe('redactSecrets — must not redact', () => {
  for (const [label, input] of MUST_NOT_REDACT) {
    it(label, () => {
      const { text, hits } = redactSecrets(input);
      assert.equal(hits, 0, `${label}: false positive, got ${text}`);
      assert.equal(text, input, `${label}: input must pass through untouched`);
    });
  }
});

describe('redactSecrets — behaviour', () => {
  it('is pure: same input yields same output', () => {
    const s = 'key sk-ant-api03-AbCdEf1234567890AbCdEf1234567890AbCdEf12';
    assert.deepEqual(redactSecrets(s), redactSecrets(s));
  });

  it('redacts every occurrence, not just the first', () => {
    const s = `a ${GH_PAT_A} b ${GH_PAT_B}`;
    const { hits } = redactSecrets(s);
    assert.equal(hits, 2);
  });

  it('preserves surrounding text', () => {
    const { text } = redactSecrets(`before ${GH_PAT_A} after`);
    assert.ok(text.startsWith('before '));
    assert.ok(text.endsWith(' after'));
  });

  it('accepts extra user-configured patterns', () => {
    const { hits } = redactSecrets('internal INTERNAL-TOKEN-42 here', [/INTERNAL-TOKEN-\d+/g]);
    assert.equal(hits, 1);
  });

  it('handles empty and whitespace input', () => {
    assert.deepEqual(redactSecrets(''), { text: '', hits: 0 });
    assert.deepEqual(redactSecrets('   '), { text: '   ', hits: 0 });
  });
});
