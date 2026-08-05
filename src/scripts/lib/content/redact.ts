// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export {};

/**
 * Free-text secret scanning for captured conversation content.
 *
 * `redactAndTruncate` (traces-collector.ts) only scans JSON *key names* —
 * a value is redacted iff its key looks like `api_key` / `token` /
 * `password`. That catches structured payloads but misses secrets that
 * show up in prose: model `thinking` narrating a key it was just handed,
 * or a `tool_input.command` string containing a literal
 * `export AWS_SECRET_ACCESS_KEY=...`. Once nio captures thinking and full
 * command text, that gap stops being theoretical.
 *
 * Design choice — **no generic high-entropy detection**. A "long random
 * string" heuristic is the single biggest source of false positives in
 * developer conversations, where all of the following are common and must
 * pass through untouched:
 *
 *   - git commit hashes (full 40-hex and abbreviated 7–12-hex)
 *   - UUIDs
 *   - hex-named directories inside file paths
 *   - ordinary base64-encoded data that isn't a JWT
 *   - long hyphenated/ordinary English words
 *
 * Redacting those would bury real findings under a wall of
 * `[REDACTED]` markers with no way to tell what was actually removed —
 * worse for incident response than an occasional missed secret. So every
 * pattern below matches on a concrete, documented prefix or structural
 * feature (a known credential prefix, JWT's three-dot-separated
 * base64url structure, a PEM header/footer, an `Authorization:` header),
 * never on entropy or length alone.
 *
 * Consequence: secrets from providers that don't use a recognizable
 * prefix (internal-only tokens, custom credential formats) will not be
 * caught here. Operators with such formats should add their own patterns
 * via `guard.action_guard_rules` / the `extraPatterns` parameter rather
 * than expecting this module to catch them by shape alone.
 */

export interface RedactResult {
  text: string;
  hits: number;
}

const REDACTED = '[REDACTED]';

// Order matters: PEM blocks are multi-line and contain base64 that other
// patterns (JWT, generic key-shaped strings) could otherwise chop up if
// they ran first. PEM must always be matched — and replaced — before any
// other pattern gets a chance to fragment it.
const BUILTIN_PATTERNS: RegExp[] = [
  // PEM private key blocks (RSA/EC/DSA/generic "PRIVATE KEY"), including
  // the base64 body between the BEGIN/END markers. `[\s\S]*?` (not `.*`)
  // so it spans newlines without needing the `s` flag.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,

  // Anthropic API keys: sk-ant-<suffix>.
  /sk-ant-[A-Za-z0-9_-]{20,}/g,

  // OpenAI project/legacy keys: sk-proj-<suffix> or bare sk-<suffix>.
  // sk-proj- is checked implicitly by the longer alternative sorting
  // first isn't needed here since both start with `sk-`; requiring 20+
  // trailing chars keeps short unrelated "sk-" substrings from matching.
  /sk-proj-[A-Za-z0-9_-]{16,}/g,
  /sk-(?!ant-|proj-)[A-Za-z0-9_-]{20,}/g,

  // AWS access key IDs: AKIA followed by 16 uppercase alphanumerics.
  /AKIA[0-9A-Z]{16}/g,

  // GitHub tokens: ghp_/gho_/ghs_/ghu_/ghr_ followed by 36+ alphanumerics.
  /gh[pousr]_[A-Za-z0-9]{36,}/g,

  // JWTs: three base64url segments separated by dots, header starting
  // with the near-universal `eyJ` (base64 of `{"`).
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,

  // HTTP Authorization headers: Bearer <token> or Basic <base64>.
  /Authorization:\s*(Bearer|Basic)\s+[A-Za-z0-9._-]+/gi,
];

/**
 * Scan free text for secret-shaped substrings and replace each with
 * `[REDACTED]`. Pure: no IO, no caching, no global state — same input
 * always yields the same output.
 *
 * @param text - the text to scan.
 * @param extraPatterns - additional global RegExps to apply after the
 *   built-in set (e.g. an operator's internal credential prefix from
 *   config). Applied in the order given.
 * @returns the redacted text and the total number of replacements made.
 */
export function redactSecrets(text: string, extraPatterns: RegExp[] = []): RedactResult {
  let result = text;
  let hits = 0;

  for (const pattern of [...BUILTIN_PATTERNS, ...extraPatterns]) {
    // Reset lastIndex defensively: a caller-supplied RegExp instance
    // could be reused across calls and retain stale state.
    pattern.lastIndex = 0;
    result = result.replace(pattern, () => {
      hits += 1;
      return REDACTED;
    });
  }

  return { text: result, hits };
}
