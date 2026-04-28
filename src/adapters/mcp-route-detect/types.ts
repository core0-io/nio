// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Common types for the MCP route detection pipeline.
 *
 * The pipeline reconstructs *which* MCP server and tool a Bash command is
 * invoking — directly (mcporter) or indirectly (HTTP, stdio, package
 * runner, …) — so Phase 0 can re-apply `available_tools.mcp` /
 * `blocked_tools.mcp` against indirect channels.
 */

/** Detector tag — names the channel that produced a routed call. */
export type DetectorTag =
  | 'mcporter'
  | 'http_client'
  | 'httpie'
  | 'tcp_socket'
  | 'dev_tcp'
  | 'pwsh_http'
  | 'language_runtime'
  | 'stdio_pipe'
  | 'stdin_redirect'
  | 'fifo'
  | 'package_runner'
  | 'self_launch'
  | 'compiled'
  | 'obfuscation_fallback';

export interface RoutedMcpCall {
  /** Resolved server name (always present). */
  server: string;
  /** Resolved tool name; absent when the channel could not name one. */
  tool?: string;
  /** Detection channel that produced this call. */
  via: DetectorTag;
  /** The exact command fragment that matched (for audit). */
  evidence: string;
  /** Pass-through flags from outer unwrappers. */
  flags?: {
    remote?: boolean;
    background?: boolean;
    compiled?: boolean;
  };
}

/** A single fragment produced by Stage 1 unwrap, plus any pass-through flags. */
export interface UnwrappedFragment {
  command: string;
  /** Inline-code fragments (python -c, node -e, …) are flagged so detectors
   *  that only operate on shell text can ignore them. */
  inline?: boolean;
  flags?: {
    remote?: boolean;
    background?: boolean;
    compiled?: boolean;
  };
}
