// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linesFromTailBuffer, readJsonlTail } from '../scripts/lib/conversation/read-jsonl.js';


describe('bounded conversation JSONL reads', () => {
  it('respects short reads and drops only an incomplete leading line', () => {
    const text = 'fragment\n{"id":1}\n\n{"id":2}\n';
    const buffer = Buffer.alloc(Buffer.byteLength(text) + 64);
    buffer.write(text);
    assert.deepEqual(linesFromTailBuffer(buffer, Buffer.byteLength(text)), ['{"id":1}', '{"id":2}']);
    assert.deepEqual(linesFromTailBuffer(Buffer.from('\n{"id":1}\n'), 10), ['{"id":1}']);
    assert.deepEqual(linesFromTailBuffer(Buffer.from('{"id":1}\n'), 9, true), ['{"id":1}']);
  });

  it('keeps a complete first tail line when the offset lands exactly after a newline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nio-jsonl-'));
    try {
      const file = join(dir, 'session.jsonl');
      writeFileSync(file, 'first\nsecond\nthird\n');
      assert.deepEqual(readJsonlTail(file, 1, 13), ['second', 'third']);
      assert.deepEqual(readJsonlTail(file, 1, 12), ['third']);
      assert.deepEqual(readJsonlTail(file), ['first', 'second', 'third']);
      assert.deepEqual(readJsonlTail(join(dir, 'missing')), []);
      assert.deepEqual(readJsonlTail(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
