import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileUserRegex, compileUserRegexList } from '../core/shared/regex.js';

describe('compileUserRegex', () => {
  it('compiles plain pattern without flags', () => {
    const re = compileUserRegex('\\bfoo\\b');
    assert.equal(re.flags, '');
    assert.ok(re.test('bar foo baz'));
    assert.ok(!re.test('foobar'));
  });

  it('parses /pattern/flags literal syntax', () => {
    const re = compileUserRegex('/\\bfoo\\b/i');
    assert.equal(re.flags, 'i');
    assert.ok(re.test('bar FOO baz'), 'i flag should make match case-insensitive');
  });

  it('handles multiple flags', () => {
    const re = compileUserRegex('/foo/gi');
    assert.ok(re.flags.includes('g'));
    assert.ok(re.flags.includes('i'));
  });

  it('throws on invalid pattern', () => {
    assert.throws(() => compileUserRegex('(unclosed'));
  });

  it('throws on unsupported inline flag syntax', () => {
    // (?i)... is Perl/Python style — JS RegExp rejects it.
    assert.throws(() => compileUserRegex('(?i)foo'));
  });

  it('treats / without trailing flags section as plain pattern', () => {
    // Must be `/pattern/flags` — a bare `/foo` is not a literal.
    const re = compileUserRegex('/foo');
    assert.ok(re.test('/foo'));
  });
});

describe('compileUserRegexList', () => {
  it('compiles all valid patterns', () => {
    const out = compileUserRegexList(['foo', '/bar/i', '\\d+']);
    assert.equal(out.length, 3);
  });

  it('silently skips invalid patterns', () => {
    const out = compileUserRegexList(['(unclosed', '/valid/i', '(?i)bad']);
    assert.equal(out.length, 1, 'only the valid /valid/i should compile');
    assert.ok(out[0]!.test('VALID'));
  });

  it('returns empty array for all-invalid input', () => {
    const out = compileUserRegexList(['(', '(?i)foo']);
    assert.equal(out.length, 0);
  });
});
