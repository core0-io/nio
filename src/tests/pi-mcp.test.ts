// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMcpToolName } from '../adapters/hook-engine.js';
import { PI_BUILTIN_TOOLS } from '../adapters/pi.js';

describe('parseMcpToolName — pi (proxy tool `mcp`)', () => {
  it('attributes the target via `tool` + `server`, empty registry', () => {
    const r = parseMcpToolName('mcp', 'pi', [], { tool: 'list_sims', server: 'xcodebuild' });
    assert.equal(r.isMcp, true);
    assert.equal(r.server, 'xcodebuild');
    assert.equal(r.local, 'list_sims');
  });

  it('leaves server undefined when absent', () => {
    const r = parseMcpToolName('mcp', 'pi', [], { tool: 'list_sims' });
    assert.equal(r.isMcp, true);
    assert.equal(r.server, undefined);
    assert.equal(r.local, 'list_sims');
  });

  it('trims the tool name', () => {
    const r = parseMcpToolName('mcp', 'pi', [], { tool: '  list_sims  ' });
    assert.equal(r.isMcp, true);
    assert.equal(r.local, 'list_sims');
  });

  it('targetless discovery mode (action: connect) gates by name `mcp`', () => {
    const r = parseMcpToolName('mcp', 'pi', [], { action: 'connect' });
    assert.equal(r.isMcp, true);
    assert.equal(r.local, 'mcp');
    assert.equal(r.server, undefined);
  });

  it('no toolInput at all — same targetless result, no throw', () => {
    const r = parseMcpToolName('mcp', 'pi', []);
    assert.equal(r.isMcp, true);
    assert.equal(r.local, 'mcp');
  });

  it('non-string `tool` value is treated as targetless, no throw', () => {
    const r = parseMcpToolName('mcp', 'pi', [], { tool: 42 });
    assert.equal(r.isMcp, true);
    assert.equal(r.local, 'mcp');
  });
});

describe('parseMcpToolName — pi (direct tools, directTools: true)', () => {
  it('attributes a `<server>_<tool>` name to a known server', () => {
    const r = parseMcpToolName('xcodebuild_list_sims', 'pi', ['xcodebuild']);
    assert.equal(r.isMcp, true);
    assert.equal(r.server, 'xcodebuild');
    assert.equal(r.local, 'list_sims');
  });

  it('prefers the longest matching server prefix', () => {
    const r = parseMcpToolName('my_server_search', 'pi', ['my', 'my_server']);
    assert.equal(r.isMcp, true);
    assert.equal(r.server, 'my_server');
    assert.equal(r.local, 'search');
  });

  it('strips the `mcp__` prefix before attribution', () => {
    const r = parseMcpToolName('mcp__xcodebuild_list_sims', 'pi', ['xcodebuild']);
    assert.equal(r.isMcp, true);
    assert.equal(r.server, 'xcodebuild');
    assert.equal(r.local, 'list_sims');
  });

  it('unattributable `mcp__` name stays anonymous with the full name preserved', () => {
    const r = parseMcpToolName('mcp__unknown_tool', 'pi', ['xcodebuild']);
    assert.equal(r.isMcp, true);
    assert.equal(r.server, undefined);
    assert.equal(r.local, 'mcp__unknown_tool');
  });

  it('unprefixed unattributable underscored name is NOT claimed as MCP (asymmetry with opencode)', () => {
    const r = parseMcpToolName('some_other_tool', 'pi', ['xcodebuild']);
    assert.equal(r.isMcp, false);
  });

  it('empty or omitted registry never yields MCP for a direct-tool-shaped name', () => {
    assert.equal(parseMcpToolName('xcodebuild_list_sims', 'pi', []).isMcp, false);
    assert.equal(parseMcpToolName('xcodebuild_list_sims', 'pi').isMcp, false);
  });

  it('empty registry still claims the explicit `mcp__` form anonymously', () => {
    // pi-mcp-adapter also probes ~/.config/mcp/mcp.json and ~/.agents/**,
    // which mcp-registry.ts deliberately does not register as `source:
    // 'pi'`. A user configured only there has an EMPTY registry, and
    // mcp-registry.ts's own comment promises those servers' tools "reach
    // the anonymous fallback tier and are gateable by full name" — which
    // only holds if the `mcp__` claim runs BEFORE the registry bail-out.
    for (const servers of [[], undefined]) {
      const r = parseMcpToolName('mcp__weather_forecast', 'pi', servers);
      assert.equal(r.isMcp, true);
      assert.equal(r.server, undefined);
      assert.equal(r.local, 'mcp__weather_forecast');
    }
  });

  it('built-ins are never MCP, even with a registry configured', () => {
    for (const name of PI_BUILTIN_TOOLS) {
      assert.equal(parseMcpToolName(name, 'pi', ['xcodebuild']).isMcp, false, name);
    }
  });

  it('a built-in name is never claimed as MCP even when a server prefix-matches it', () => {
    // NOTE: this does NOT prove the PI_BUILTIN_TOOLS.has(name) guard at
    // hook-engine.ts runs before attribution — it can't, because "grep"
    // contains no underscore and is already rejected by the earlier
    // `!body.includes('_')` check regardless of that guard. The
    // PI_BUILTIN_TOOLS guard is unreachable-by-construction defensive code
    // today (see the doc comment on PI_BUILTIN_TOOLS in pi.ts: none of the
    // seven built-ins contains an underscore), kept for a future built-in
    // that does. This test only pins the observable outcome.
    const r = parseMcpToolName('grep', 'pi', ['gr']);
    assert.equal(r.isMcp, false);
  });
});

describe('parseMcpToolName — pi cross-platform non-regression', () => {
  it('opencode does not take the pi proxy-tool path', () => {
    // If the pi branch ran, this would resolve to { isMcp: true, local: 'y' }
    // via toolInput.tool. opencode's own branch treats bare `mcp` (no
    // underscore) as a non-MCP native tool instead.
    const r = parseMcpToolName('mcp', 'opencode', ['x'], { tool: 'y' });
    assert.equal(r.isMcp, false);
    assert.equal(r.local, undefined);
  });
});
