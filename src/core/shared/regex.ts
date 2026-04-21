// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Compile a user-supplied pattern string into a RegExp.
 *
 * Accepts two forms:
 *   "pattern"           — no flags
 *   "/pattern/flags"    — with flags (g, i, m, s, u, y)
 *
 * Throws on invalid pattern/flag.
 */
export function compileUserRegex(pattern: string): RegExp {
  const m = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
  return m ? new RegExp(m[1]!, m[2]) : new RegExp(pattern);
}

/**
 * Compile a list of user-supplied patterns, silently skipping any that fail
 * to parse. Use this in hot paths where one bad pattern should not disable
 * the whole rule.
 */
export function compileUserRegexList(patterns: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns) {
    try {
      out.push(compileUserRegex(p));
    } catch {
      // skip invalid pattern
    }
  }
  return out;
}
