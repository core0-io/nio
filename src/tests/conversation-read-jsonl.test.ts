// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

// read-jsonl.ts is the one shared helper across all replay conversation
// sources (claude-code-source.ts, codex-source.ts) and the only module
// in this batch that touches real file I/O with a resource-risk
// concern (unbounded memory on a huge session file) — yet it had zero
// dedicated tests. This file closes that gap.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonlTail, linesFromTailBuffer } from '../scripts/lib/conversation/read-jsonl.js';

function tmpFile(name: string, content: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'nio-read-jsonl-test-'));
  const path = join(dir, name);
  writeFileSync(path, content);
  return { dir, path };
}

describe('readJsonlTail', () => {
  it('reads every non-empty line of a small file, in order', () => {
    const { dir, path } = tmpFile('small.jsonl', 'line-1\nline-2\n\nline-3\n');
    try {
      const lines = readJsonlTail(path);
      assert.deepEqual(lines, ['line-1', 'line-2', 'line-3']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('takes the tail-only path once the file exceeds maxBytes, returning only tail lines', () => {
    // Each record is a fixed 9 bytes ("lineNNNN\n") so the math below is
    // exact: file size is always a clean multiple of the record size.
    const RECORD_BYTES = 9;
    const RECORD_COUNT = 500;
    let content = '';
    for (let i = 0; i < RECORD_COUNT; i++) {
      content += `line${String(i).padStart(4, '0')}\n`;
    }
    assert.equal(Buffer.byteLength(content), RECORD_BYTES * RECORD_COUNT);

    const { dir, path } = tmpFile('big.jsonl', content);
    try {
      const maxBytes = 100; // well under the file's size: forces the tail path
      const tailBytes = 50; // small window; 50 % 9 !== 0, guaranteeing the
      // window's start lands mid-record, not on a record boundary
      const lines = readJsonlTail(path, maxBytes, tailBytes);

      assert.ok(lines.length > 0, 'tail window must yield at least one complete line');
      assert.ok(lines.length < RECORD_COUNT, 'tail path must not return the whole file');
      for (const line of lines) {
        assert.match(
          line,
          /^line\d{4}$/,
          `line "${line}" is not a well-formed complete record — the truncated leading fragment was not dropped`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drops the first (possibly truncated) line of the tail window even when nothing looks obviously broken', () => {
    // Same fixed-width setup, but this time assert directly against the
    // known last record rather than just a shape regex, so a bug that
    // returns the *wrong* count (off by the dropped line) is also caught.
    const RECORD_BYTES = 9;
    const RECORD_COUNT = 200;
    let content = '';
    for (let i = 0; i < RECORD_COUNT; i++) {
      content += `line${String(i).padStart(4, '0')}\n`;
    }
    const { dir, path } = tmpFile('tail-drop.jsonl', content);
    try {
      const maxBytes = 50;
      const tailBytes = 30; // 30 % 9 = 3, so the window start is 6 bytes
      // into a record (not on the trailing "\n" itself, unlike e.g. 28),
      // guaranteeing a genuinely non-empty leading fragment to drop
      const lines = readJsonlTail(path, maxBytes, tailBytes);

      // Last full record must always be present…
      assert.equal(lines[lines.length - 1], `line${String(RECORD_COUNT - 1).padStart(4, '0')}`);
      // …and every returned line must be a complete, well-formed record —
      // the truncated fragment at the front of the window must be gone.
      for (const line of lines) assert.match(line, /^line\d{4}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty array for a nonexistent file', () => {
    assert.deepEqual(readJsonlTail('/nonexistent/nope.jsonl'), []);
  });

  it('returns an empty array (never throws) when the path is a directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nio-read-jsonl-test-dir-'));
    try {
      mkdirSync(join(dir, 'unused'));
      assert.deepEqual(readJsonlTail(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty array for a zero-byte file', () => {
    const { dir, path } = tmpFile('empty.jsonl', '');
    try {
      assert.deepEqual(readJsonlTail(path), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('linesFromTailBuffer', () => {
  it('splits complete lines and drops the leading (truncated) fragment', () => {
    const buf = Buffer.from('trunc-frag\nline-A\nline-B\n', 'utf-8');
    const lines = linesFromTailBuffer(buf, buf.length);
    assert.deepEqual(lines, ['line-A', 'line-B']);
  });

  it('bounds the stringify to bytesRead, so a short read does not splice 0x00 padding into the result', () => {
    // Simulates Buffer.alloc(64) (zero-filled) followed by a short
    // readSync that only actually filled the first 18 bytes —
    // "trunc-frag\nline-A\n" — leaving 46 trailing 0x00 bytes in the
    // buffer that a caller ignoring readSync's return value would
    // wrongly stringify along with the real data.
    const buf = Buffer.alloc(64);
    const written = buf.write('trunc-frag\nline-A\n', 0, 'utf-8');

    const lines = linesFromTailBuffer(buf, written);

    assert.deepEqual(lines, ['line-A']);
    for (const line of lines) {
      assert.ok(!line.includes('\u0000'), `line must not contain 0x00 padding: ${JSON.stringify(line)}`);
    }
  });

  it('returns an empty array when bytesRead is 0', () => {
    const buf = Buffer.alloc(16);
    assert.deepEqual(linesFromTailBuffer(buf, 0), []);
  });
});
