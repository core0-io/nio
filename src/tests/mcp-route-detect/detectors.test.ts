import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectMcpCalls } from '../../adapters/mcp-route-detect/index.js';
import type { MCPRegistry, MCPServerEntry } from '../../adapters/mcp-registry.js';

// Helper: build an in-memory registry without touching disk.
function fakeRegistry(entries: Partial<MCPServerEntry>[]): MCPRegistry {
  const full: MCPServerEntry[] = entries.map((e) => ({
    serverName: e.serverName ?? 'x',
    urls: e.urls ?? [],
    sockets: e.sockets ?? [],
    binaries: e.binaries ?? [],
    cliPackages: e.cliPackages ?? [],
    source: e.source ?? 'manual',
  }));
  const norm = (u: string) => {
    try { const p = new URL(u); p.host = p.host.toLowerCase(); return p.toString().replace(/\/$/, ''); }
    catch { return u.toLowerCase(); }
  };
  const lookupByUrl = (u: string) => {
    if (!u) return null;
    const tNorm = norm(u);
    for (const e of full) {
      for (const ru of e.urls) {
        if (norm(ru) === tNorm) return e;
        try {
          const a = new URL(u); const b = new URL(ru);
          if (a.protocol === b.protocol && a.host.toLowerCase() === b.host.toLowerCase()) return e;
        } catch { /* ignore */ }
      }
    }
    return null;
  };
  const lookupBySocket = (p: string) => {
    if (!p) return null;
    for (const e of full) for (const s of e.sockets) {
      if (s === p || s.endsWith('/' + p) || p.endsWith('/' + s)) return e;
    }
    return null;
  };
  const lookupByBinary = (n: string) => {
    if (!n) return null;
    const target = (n.split('/').pop() ?? n).toLowerCase();
    for (const e of full) for (const b of e.binaries) {
      if ((b.split('/').pop() ?? b).toLowerCase() === target) return e;
    }
    return null;
  };
  const lookupByCliPackage = (pkg: string) => {
    if (!pkg) return null;
    for (const e of full) for (const c of e.cliPackages) {
      if (c.toLowerCase() === pkg.toLowerCase()) return e;
    }
    return null;
  };
  return { entries: full, lookupByUrl, lookupBySocket, lookupByBinary, lookupByCliPackage };
}

const HASS_REG = fakeRegistry([{
  serverName: 'hass',
  urls: ['http://localhost:5173/mcp', 'http://homeassistant.local:8123/api/mcp'],
  sockets: ['/tmp/mcp-hass.sock'],
  binaries: ['mcp-server-hass', 'hass-mcp'],
  cliPackages: ['@hass/mcp-cli'],
}]);

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

describe('detectMcpCalls: D2 curl-class HTTP clients', () => {
  it('matches curl POSTing to a registry URL with JSON-RPC body', () => {
    const cmd = `curl -X POST http://localhost:5173/mcp -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"HassTurnOff"}}'`;
    const calls = detectMcpCalls(cmd, HASS_REG);
    const hit = calls.find((c) => c.via === 'http_client');
    assert.ok(hit);
    assert.equal(hit!.server, 'hass');
    assert.equal(hit!.tool, 'HassTurnOff');
  });

  it('matches wget --post-data targeting a registry URL', () => {
    const cmd = `wget --post-data='{"params":{"name":"HassTurnOff"}}' http://localhost:5173/mcp`;
    const calls = detectMcpCalls(cmd, HASS_REG);
    const hit = calls.find((c) => c.via === 'http_client');
    assert.ok(hit);
    assert.equal(hit!.tool, 'HassTurnOff');
  });

  it('matches curl --unix-socket targeting a registry socket', () => {
    const cmd = `curl --unix-socket /tmp/mcp-hass.sock http://localhost/mcp`;
    const calls = detectMcpCalls(cmd, HASS_REG);
    const hit = calls.find((c) => c.via === 'http_client');
    assert.ok(hit);
    assert.equal(hit!.server, 'hass');
  });

  it('does NOT match curl to a non-registry URL', () => {
    const cmd = `curl http://example.com/anything`;
    const calls = detectMcpCalls(cmd, HASS_REG);
    assert.equal(calls.filter((c) => c.via === 'http_client').length, 0);
  });
});

describe('detectMcpCalls: D3 HTTPie-class', () => {
  it('matches `http POST <url>` with name field', () => {
    const cmd = `http POST http://localhost:5173/mcp method=tools/call name:='"HassTurnOff"'`;
    const calls = detectMcpCalls(cmd, HASS_REG);
    const hit = calls.find((c) => c.via === 'httpie');
    assert.ok(hit);
    assert.equal(hit!.server, 'hass');
  });

  it('matches `xh <url>`', () => {
    const cmd = `xh http://localhost:5173/mcp`;
    const calls = detectMcpCalls(cmd, HASS_REG);
    assert.ok(calls.find((c) => c.via === 'httpie'));
  });

  it('does NOT match non-registry URL', () => {
    const cmd = `http POST http://api.openai.com/v1/chat`;
    const calls = detectMcpCalls(cmd, HASS_REG);
    assert.equal(calls.filter((c) => c.via === 'httpie').length, 0);
  });
});

