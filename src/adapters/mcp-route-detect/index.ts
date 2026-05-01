// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * MCP route detection — public entry point.
 *
 * Maps Bash commands that indirectly invoke MCP tools (via mcporter, HTTP
 * clients, language runtimes, stdio pipes, package runners, …) back to
 * `{server, tool}` so Phase 0 can re-apply the existing
 * `permitted_tools.mcp` / `blocked_tools.mcp` allowlist.
 *
 * Two-stage pipeline:
 *   Stage 1: recursive unwrap (handles nesting, obfuscation, encoding)
 *   Stage 2: per-fragment detectors (D1-D16 across commits 2-6)
 *
 * Backward-compat exports preserve the old `mcp-shell-detect` API.
 */

import { unwrapCommand } from './unwrappers.js';
import { runDetectors } from './detectors.js';
import type { RoutedMcpCall } from './types.js';
import type { MCPRegistry } from '../mcp-registry.js';

export type { RoutedMcpCall, DetectorTag, UnwrappedFragment } from './types.js';

/**
 * Run the full MCP route detection on a Bash command. Returns every
 * `{server, tool, via}` triple matched across all detectors.
 */
export function detectMcpCalls(command: string, registry: MCPRegistry | null = null): RoutedMcpCall[] {
  if (!command) return [];
  const fragments = unwrapCommand(command);
  const calls: RoutedMcpCall[] = [];
  for (const frag of fragments) {
    calls.push(...runDetectors(frag, registry));
  }
  return calls;
}

// ---------------------------------------------------------------------------
// Backward-compat shim — preserves the legacy mcp-shell-detect API
// ---------------------------------------------------------------------------

/** @deprecated use `RoutedMcpCall` from this module. */
export interface ExtractedMcpCall {
  server: string;
  local: string;
}

/**
 * Legacy compat: only D1 (mcporter) hits, in `{server, local}` shape.
 *
 * @deprecated use `detectMcpCalls()` instead.
 */
export function extractMcpCallsFromCommand(command: string): ExtractedMcpCall[] {
  return detectMcpCalls(command, null)
    .filter((c) => c.via === 'mcporter' && c.tool)
    .map((c) => ({ server: c.server, local: c.tool as string }));
}

/**
 * Pull the shell command string out of a tool's input payload. Handles
 * both CC-style `{command: "..."}` and OpenClaw-style `{command, args}`
 * shapes.
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
