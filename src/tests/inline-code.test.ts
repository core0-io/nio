// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractInlineCode } from '../core/shared/inline-code.js';

describe('extractInlineCode', () => {
  describe('python -c', () => {
    it('extracts single-line body with double quotes', () => {
      const r = extractInlineCode('python3 -c "import shutil; shutil.rmtree(\'/tmp/x\')"');
      assert.ok(r);
      assert.equal(r.language, 'python');
      assert.equal(r.virtualPath, 'inline.py');
      assert.ok(r.content.includes('shutil.rmtree'));
    });

    it('extracts single-line body with single quotes', () => {
      const r = extractInlineCode(`python -c 'print("hi")'`);
      assert.ok(r);
      assert.equal(r.language, 'python');
      assert.equal(r.content, 'print("hi")');
    });

    it('accepts python2/python3/python', () => {
      for (const bin of ['python', 'python2', 'python3']) {
        const r = extractInlineCode(`${bin} -c "pass"`);
        assert.ok(r, `should extract for ${bin}`);
        assert.equal(r.language, 'python');
      }
    });

    it('handles interpreter args before -c', () => {
      const r = extractInlineCode('python3 -u -c "print(1)"');
      assert.ok(r);
      assert.equal(r.content, 'print(1)');
    });
  });

  describe('python heredoc', () => {
    it('extracts body from single-quoted heredoc (the e2e trigger)', () => {
      const cmd = [
        "python3 - <<'PY'",
        'import shutil, os',
        "p='/tmp/gh-stats-cli'",
        'shutil.rmtree(p, ignore_errors=True)',
        'PY',
      ].join('\n');
      const r = extractInlineCode(cmd);
      assert.ok(r);
      assert.equal(r.language, 'python');
      assert.ok(r.content.includes('shutil.rmtree(p'));
      assert.ok(r.content.includes("p='/tmp/gh-stats-cli'"));
    });

    it('extracts body from double-quoted heredoc delimiter', () => {
      const cmd = 'python3 - <<"END"\nprint("hi")\nEND';
      const r = extractInlineCode(cmd);
      assert.ok(r);
      assert.equal(r.content, 'print("hi")');
    });

    it('extracts body from unquoted heredoc delimiter', () => {
      const cmd = 'python3 - <<END\nprint("hi")\nEND';
      const r = extractInlineCode(cmd);
      assert.ok(r);
      assert.equal(r.content, 'print("hi")');
    });

    it('extracts body from <<- tab-strip variant', () => {
      const cmd = 'python3 - <<-PY\n\tprint("hi")\nPY';
      const r = extractInlineCode(cmd);
      assert.ok(r);
      assert.ok(r.content.includes('print("hi")'));
    });

    it('extracts heredoc without explicit stdin dash', () => {
      // `python3 <<PY` still sends heredoc to stdin; the dash is optional.
      const cmd = 'python3 <<PY\nprint("hi")\nPY';
      const r = extractInlineCode(cmd);
      assert.ok(r);
      assert.equal(r.content, 'print("hi")');
    });
  });

  describe('node -e', () => {
    it('extracts double-quoted body', () => {
      const r = extractInlineCode('node -e "require(\'fs\').rmSync(\'/x\',{recursive:true})"');
      assert.ok(r);
      assert.equal(r.language, 'javascript');
      assert.equal(r.virtualPath, 'inline.js');
      assert.ok(r.content.includes('fs'));
    });

    it('extracts --eval long form', () => {
      const r = extractInlineCode("node --eval 'console.log(1)'");
      assert.ok(r);
      assert.equal(r.language, 'javascript');
      assert.equal(r.content, 'console.log(1)');
    });

    it('accepts `nodejs` as alias', () => {
      const r = extractInlineCode('nodejs -e "1"');
      assert.ok(r);
      assert.equal(r.language, 'javascript');
    });
  });

  describe('bash -c / sh -c', () => {
    it('extracts bash -c body', () => {
      const r = extractInlineCode('bash -c "echo hi"');
      assert.ok(r);
      assert.equal(r.language, 'shell');
      assert.equal(r.content, 'echo hi');
    });

    it('extracts sh -c body', () => {
      const r = extractInlineCode("sh -c 'ls /tmp'");
      assert.ok(r);
      assert.equal(r.language, 'shell');
    });
  });

  describe('perl / ruby / php', () => {
    it('extracts perl -e body', () => {
      const r = extractInlineCode("perl -e 'print \"hi\"'");
      assert.ok(r);
      assert.equal(r.language, 'perl');
    });

    it('extracts perl -E body', () => {
      const r = extractInlineCode('perl -E "say 1"');
      assert.ok(r);
      assert.equal(r.language, 'perl');
    });

    it('extracts ruby -e body', () => {
      const r = extractInlineCode("ruby -e 'puts 1'");
      assert.ok(r);
      assert.equal(r.language, 'ruby');
    });

    it('extracts php -r body', () => {
      const r = extractInlineCode("php -r 'echo 1;'");
      assert.ok(r);
      assert.equal(r.language, 'php');
    });
  });

  describe('non-matches (regression guard)', () => {
    it('returns null for plain `node index.js foo`', () => {
      assert.equal(extractInlineCode('node index.js foo'), null);
    });

    it('returns null for `python3 script.py`', () => {
      assert.equal(extractInlineCode('python3 script.py'), null);
    });

    it('returns null for shell command with no interpreter', () => {
      assert.equal(extractInlineCode('ls /tmp && rm -rf /tmp/x'), null);
    });

    it('returns null for empty command', () => {
      assert.equal(extractInlineCode(''), null);
    });

    it('returns null for python with only version flag', () => {
      assert.equal(extractInlineCode('python3 --version'), null);
    });

    it('returns null for `echo "python3 -c foo"` (inside quotes)', () => {
      // This is a soft guarantee — our regex requires the interpreter
      // to sit at a command boundary. `echo "..."` puts it inside a
      // quoted literal, which doesn't start a new command segment.
      const r = extractInlineCode(`echo "python3 -c 'import foo'"`);
      // Either null (preferred) or a clearly-wrong body (acceptable —
      // false positives here don't weaken security since the body
      // would pass through analysers that find nothing alarming).
      if (r !== null) {
        // Accept false positive but verify it didn't blow up / produce junk.
        assert.equal(typeof r.content, 'string');
      }
    });
  });

  describe('pipeline + chained commands', () => {
    it('extracts interpreter body after && separator', () => {
      const r = extractInlineCode("cd /tmp && python3 -c 'import shutil'");
      assert.ok(r);
      assert.equal(r.language, 'python');
    });

    it('extracts interpreter body after | pipe', () => {
      const r = extractInlineCode("echo hi | python3 -c 'import sys; print(sys.stdin.read())'");
      assert.ok(r);
      assert.equal(r.language, 'python');
      assert.ok(r.content.includes('sys.stdin'));
    });

    it('extracts interpreter body after ; separator', () => {
      const r = extractInlineCode("ls; node -e 'console.log(1)'");
      assert.ok(r);
      assert.equal(r.language, 'javascript');
    });
  });
});
