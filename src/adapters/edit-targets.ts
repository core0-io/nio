// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import type { FileOperationData } from '../types/action.js';

/**
 * Every file a patch-style edit payload may touch: opencode's `apply_patch`
 * and OMP's input-only `edit` modes (apply_patch, hashline, sloppy).
 *
 * Deliberately lenient: the patterns accept looser spellings than the
 * engines' grammars, and any line that looks like a header counts. A false
 * target can only add a wrong deny on an odd edit; a missed target would
 * be a silent bypass of the sensitive-path check.
 */

// `*** Add|Update|Delete|Edit File: <path>` and `*** Move to: <path>`, any case/spacing.
const FILE_HEADER = /^\s*\*{0,3}\s*(?:(?:add|update|delete|edit)\s*file|move\s*to)\s*:\s*(.+?)\s*$/i;
// Hashline section header `[<path>#<tag>]`, with optional header noise inside the brackets.
const BRACKET_HEADER = /^\s*\[([^\]\r\n]+)\]\s*$/;
const BRACKET_TAG = /#[^\s#/\\]*\s*$/;
const BRACKET_NOISE = /^\*{0,3}\s*(?:(?:update|add|delete|move)[^A-Za-z0-9]*(?:file|to)?[^A-Za-z0-9]*:)?\s*\*{0,3}\s*/i;
// Hashline rename `MV <dest>`.
const MOVE_OP = /^\s*MV\s+(.+?)\s*$/i;
const SLOPPY_ALL_SUFFIX = /\s+all$/i;

function unquote(path: string): string {
  return path.replace(/^(["'`])(.*)\1$/, '$2').trim();
}

function lineTargets(line: string): string[] {
  const header = FILE_HEADER.exec(line);
  if (header) {
    const path = unquote(header[1]!);
    return SLOPPY_ALL_SUFFIX.test(path) ? [path, path.replace(SLOPPY_ALL_SUFFIX, '')] : [path];
  }
  const bracket = BRACKET_HEADER.exec(line);
  if (bracket) return [unquote(bracket[1]!.replace(BRACKET_TAG, '').replace(BRACKET_NOISE, '').trim())];
  const move = MOVE_OP.exec(line);
  if (move) return [unquote(move[1]!)];
  return [];
}

/** Distinct non-empty targets in order of appearance. */
export function editTargets(patchText: string | undefined): string[] {
  if (!patchText) return [];
  const targets = patchText.split(/\r?\n/).flatMap(lineTargets).filter(Boolean);
  return [...new Set(targets)];
}

/** The first target as `path`, the rest as `additional_paths`. */
export function targetFields(targets: string[]): Pick<FileOperationData, 'path' | 'additional_paths'> {
  const [path = '', ...rest] = targets;
  return rest.length > 0 ? { path, additional_paths: rest } : { path };
}