describe('detectMcpCalls: D4 TCP / socket multiplex', () => {
  it('matches `nc localhost 5173`', () => {
    const cmd = `echo '{}' | nc localhost 5173`;
    const calls = detectMcpCalls(cmd, HASS_REG);
    assert.ok(calls.find((c) => c.via === 'tcp_socket' && c.server === 'hass'));
  });

  it('matches `socat - TCP:localhost:5173`', () => {
    const cmd = `socat - TCP:localhost:5173`;
    const calls = detectMcpCalls(cmd, HASS_REG);
    assert.ok(calls.find((c) => c.via === 'tcp_socket' && c.server === 'hass'));
  });

  it('matches `socat - UNIX-CONNECT:/tmp/mcp-hass.sock`', () => {
    const cmd = `socat - UNIX-CONNECT:/tmp/mcp-hass.sock`;
    const calls = detectMcpCalls(cmd, HASS_REG);
    assert.ok(calls.find((c) => c.via === 'tcp_socket' && c.server === 'hass'));
  });

  it('matches `openssl s_client -connect host:port`', () => {
    const cmd = `openssl s_client -connect localhost:5173`;
    const calls = detectMcpCalls(cmd, HASS_REG);
    assert.ok(calls.find((c) => c.via === 'tcp_socket' && c.server === 'hass'));
  });
});

describe('detectMcpCalls: D5 Bash builtin networking', () => {
  it('matches `/dev/tcp/host/port` against registry', () => {
    const cmd = `exec 3<>/dev/tcp/localhost/5173`;
    const calls = detectMcpCalls(cmd, HASS_REG);
    assert.ok(calls.find((c) => c.via === 'dev_tcp' && c.server === 'hass'));
  });

  it('matches `/dev/udp/host/port`', () => {
    const cmd = `cat /dev/udp/localhost/5173`;
    const calls = detectMcpCalls(cmd, HASS_REG);
    assert.ok(calls.find((c) => c.via === 'dev_tcp' && c.server === 'hass'));
  });

  it('does NOT match non-registry host:port', () => {
    const cmd = `exec 3<>/dev/tcp/example.com/443`;
    const calls = detectMcpCalls(cmd, HASS_REG);
    assert.equal(calls.filter((c) => c.via === 'dev_tcp').length, 0);
  });
});

describe('detectMcpCalls: D6 PowerShell HTTP', () => {
  it('matches Invoke-RestMethod targeting a registry URL', () => {
    const cmd = `pwsh -Command "Invoke-RestMethod -Uri http://localhost:5173/mcp -Method Post"`;
    const calls = detectMcpCalls(cmd, HASS_REG);
    assert.ok(calls.find((c) => c.via === 'pwsh_http' && c.server === 'hass'));
  });

  it('matches Invoke-WebRequest with hass URL', () => {
    const cmd = `Invoke-WebRequest http://localhost:5173/mcp/tools/call`;
    const calls = detectMcpCalls(cmd, HASS_REG);
    assert.ok(calls.find((c) => c.via === 'pwsh_http' && c.server === 'hass'));
  });

  it('does not match Invoke-RestMethod with non-registry URL', () => {
    const cmd = `Invoke-RestMethod http://example.com/foo`;
    const calls = detectMcpCalls(cmd, HASS_REG);
    assert.equal(calls.filter((c) => c.via === 'pwsh_http').length, 0);
  });
});

describe('detectMcpCalls: D7 Language-runtime HTTP', () => {
  it('matches python -c with urllib hitting a registry URL', () => {
    const cmd = `python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:5173/mcp')"`;
    const calls = detectMcpCalls(cmd, HASS_REG);
    assert.ok(calls.find((c) => c.via === 'language_runtime' && c.server === 'hass'));
  });

  it('matches node -e with fetch', () => {
    const cmd = `node -e "fetch('http://localhost:5173/mcp', {method:'POST'})"`;
    const calls = detectMcpCalls(cmd, HASS_REG);
    assert.ok(calls.find((c) => c.via === 'language_runtime' && c.server === 'hass'));
  });

  it('matches ruby -e with Net::HTTP', () => {
    const cmd = `ruby -e "require 'net/http'; Net::HTTP.get(URI('http://localhost:5173/mcp'))"`;
    const calls = detectMcpCalls(cmd, HASS_REG);
    assert.ok(calls.find((c) => c.via === 'language_runtime'));
  });

  it('matches bun -e with fetch on registry host:port', () => {
    const cmd = `bun -e "await fetch('http://localhost:5173/mcp')"`;
    const calls = detectMcpCalls(cmd, HASS_REG);
    assert.ok(calls.find((c) => c.via === 'language_runtime'));
  });

  it('does NOT match runtime call to non-registry URL', () => {
    const cmd = `python3 -c "import urllib.request; urllib.request.urlopen('http://example.com')"`;
    const calls = detectMcpCalls(cmd, HASS_REG);
    assert.equal(calls.filter((c) => c.via === 'language_runtime').length, 0);
  });
});
