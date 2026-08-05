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
 * ── On the blocking read ────────────────────────────────────────────
 *
 * This is deliberately synchronous, and staying synchronous is a
 * measured decision rather than an accident of the call site.
 *
 * The constraint: `ConversationSource.callsSince(sinceMs): ChatCall[]`
 * (see `types.ts`) is a synchronous interface implemented by all four
 * platform sources, so an async read here would have to be threaded
 * through every source and every caller of every source — for a hook
 * process whose whole job finishes in tens of milliseconds.
 *
 * The measurement (this machine, Node 25, APFS/NVMe; a JSONL transcript
 * of ~1.1KB records, read in a fresh process so nothing is warmed by a
 * previous call — i.e. exactly a hook invocation's view):
 *
 *   7.81 MB (just under the cap, full-read path) → 6.3–7.4 ms
 *   4.00 MB (full-read path)                     → 1.3 ms  (warm: 1.3 ms)
 *   1.00 MB (full-read path)                     → 0.4 ms
 *   70.0 MB (over the cap, tail path)            → 0.5 ms
 *
 * So the worst case this function can ever take is bounded at ~7 ms by
 * `MAX_CONVERSATION_FILE_BYTES` — anything larger takes the tail path,
 * which is flat in file size (the 70 MB case is *faster* than the 8 MB
 * one, because it reads 2 MB instead of 7.81). For scale, Node process
 * startup alone is several times that, and the host hook budgets are
 * three to four orders of magnitude larger (Hermes: 60 s default per
 * `shell_hooks.py`; Claude Code / Codex: tens of seconds).
 *
 * Going async would therefore buy nothing measurable and cost an
 * interface change across four sources. If `MAX_CONVERSATION_FILE_BYTES`
 * is ever raised substantially, re-run this measurement first — the
 * bound above is what makes the blocking read safe, not the read itself.
 * The tail-path behaviour that enforces it is pinned by
 * `conversation-read-jsonl.test.ts` ("takes the tail-only path once the
 * file exceeds maxBytes").
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
