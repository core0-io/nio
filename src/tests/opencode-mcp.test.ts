// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMcpToolName } from '../adapters/hook-engine.js';

describe('parseMcpToolName — opencode', () => {
  it('attributes a tool to a known server', () => {
    const r = parseMcpToolName('github_create_issue', 'opencode', ['github', 'jira']);
    assert.equal(r.isMcp, true);
    assert.equal(r.server, 'github');
    assert.equal(r.local, 'create_issue');
  });

  it('prefers the longest matching server prefix', () => {
    const r = parseMcpToolName('my_server_search', 'opencode', ['my', 'my_server']);
    assert.equal(r.isMcp, true);
    assert.equal(r.server, 'my_server');
    assert.equal(r.local, 'search');
  });

  it('handles a sanitized server name containing underscores', () => {
    // opencode sanitizes "my-server.io" to "my-server_io"
    const r = parseMcpToolName('my-server_io_list', 'opencode', ['my-server_io']);
    assert.equal(r.isMcp, true);
    assert.equal(r.server, 'my-server_io');
    assert.equal(r.local, 'list');
  });

  it('falls back to the full name when no server matches', () => {
    const r = parseMcpToolName('unknown_tool', 'opencode', ['github']);
    assert.equal(r.isMcp, true);
    assert.equal(r.server, undefined);
    assert.equal(r.local, 'unknown_tool');
  });

  it('reports non-MCP when no servers are configured', () => {
    assert.equal(parseMcpToolName('bash', 'opencode', []).isMcp, false);
    assert.equal(parseMcpToolName('bash', 'opencode').isMcp, false);
  });

  it('never treats a built-in tool name as MCP when servers exist', () => {
    // "bash" has no underscore, so it cannot be a <server>_<tool> form.
    assert.equal(parseMcpToolName('bash', 'opencode', ['github']).isMcp, false);
  });

  it('never misclassifies apply_patch, the one underscored built-in', () => {
    // Regression guard: without the built-in check this falls into the
    // anonymous-MCP tier, and a permitted_tools.mcp allowlist would then
    // gate (and deny) opencode's core file-editing tool.
    const r = parseMcpToolName('apply_patch', 'opencode', ['github']);
    assert.equal(r.isMcp, false);
    // Also true when a server name happens to prefix it.
    assert.equal(parseMcpToolName('apply_patch', 'opencode', ['apply']).isMcp, false);
  });

  it('leaves other platforms untouched', () => {
    const r = parseMcpToolName('mcp__github__create_issue', 'claude-code');
    assert.equal(r.isMcp, true);
    assert.equal(r.server, 'github');
    assert.equal(r.local, 'create_issue');
  });
});
