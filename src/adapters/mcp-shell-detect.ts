// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * @deprecated Logic has moved to `./mcp-route-detect/index.js`. This file
 * is a thin re-export shim kept so existing imports (and the
 * mcp-shell-detect.test.ts test file) continue to work without churn.
 * New callers should import from `./mcp-route-detect/` directly.
 */

export {
  extractMcpCallsFromCommand,
  extractCommandString,
  type ExtractedMcpCall,
} from './mcp-route-detect/index.js';
