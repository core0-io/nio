// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Detect MCP tool calls embedded in shell command strings.
 *
 * Users running tools like mcporter (https://github.com/steipete/mcporter)
 * re-expose MCP tools as plain CLI commands, so an agent's `Bash` / `exec`
 * call can invoke an MCP tool without the platform tool-name ever looking
 * like an MCP call. Phase 0's native name-based matcher misses these.
 *
 * This module extracts `server.tool` pairs from such commands so the Phase 0
 * gate can re-apply `blocked_tools.mcp` / `available_tools.mcp` against them.
 *
 * v1 scope: explicit `mcporter` CLI invocations. Known gaps (aliased or
 * renamed binary, wrapper scripts, base64-encoded commands) are acceptable
 * misses; the explicit CLI path covers the common case.
 */

export interface ExtractedMcpCall {
  server: string;
  local: string;
}

const MCPORTER_RE = /\bmcporter\b/g;
const SHELL_SEP_RE = /[;&|\n]/;
const SERVER_TOOL_RE = /^([a-zA-Z][\w-]*)\.([a-zA-Z][\w-]*)/;

/**
 * Extract every `{server, local}` pair invoked via mcporter in a shell
 * command string. Returns an empty array when no mcporter call is present.
 */
export function extractMcpCallsFromCommand(command: string): ExtractedMcpCall[] {
  if (!command || !command.includes('mcporter')) return [];

  const results: ExtractedMcpCall[] = [];
  MCPORTER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MCPORTER_RE.exec(command)) !== null) {
    const startAfter = match.index + match[0].length;
    const rest = command.slice(startAfter);
    const sep = rest.match(SHELL_SEP_RE);
    const segment = sep ? rest.slice(0, sep.index) : rest;

    const hit = parseSegment(segment);
    if (hit) results.push(hit);
  }

  return results;
}

/**
 * Pull the MCP target from tokens after `mcporter`. Skips the `call` verb,
 * flags (and — conservatively — the next non-flag token when the flag has
 * no `=`), and the `--` stop marker. First remaining non-flag token is the
 * target.
 */
function parseSegment(segment: string): ExtractedMcpCall | null {
  const tokens = segment.trim().split(/\s+/).filter(t => t.length > 0);
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];

    if (tok === '--') {
      // Stop-flag marker — next token is the target if present.
      return i + 1 < tokens.length ? parseTarget(tokens[i + 1]) : null;
    }

    if (tok === 'call') {
      i++;
      continue;
    }

    if (tok.startsWith('-')) {
      if (tok.includes('=')) {
        i++;
        continue;
      }
      // Flag without `=`: consume next non-flag token as its value.
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith('-') && tokens[i + 1] !== '--') {
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    return parseTarget(tok);
  }
  return null;
}

/**
 * Normalize a raw target token: strip wrapping quotes, truncate at the
 * first `(` (function-call syntax), then match `server.tool`.
 */
function parseTarget(raw: string): ExtractedMcpCall | null {
  let t = raw;
  if (t.startsWith("'") || t.startsWith('"')) t = t.slice(1);
  if (t.endsWith("'") || t.endsWith('"')) t = t.slice(0, -1);
  const paren = t.indexOf('(');
  if (paren >= 0) t = t.slice(0, paren);
  const m = t.match(SERVER_TOOL_RE);
  return m ? { server: m[1], local: m[2] } : null;
}

/**
 * Pull the shell command string out of a tool's input payload. Handles both
 * CC-style `{command: "..."}` and OpenClaw-style `{command: "...", args:
 * [...]}` shapes. Returns "" when neither is present.
 */
export function extractCommandString(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  const cmd = typeof input['command'] === 'string' ? input['command'] : '';
  const argsRaw = input['args'];
  const args = Array.isArray(argsRaw)
    ? argsRaw.filter((a): a is string => typeof a === 'string').join(' ')
    : '';
  return [cmd, args].filter(Boolean).join(' ');
}
