// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Stage 2 — per-fragment detectors.
 *
 * Each detector takes a flat command fragment (already unwrapped by Stage
 * 1) and emits zero or more `RoutedMcpCall`. Subsequent commits will add
 * D2-D16; this commit only contains D1 (mcporter, migrated from the
 * previous mcp-shell-detect module).
 */

import type { RoutedMcpCall, UnwrappedFragment } from './types.js';
import type { MCPRegistry } from '../mcp-registry.js';

const MCPORTER_RE = /\bmcporter\b/g;
const SHELL_SEP_RE = /[;&|\n]/;
const SERVER_TOOL_RE = /^([a-zA-Z][\w-]*)\.([a-zA-Z][\w-]*)/;

/**
 * D1 — mcporter CLI invocations. Matches `mcporter [call] <server>.<tool>`,
 * `npx mcporter ...`, `bunx mcporter ...`, absolute paths to mcporter, etc.
 * Skips the optional `call` verb and any flags (`-x`, `--flag`, `--flag=v`,
 * `--`).
 */
export function detectMcporter(fragment: UnwrappedFragment): RoutedMcpCall[] {
  const command = fragment.command;
  if (!command || !command.includes('mcporter')) return [];

  const results: RoutedMcpCall[] = [];
  MCPORTER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MCPORTER_RE.exec(command)) !== null) {
    const startAfter = match.index + match[0].length;
    const rest = command.slice(startAfter);
    const sep = rest.match(SHELL_SEP_RE);
    const segment = sep ? rest.slice(0, sep.index) : rest;
    const hit = parseMcporterSegment(segment);
    if (hit) {
      results.push({
        server: hit.server,
        tool: hit.tool,
        via: 'mcporter',
        evidence: 'mcporter ' + segment.trim(),
        flags: fragment.flags,
      });
    }
  }
  return results;
}

interface McporterTarget { server: string; tool: string; }

function parseMcporterSegment(segment: string): McporterTarget | null {
  const tokens = segment.trim().split(/\s+/).filter((t) => t.length > 0);
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];

    if (tok === '--') {
      return i + 1 < tokens.length ? parseMcporterTarget(tokens[i + 1]) : null;
    }

    if (tok === 'call') { i++; continue; }

    if (tok.startsWith('-')) {
      if (tok.includes('=')) { i++; continue; }
      // Flag without `=`: consume the next non-flag token as its value.
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith('-') && tokens[i + 1] !== '--') {
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    return parseMcporterTarget(tok);
  }
  return null;
}

function parseMcporterTarget(raw: string): McporterTarget | null {
  let t = raw;
  if (t.startsWith("'") || t.startsWith('"')) t = t.slice(1);
  if (t.endsWith("'") || t.endsWith('"')) t = t.slice(0, -1);
  const paren = t.indexOf('(');
  if (paren >= 0) t = t.slice(0, paren);
  const m = t.match(SERVER_TOOL_RE);
  return m ? { server: m[1], tool: m[2] } : null;
}

/**
 * Run every detector against a fragment. Each fragment is independent;
 * detectors do not see each other's output.
 *
 * `registry` is currently unused (D1 doesn't need it). It will be wired
 * into D2-D11 in subsequent commits, hence the parameter exists in the
 * signature today.
 */
export function runDetectors(
  fragment: UnwrappedFragment,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _registry: MCPRegistry | null = null,
): RoutedMcpCall[] {
  return detectMcporter(fragment);
}
