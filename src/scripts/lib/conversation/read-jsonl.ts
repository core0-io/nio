// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';

/**
 * Above this size we stop reading a session file in full and switch to
 * the tail-only path.
 *
 * A long-running Claude Code transcript or Codex rollout can grow to
 * tens of MB, and the process reading it (a blocking hook) sits on the
 * host CLI's critical path. Rather than load the whole thing into
 * memory — the `readFileSync(...).split('\n')` pattern this module
 * exists to avoid repeating — we cap how much we read and take only
 * the tail, which is where the calls a hook cares about live anyway.
 *
 * This is deliberately a single-digit-MB threshold, not tens of MB: a
 * transcript at the actual "tens of MB" scale the hook is protecting
 * against is exactly the case that must NOT fall through to the
 * full-file `readFileSync` branch below.
 */
export const MAX_CONVERSATION_FILE_BYTES = 8 * 1024 * 1024; // 8 MB

/**
 * How many bytes are actually read from the tail once a file is over
 * `MAX_CONVERSATION_FILE_BYTES`.
 *
 * Deliberately a separate, much smaller constant from the threshold
 * above rather than reusing it as the buffer size: a 70 MB rollout and
 * a 700 MB one must cost the same to read — the whole point of the
 * tail path — and coupling the buffer to the (potentially raised)
 * threshold would silently reintroduce the unbounded-memory problem
 * this module exists to avoid.
 */
export const TAIL_READ_BYTES = 2 * 1024 * 1024; // 2 MB

/**
 * Slices a tail-read buffer down to the bytes actually returned by
 * `readSync`, then splits it into complete, non-empty lines.
 *
 * `readSync` is allowed to return fewer bytes than requested (a short
 * read); if the caller ignores that and stringifies the whole
 * `Buffer.alloc`'d buffer, the unwritten tail is `0x00` bytes that get
 * spliced onto the last "line" as garbage. Bounding the stringify to
 * `bytesRead` avoids that.
 *
 * The first line of the slice is dropped unconditionally: a byte
 * offset into the file almost never lands on a line boundary, so the
 * leading fragment is a truncated record that would just fail to parse
 * anyway (and, uncaught, would look like real-but-corrupt data instead
 * of the known-partial fragment it is).
 */
export function linesFromTailBuffer(buf: Buffer, bytesRead: number): string[] {
  const lines = buf
    .subarray(0, bytesRead)
    .toString('utf-8')
    .split('\n')
    .filter((line) => line.length > 0);
  return lines.slice(1);
}

/**
 * Reads a JSONL file as an array of non-empty lines, guarding against
 * unbounded memory use on very large session files.
 *
 * Below `maxBytes` the file is read in full. Above it, only the last
 * `tailBytes` bytes are read (independent of `maxBytes` — see
 * `TAIL_READ_BYTES`), and the first line of that slice is dropped
 * (see `linesFromTailBuffer`).
 *
 * Never throws: a missing file, unreadable file (including a
 * directory), or empty file all yield an empty array. Individual line
 * content is not validated here; callers are responsible for
 * tolerating malformed JSON per line.
 *
 * Deliberately synchronous — `ConversationSource.callsSince` is a
 * synchronous interface implemented by every platform source, and this
 * runs inside a host-blocking hook. What makes that safe is the bound,
 * not the read: `MAX_CONVERSATION_FILE_BYTES` caps the full-read path,
 * and everything larger takes the tail path, which is flat in file
 * size. Raising that constant substantially removes the bound and needs
 * re-measuring before it ships.
 */
export function readJsonlTail(
  path: string,
  maxBytes: number = MAX_CONVERSATION_FILE_BYTES,
  tailBytes: number = TAIL_READ_BYTES,
): string[] {
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
      const readSize = Math.min(tailBytes, size);
      const buf = Buffer.alloc(readSize);
      const start = size - readSize;
      const bytesRead = readSync(fd, buf, 0, readSize, start);
      return linesFromTailBuffer(buf, bytesRead);
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
}
