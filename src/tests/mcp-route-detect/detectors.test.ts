import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectMcpCalls } from '../../adapters/mcp-route-detect/index.js';

describe('detectMcpCalls: D1 mcporter (parity coverage via the new API)', () => {
  it('matches `mcporter call server.tool`', () => {
    const calls = detectMcpCalls('mcporter call hass.HassTurnOff');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].server, 'hass');
    assert.equal(calls[0].tool, 'HassTurnOff');
    assert.equal(calls[0].via, 'mcporter');
  });

  it('matches shorthand without `call`', () => {
    const calls = detectMcpCalls('mcporter hass.HassTurnOff');
    assert.equal(calls[0].tool, 'HassTurnOff');
  });

  it('matches via npx / bunx prefixes', () => {
    assert.equal(detectMcpCalls('npx mcporter call hass.HassTurnOff')[0].server, 'hass');
    assert.equal(detectMcpCalls('bunx mcporter hass.HassTurnOff')[0].server, 'hass');
  });

  it('skips flag + value (space-separated)', () => {
    const calls = detectMcpCalls('mcporter --config x.json call hass.HassTurnOff');
    assert.equal(calls[0].tool, 'HassTurnOff');
  });

  it('skips flag=value', () => {
    const calls = detectMcpCalls('mcporter --config=x.json call hass.HassTurnOff');
    assert.equal(calls[0].tool, 'HassTurnOff');
  });

  it('handles function-call syntax', () => {
    const calls = detectMcpCalls(`mcporter 'hass.HassTurnOff(area: "x")'`);
    assert.equal(calls[0].tool, 'HassTurnOff');
  });

  it('handles absolute path to mcporter', () => {
    const calls = detectMcpCalls('/usr/local/bin/mcporter hass.HassTurnOff');
    assert.equal(calls[0].tool, 'HassTurnOff');
  });

  it('handles mcporter after a shell separator', () => {
    const calls = detectMcpCalls('cd x && mcporter call hass.HassTurnOff');
    assert.equal(calls[0].tool, 'HassTurnOff');
  });

  it('extracts every mcporter invocation when chained with semicolons', () => {
    const calls = detectMcpCalls('mcporter call a.b; mcporter call c.d');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].server, 'a');
    assert.equal(calls[1].server, 'c');
  });

  it('handles mcporter in a pipeline', () => {
    const calls = detectMcpCalls('mcporter call a.b | grep x');
    assert.equal(calls[0].server, 'a');
    assert.equal(calls[0].tool, 'b');
  });

  it('returns [] for commands without mcporter', () => {
    assert.deepEqual(detectMcpCalls('echo hello'), []);
    assert.deepEqual(detectMcpCalls('curl https://example.com'), []);
  });

  it('does not match mcporter as a substring of another identifier', () => {
    assert.deepEqual(detectMcpCalls('my_mcporter_wrapper --call hass.HassTurnOff'), []);
    assert.deepEqual(detectMcpCalls('notmcporter hass.HassTurnOff'), []);
  });

  it('returns [] when mcporter has no resolvable target', () => {
    assert.deepEqual(detectMcpCalls('mcporter'), []);
    assert.deepEqual(detectMcpCalls('mcporter --help'), []);
    assert.deepEqual(detectMcpCalls('mcporter call'), []);
  });

  it('captures evidence and via tag for audit', () => {
    const calls = detectMcpCalls('mcporter call hass.HassTurnOff');
    assert.equal(calls[0].via, 'mcporter');
    assert.match(calls[0].evidence, /hass\.HassTurnOff/);
  });
});
