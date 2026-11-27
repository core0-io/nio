// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';

export const MAX_CONVERSATION_FILE_BYTES = 8 * 1024 * 1024; // 8 MB

export const TAIL_READ_BYTES = 2 * 1024 * 1024; // 2 MB

export function linesFromTailBuffer(buf: Buffer, bytesRead: number, startsAtLineBoundary = false): string[] {
  const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n');
  if (!startsAtLineBoundary) lines.shift();
  return lines.filter((line) => line.length > 0);
}

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
      const preceding = Buffer.alloc(1);
      const startsAtLineBoundary = start === 0 || (readSync(fd, preceding, 0, 1, start - 1) === 1 && preceding[0] === 10);
      return linesFromTailBuffer(buf, bytesRead, startsAtLineBoundary);
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
}
