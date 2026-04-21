import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractMcpCallsFromCommand,
  extractCommandString,
} from '../adapters/mcp-shell-detect.js';

describe('extractMcpCallsFromCommand: canonical shapes', () => {
  it('parses `mcporter call server.tool`', () => {
    assert.deepEqual(
      extractMcpCallsFromCommand('mcporter call hass.HassTurnOff'),
      [{ server: 'hass', local: 'HassTurnOff' }],
    );
  });

  it('parses shorthand without `call`', () => {
    assert.deepEqual(
      extractMcpCallsFromCommand('mcporter hass.HassTurnOff'),
      [{ server: 'hass', local: 'HassTurnOff' }],
    );
  });

  it('handles npx / bunx prefixes', () => {
    assert.deepEqual(
      extractMcpCallsFromCommand('npx mcporter call hass.HassTurnOff'),
      [{ server: 'hass', local: 'HassTurnOff' }],
    );
    assert.deepEqual(
      extractMcpCallsFromCommand('bunx mcporter hass.HassTurnOff'),
      [{ server: 'hass', local: 'HassTurnOff' }],
    );
  });

  it('skips flag + value (space-separated)', () => {
    assert.deepEqual(
      extractMcpCallsFromCommand('mcporter --config x.json call hass.HassTurnOff'),
      [{ server: 'hass', local: 'HassTurnOff' }],
    );
  });

  it('skips flag=value (= joined)', () => {
    assert.deepEqual(
      extractMcpCallsFromCommand('mcporter --config=x.json call hass.HassTurnOff'),
      [{ server: 'hass', local: 'HassTurnOff' }],
    );
  });

  it('handles function-call syntax with quotes', () => {
    assert.deepEqual(
      extractMcpCallsFromCommand(`mcporter 'hass.HassTurnOff(area: "x")'`),
      [{ server: 'hass', local: 'HassTurnOff' }],
    );
  });

  it('handles path-qualified binary', () => {
    assert.deepEqual(
      extractMcpCallsFromCommand('/usr/local/bin/mcporter hass.HassTurnOff'),
      [{ server: 'hass', local: 'HassTurnOff' }],
    );
  });

  it('handles mcporter after a shell separator', () => {
    assert.deepEqual(
      extractMcpCallsFromCommand('cd x && mcporter call hass.HassTurnOff'),
      [{ server: 'hass', local: 'HassTurnOff' }],
    );
  });
});

describe('extractMcpCallsFromCommand: multiple and chained', () => {
  it('extracts every hit in a chained command', () => {
    assert.deepEqual(
      extractMcpCallsFromCommand('mcporter call a.b; mcporter call c.d'),
      [
        { server: 'a', local: 'b' },
        { server: 'c', local: 'd' },
      ],
    );
  });

  it('stops each segment at the next shell separator', () => {
    assert.deepEqual(
      extractMcpCallsFromCommand('mcporter call a.b | grep x'),
      [{ server: 'a', local: 'b' }],
    );
  });

  it('handles newline-separated invocations', () => {
    assert.deepEqual(
      extractMcpCallsFromCommand('mcporter call a.b\nmcporter call c.d'),
      [
        { server: 'a', local: 'b' },
        { server: 'c', local: 'd' },
      ],
    );
  });
});

describe('extractMcpCallsFromCommand: negatives', () => {
  it('returns [] for commands without mcporter', () => {
    assert.deepEqual(extractMcpCallsFromCommand('echo hello'), []);
    assert.deepEqual(extractMcpCallsFromCommand('grep HassTurnOff /tmp/x'), []);
  });

  it('does not match mcporter as a substring of another identifier', () => {
    assert.deepEqual(
      extractMcpCallsFromCommand('my_mcporter_wrapper --call hass.HassTurnOff'),
      [],
    );
    assert.deepEqual(
      extractMcpCallsFromCommand('notmcporter hass.HassTurnOff'),
      [],
    );
  });

  it('handles empty / nullish input', () => {
    assert.deepEqual(extractMcpCallsFromCommand(''), []);
    // @ts-expect-error — runtime should not throw on undefined
    assert.deepEqual(extractMcpCallsFromCommand(undefined), []);
  });

  it('returns [] when mcporter has no target', () => {
    assert.deepEqual(extractMcpCallsFromCommand('mcporter'), []);
    assert.deepEqual(extractMcpCallsFromCommand('mcporter --help'), []);
    assert.deepEqual(extractMcpCallsFromCommand('mcporter call'), []);
  });

  it('returns [] for malformed targets (missing tool part)', () => {
    assert.deepEqual(extractMcpCallsFromCommand('mcporter call hass.'), []);
    assert.deepEqual(extractMcpCallsFromCommand('mcporter call hass'), []);
  });
});

describe('extractCommandString', () => {
  it('pulls string command field', () => {
    assert.equal(
      extractCommandString({ command: 'echo hi' }),
      'echo hi',
    );
  });

  it('joins command and args array', () => {
    assert.equal(
      extractCommandString({ command: 'mcporter', args: ['call', 'hass.HassTurnOff'] }),
      'mcporter call hass.HassTurnOff',
    );
  });

  it('ignores non-string args', () => {
    assert.equal(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      extractCommandString({ command: 'x', args: ['a', 42 as any, null, 'b'] } as Record<string, unknown>),
      'x a b',
    );
  });

  it('returns "" for undefined / missing fields', () => {
    assert.equal(extractCommandString(undefined), '');
    assert.equal(extractCommandString({}), '');
    assert.equal(extractCommandString({ command: 42 } as Record<string, unknown>), '');
  });
});
