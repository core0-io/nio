import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMcpToolName } from '../adapters/hook-engine.js';

describe('parseMcpToolName: Claude Code', () => {
  it('parses mcp__server__tool', () => {
    const r = parseMcpToolName('mcp__hass__HassTurnOn', 'claude-code');
    assert.deepEqual(r, { isMcp: true, server: 'hass', local: 'HassTurnOn' });
  });

  it('parses mcp__server__tool with underscores in tool', () => {
    const r = parseMcpToolName('mcp__github__create_issue', 'claude-code');
    assert.deepEqual(r, { isMcp: true, server: 'github', local: 'create_issue' });
  });

  it('does not parse native CC tool names', () => {
    assert.deepEqual(parseMcpToolName('Bash', 'claude-code'), { isMcp: false });
    assert.deepEqual(parseMcpToolName('WebFetch', 'claude-code'), { isMcp: false });
  });

  it('rejects malformed mcp__ strings', () => {
    assert.deepEqual(parseMcpToolName('mcp__hass', 'claude-code'), { isMcp: false });
    assert.deepEqual(parseMcpToolName('mcp__hass__', 'claude-code'), { isMcp: false });
    assert.deepEqual(parseMcpToolName('mcp__', 'claude-code'), { isMcp: false });
  });
});

describe('parseMcpToolName: OpenClaw', () => {
  it('parses server__tool', () => {
    const r = parseMcpToolName('hass__HassTurnOn', 'openclaw');
    assert.deepEqual(r, { isMcp: true, server: 'hass', local: 'HassTurnOn' });
  });

  it('treats the first __ as the separator', () => {
    const r = parseMcpToolName('srv__some__deep_tool', 'openclaw');
    assert.deepEqual(r, { isMcp: true, server: 'srv', local: 'some__deep_tool' });
  });

  it('does not parse native OpenClaw tool names', () => {
    for (const name of ['bash', 'write', 'edit', 'read', 'exec', 'web_fetch', 'browser']) {
      assert.deepEqual(parseMcpToolName(name, 'openclaw'), { isMcp: false }, name);
    }
  });

  it('rejects trailing __ with no tool part', () => {
    assert.deepEqual(parseMcpToolName('hass__', 'openclaw'), { isMcp: false });
  });
});

describe('parseMcpToolName: miscellaneous', () => {
  it('returns isMcp:false for unknown platforms', () => {
    assert.deepEqual(parseMcpToolName('mcp__hass__HassTurnOn', 'other'), { isMcp: false });
  });

  it('tolerates empty / nullish input', () => {
    assert.deepEqual(parseMcpToolName('', 'claude-code'), { isMcp: false });
    assert.deepEqual(parseMcpToolName('', 'openclaw'), { isMcp: false });
    // @ts-expect-error — runtime should not throw when name is undefined-ish
    assert.deepEqual(parseMcpToolName(undefined, 'openclaw'), { isMcp: false });
  });
});
