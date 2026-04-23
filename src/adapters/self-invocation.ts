// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Nio self-invocation detection.
 *
 * When a skill or E2E test runs Nio's own bundled CLI scripts via the
 * host's shell-exec tool (e.g. Claude Code's `Bash`), the outer guard
 * hook would otherwise analyse the Bash command string via Phase 1-6
 * and then the spawned `action-cli.js` subprocess would analyse the
 * same action envelope again — double work on overlapping inputs, and
 * in practice the outer hook often denies dangerous-looking skill
 * queries (the Bash command literally contains e.g. `rm -rf /` as an
 * argument), breaking the skill entirely.
 *
 * The detector below recognises the canonical form of such self-calls
 * from an `exec_command` action's `data.command` field. Callers of
 * `evaluateHook` can use the result to short-circuit Phase 1-6 after
 * Phase 0 has already passed — blocked_tools still applies, but the
 * content analysis is left to the spawned action-cli subprocess,
 * which does exactly one pipeline run on the real envelope.
 *
 * Whitelist intent:
 *   - Leading `node` then an absolute path ending in
 *     `/skills/nio/scripts/<name>.js` where <name> is one of Nio's
 *     six bundled scripts.
 *   - Optional args, but NO shell metacharacters (`& | ; ` ` $ ( ) < >`)
 *     anywhere in the raw string. Quotes and common arg chars
 *     (letters, digits, `-`, `=`, `.`, `/`, spaces) are allowed.
 *   - Anchored at both ends — `node ... && rm -rf /` cannot match.
 *
 * Safety bias:
 *   - False negatives (regex doesn't match a legitimate self-call)
 *     fall back to the current double-analysis behavior — wasteful
 *     but safe.
 *   - False positives (regex matches a non-Nio command) would be a
 *     Phase-1-6 bypass. Hence the strict whitelist, required
 *     `/skills/nio/scripts/` substring (non-Nio code should never
 *     have this directory segment on disk), whitelisted script
 *     names, and metacharacter exclusion.
 *
 * If a new script is added to `src/scripts/` and becomes skill-
 * invokable via shell-exec, extend the whitelist in the regex below.
 */

const NIO_SELF_INVOCATION =
  /^\s*node\s+\S+\/skills\/nio\/scripts\/(action-cli|hook-cli|scanner-hook|guard-hook|config-cli|collector-hook)\.js(\s+[^&|;`$()<>]*)?\s*$/;

/**
 * Return true if the command string is a Nio self-invocation that
 * should be passed through the outer guard hook without running
 * Phase 1-6 content analysis.
 */
export function isNioSelfInvocation(command: string | undefined | null): boolean {
  if (!command) return false;
  return NIO_SELF_INVOCATION.test(command);
}
