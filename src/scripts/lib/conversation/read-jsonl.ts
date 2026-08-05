// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';

/**
 * Above this size we stop reading a session file in full.
 *
 * A long-running Claude Code transcript or Codex rollout can grow to
 * tens of MB, and the process reading it (a blocking hook) sits on the
 * host CLI's critical path. Rather than load the whole thing into
 * memory — the `readFileSync(...).split('\n')` pattern this module
 * exists to avoid repeating — we cap how much we read and take only
 * the tail, which is where the calls a hook cares about live anyway.
 */
export const MAX_CONVERSATION_FILE_BYTES = 64 * 1024 * 1024; // 64 MB

/**
 * Reads a JSONL file as an array of non-empty lines, guarding against
 * unbounded memory use on very large session files.
 *
 * Below `maxBytes` the file is read in full. Above it, only the last
 * `maxBytes` bytes are read, and the first line of that slice is
 * dropped since a byte offset almost never lands on a line boundary —
 * the leading fragment is a truncated record that would just fail to
 * parse anyway.
 *
 * Never throws: a missing file, unreadable file, or empty file all
 * yield an empty array. Individual line content is not validated here;
 * callers are responsible for tolerating malformed JSON per line.
 */
export function readJsonlTail(path: string, maxBytes: number = MAX_CONVERSATION_FILE_BYTES): string[] {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return [];
  }
  if (size <= 0) return [];

  try {
    if (size <= maxBytes) {
      const content = readFileSync(path, 'utf-8');
      return content.split('\n').filter((line) => line.length > 0);
    }

    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(maxBytes);
      const start = size - maxBytes;
      readSync(fd, buf, 0, maxBytes, start);
      const lines = buf.toString('utf-8').split('\n').filter((line) => line.length > 0);
      return lines.slice(1);
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
}
