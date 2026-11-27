// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { editTargets, targetFields } from '../adapters/edit-targets.js';

describe('editTargets', () => {
  const cases: Array<[string, string, string[]]> = [
    ['hashline header', '[src/a.ts#1A2B]', ['src/a.ts']],
    ['hashline lowercase tag', '[/home/u/.ssh/authorized_keys#ce7d]', ['/home/u/.ssh/authorized_keys']],
    ['hashline inner whitespace', '  [ /home/u/.bashrc#CE7D ]  ', ['/home/u/.bashrc']],
    ['hashline loose tag', '[src/a.ts#abc]', ['src/a.ts']],
    ['hashline without tag', '[src/a.ts]', ['src/a.ts']],
    ['hashline path containing #', '[docs/c#/notes.md#AB12]', ['docs/c#/notes.md']],
    ['hashline in-bracket Update File', '[*** Update File: /home/u/.npmrc#AB12]', ['/home/u/.npmrc']],
    ['hashline in-bracket Move to', '[Move to: /home/u/.npmrc#AB12]', ['/home/u/.npmrc']],
    ['hashline MV', 'MV /home/u/.bashrc', ['/home/u/.bashrc']],
    ['hashline MV quoted', 'MV "docs/my notes.md"', ['docs/my notes.md']],
    ['apply_patch Add File', '*** Add File: src/new.ts', ['src/new.ts']],
    ['apply_patch Update File', '*** Update File: src/a.py', ['src/a.py']],
    ['apply_patch Delete File', '*** Delete File: old.txt', ['old.txt']],
    ['apply_patch Move to', '*** Move to: /home/u/.aws/credentials', ['/home/u/.aws/credentials']],
    ['apply_patch loose spacing', '  ***   update   file :  src/a.py  ', ['src/a.py']],
    ['sloppy Edit File', '*** Edit File: src/a.ts', ['src/a.ts']],
    ['sloppy Edit File all', '*** Edit File: src/a.ts all', ['src/a.ts all', 'src/a.ts']],
    ['sloppy lowercase', '*** edit file: docs/a b.md', ['docs/a b.md']],
  ];
  for (const [name, line, expected] of cases) {
    it(name, () => assert.deepEqual(editTargets(`*** Begin Patch\n${line}\n*** End Patch`), expected));
  }

  it('collects every target in order, without duplicates', () => {
    const patch = '[a.ts#AB12]\nPUT >$:\n+x\n[b.ts#CD34]\nMV c.ts\n*** Update File: a.ts\n*** Move to: d.ts';
    assert.deepEqual(editTargets(patch), ['a.ts', 'b.ts', 'c.ts', 'd.ts']);
  });

  it('treats only uppercase MV as a move, and skips hashline forms when asked', () => {
    assert.deepEqual(editTargets(' mv .env.example .env\nmv a b'), []);
    assert.deepEqual(editTargets('[a.ts#AB12]\nMV b.ts\n*** Add File: c.ts', { hashline: false }), ['c.ts']);
  });

  it('ignores body rows and empty input', () => {
    assert.deepEqual(editTargets('PUT >$:\n+[x.ts#AB12]\n+*** Add File: y.ts\n-MV z.ts'), []);
    assert.deepEqual(editTargets(''), []);
    assert.deepEqual(editTargets(undefined), []);
  });
});

describe('targetFields', () => {
  it('splits the first target from the rest', () => {
    assert.deepEqual(targetFields(['a', 'b', 'c']), { path: 'a', additional_paths: ['b', 'c'] });
    assert.deepEqual(targetFields(['a']), { path: 'a' });
    assert.deepEqual(targetFields([]), { path: '' });
  });
});
