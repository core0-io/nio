import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import {
  loadMCPRegistry,
  clearMCPRegistryCache,
} from '../adapters/mcp-registry.js';
import type { NioConfig } from '../adapters/config-schema.js';

let HOME: string;

const emptyConfig = (): NioConfig => ({});

beforeEach(() => {
  HOME = mkdtempSync(join(tmpdir(), 'nio-mcp-registry-'));
  clearMCPRegistryCache();
});

afterEach(() => {
  rmSync(HOME, { recursive: true, force: true });
  clearMCPRegistryCache();
});

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data));
}

function writeYaml(path: string, content: string): void {
  writeFileSync(path, content);
}

describe('loadMCPRegistry: ~/.claude.json (Claude Code)', () => {
  it('parses an HTTP server with url field', () => {
    writeJson(join(HOME, '.claude.json'), {
      mcpServers: {
        hass: { type: 'http', url: 'http://homeassistant.local:8123/api/mcp' },
      },
    });
    const reg = loadMCPRegistry({ home: HOME, configLoader: emptyConfig });
    assert.equal(reg.entries.length, 1);
    const e = reg.entries[0];
    assert.equal(e.serverName, 'hass');
    assert.equal(e.source, 'claude');
    assert.deepEqual(e.urls, ['http://homeassistant.local:8123/api/mcp']);
    assert.deepEqual(e.sockets, []);
  });

  it('parses a stdio server with npx + package', () => {
    writeJson(join(HOME, '.claude.json'), {
      mcpServers: {
        sqlite: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sqlite', '/db.sqlite'] },
      },
    });
    const reg = loadMCPRegistry({ home: HOME, configLoader: emptyConfig });
    const e = reg.entries[0];
    assert.deepEqual(e.binaries, ['npx']);
    assert.deepEqual(e.cliPackages, ['@modelcontextprotocol/server-sqlite']);
  });

  it('parses a stdio server with direct binary path (records basename)', () => {
    writeJson(join(HOME, '.claude.json'), {
      mcpServers: {
        custom: { command: '/usr/local/bin/mcp-server-custom', args: [] },
      },
    });
    const reg = loadMCPRegistry({ home: HOME, configLoader: emptyConfig });
    assert.deepEqual(reg.entries[0].binaries, ['mcp-server-custom']);
  });

  it('parses unix:/sock as a socket, not a url', () => {
    writeJson(join(HOME, '.claude.json'), {
      mcpServers: { sock: { url: 'unix:/tmp/mcp-sock.sock' } },
    });
    const e = loadMCPRegistry({ home: HOME, configLoader: emptyConfig }).entries[0];
    assert.deepEqual(e.urls, []);
    assert.deepEqual(e.sockets, ['/tmp/mcp-sock.sock']);
  });

  it('returns no entries when ~/.claude.json is missing', () => {
    const reg = loadMCPRegistry({ home: HOME, configLoader: emptyConfig });
    assert.equal(reg.entries.length, 0);
  });

  it('returns no entries when ~/.claude.json is malformed', () => {
    writeFileSync(join(HOME, '.claude.json'), '{not valid json');
    const reg = loadMCPRegistry({ home: HOME, configLoader: emptyConfig });
    assert.equal(reg.entries.length, 0);
  });
});

describe('loadMCPRegistry: ~/.hermes/config.yaml', () => {
  it('parses mcp_servers section', () => {
    mkdirSync(join(HOME, '.hermes'));
    writeYaml(join(HOME, '.hermes', 'config.yaml'),
`mcp_servers:
  hass:
    url: http://homeassistant.local:8123/api/mcp
`);
    const reg = loadMCPRegistry({ home: HOME, configLoader: emptyConfig });
    assert.equal(reg.entries.length, 1);
    assert.equal(reg.entries[0].source, 'hermes');
    assert.deepEqual(reg.entries[0].urls, ['http://homeassistant.local:8123/api/mcp']);
  });

  it('returns no entries when mcp_servers section is absent', () => {
    mkdirSync(join(HOME, '.hermes'));
    writeYaml(join(HOME, '.hermes', 'config.yaml'), 'model:\n  default: x\n');
    const reg = loadMCPRegistry({ home: HOME, configLoader: emptyConfig });
    assert.equal(reg.entries.length, 0);
  });
});

describe('loadMCPRegistry: ~/.openclaw/openclaw.json', () => {
  it('parses mcp.servers section', () => {
    mkdirSync(join(HOME, '.openclaw'));
    writeJson(join(HOME, '.openclaw', 'openclaw.json'), {
      mcp: { servers: { hass: { url: 'http://localhost:8123/api/mcp', transport: 'streamable-http' } } },
    });
    const reg = loadMCPRegistry({ home: HOME, configLoader: emptyConfig });
    assert.equal(reg.entries.length, 1);
    assert.equal(reg.entries[0].source, 'openclaw');
  });
});

describe('loadMCPRegistry: Claude Desktop config', () => {
  it('parses macOS Application Support path on darwin', { skip: platform() !== 'darwin' }, () => {
    const dir = join(HOME, 'Library', 'Application Support', 'Claude');
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, 'claude_desktop_config.json'), {
      mcpServers: { fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/'] } },
    });
    const reg = loadMCPRegistry({ home: HOME, configLoader: emptyConfig });
    assert.equal(reg.entries.length, 1);
    assert.equal(reg.entries[0].source, 'claude_desktop');
    assert.deepEqual(reg.entries[0].cliPackages, ['@modelcontextprotocol/server-filesystem']);
  });
});

describe('loadMCPRegistry: manual override (guard.mcp_endpoints)', () => {
  it('declares a server with all four handle types', () => {
    const cfg: NioConfig = {
      guard: {
        mcp_endpoints: {
          hass: {
            urls: ['http://localhost:5173/mcp'],
            sockets: ['/tmp/mcp-hass.sock'],
            binaries: ['mcp-server-hass'],
            cliPackages: ['@hass/mcp-cli'],
          },
        },
      },
    };
    const reg = loadMCPRegistry({ home: HOME, configLoader: () => cfg });
    assert.equal(reg.entries.length, 1);
    const e = reg.entries[0];
    assert.equal(e.source, 'manual');
    assert.deepEqual(e.urls, ['http://localhost:5173/mcp']);
    assert.deepEqual(e.binaries, ['mcp-server-hass']);
    assert.deepEqual(e.cliPackages, ['@hass/mcp-cli']);
    assert.deepEqual(e.sockets, ['/tmp/mcp-hass.sock']);
  });

  it('augments an auto-discovered server with extra handles', () => {
    writeJson(join(HOME, '.claude.json'), {
      mcpServers: { hass: { url: 'http://homeassistant.local:8123/api/mcp' } },
    });
    const cfg: NioConfig = {
      guard: { mcp_endpoints: { hass: { sockets: ['/tmp/extra.sock'] } } },
    };
    const reg = loadMCPRegistry({ home: HOME, configLoader: () => cfg });
    assert.equal(reg.entries.length, 1);
    const e = reg.entries[0];
    assert.equal(e.source, 'manual', 'manual should win attribution');
    assert.deepEqual(e.urls, ['http://homeassistant.local:8123/api/mcp']);
    assert.deepEqual(e.sockets, ['/tmp/extra.sock']);
  });
});

describe('loadMCPRegistry: lookup APIs', () => {
  it('lookupByUrl matches exact URL', () => {
    writeJson(join(HOME, '.claude.json'), {
      mcpServers: { hass: { url: 'http://homeassistant.local:8123/api/mcp' } },
    });
    const reg = loadMCPRegistry({ home: HOME, configLoader: emptyConfig });
    assert.equal(reg.lookupByUrl('http://homeassistant.local:8123/api/mcp')?.serverName, 'hass');
  });

  it('lookupByUrl matches by origin (different path)', () => {
    writeJson(join(HOME, '.claude.json'), {
      mcpServers: { hass: { url: 'http://homeassistant.local:8123/api/mcp' } },
    });
    const reg = loadMCPRegistry({ home: HOME, configLoader: emptyConfig });
    assert.equal(reg.lookupByUrl('http://homeassistant.local:8123/anything-else')?.serverName, 'hass');
  });

  it('lookupByUrl is case-insensitive on host', () => {
    writeJson(join(HOME, '.claude.json'), {
      mcpServers: { hass: { url: 'http://homeassistant.local:8123/api/mcp' } },
    });
    const reg = loadMCPRegistry({ home: HOME, configLoader: emptyConfig });
    assert.equal(reg.lookupByUrl('http://HOMEASSISTANT.LOCAL:8123/api/mcp')?.serverName, 'hass');
  });

  it('lookupByUrl returns null on URL not in registry', () => {
    writeJson(join(HOME, '.claude.json'), {
      mcpServers: { hass: { url: 'http://homeassistant.local:8123/api/mcp' } },
    });
    const reg = loadMCPRegistry({ home: HOME, configLoader: emptyConfig });
    assert.equal(reg.lookupByUrl('http://example.com/'), null);
  });

  it('lookupBySocket matches exact path', () => {
    const cfg: NioConfig = {
      guard: { mcp_endpoints: { x: { sockets: ['/tmp/x.sock'] } } },
    };
    const reg = loadMCPRegistry({ home: HOME, configLoader: () => cfg });
    assert.equal(reg.lookupBySocket('/tmp/x.sock')?.serverName, 'x');
  });

  it('lookupBySocket matches by basename (different dir)', () => {
    const cfg: NioConfig = {
      guard: { mcp_endpoints: { x: { sockets: ['/tmp/x.sock'] } } },
    };
    const reg = loadMCPRegistry({ home: HOME, configLoader: () => cfg });
    assert.equal(reg.lookupBySocket('/run/user/501/x.sock')?.serverName, 'x');
  });

  it('lookupByBinary is case-insensitive and basename-aware', () => {
    writeJson(join(HOME, '.claude.json'), {
      mcpServers: { custom: { command: '/usr/local/bin/mcp-server-custom' } },
    });
    const reg = loadMCPRegistry({ home: HOME, configLoader: emptyConfig });
    assert.equal(reg.lookupByBinary('mcp-server-custom')?.serverName, 'custom');
    assert.equal(reg.lookupByBinary('MCP-Server-Custom')?.serverName, 'custom');
    assert.equal(reg.lookupByBinary('/opt/bin/mcp-server-custom')?.serverName, 'custom');
  });

  it('lookupByCliPackage is case-insensitive', () => {
    writeJson(join(HOME, '.claude.json'), {
      mcpServers: { sqlite: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sqlite'] } },
    });
    const reg = loadMCPRegistry({ home: HOME, configLoader: emptyConfig });
    assert.equal(reg.lookupByCliPackage('@modelcontextprotocol/server-sqlite')?.serverName, 'sqlite');
    assert.equal(reg.lookupByCliPackage('@MODELCONTEXTPROTOCOL/SERVER-SQLITE')?.serverName, 'sqlite');
  });

  it('lookups return null on empty input', () => {
    const cfg: NioConfig = {
      guard: { mcp_endpoints: { x: { urls: ['http://x'] } } },
    };
    const reg = loadMCPRegistry({ home: HOME, configLoader: () => cfg });
    assert.equal(reg.lookupByUrl(''), null);
    assert.equal(reg.lookupBySocket(''), null);
    assert.equal(reg.lookupByBinary(''), null);
    assert.equal(reg.lookupByCliPackage(''), null);
  });
});

describe('loadMCPRegistry: caching & invalidation', () => {
  it('mtime change re-parses the source', async () => {
    const path = join(HOME, '.claude.json');
    writeJson(path, { mcpServers: { a: { url: 'http://a.local/' } } });
    const r1 = loadMCPRegistry({ home: HOME, configLoader: emptyConfig });
    assert.equal(r1.lookupByUrl('http://a.local/')?.serverName, 'a');

    // Bump mtime artificially by waiting a tick + rewriting
    await new Promise((r) => setTimeout(r, 10));
    writeJson(path, { mcpServers: { b: { url: 'http://b.local/' } } });

    const r2 = loadMCPRegistry({ home: HOME, configLoader: emptyConfig });
    assert.equal(r2.lookupByUrl('http://a.local/'), null);
    assert.equal(r2.lookupByUrl('http://b.local/')?.serverName, 'b');
  });

  it('removed source file drops its entries on next load', () => {
    const path = join(HOME, '.claude.json');
    writeJson(path, { mcpServers: { a: { url: 'http://a.local/' } } });
    assert.equal(loadMCPRegistry({ home: HOME, configLoader: emptyConfig }).entries.length, 1);
    rmSync(path);
    assert.equal(loadMCPRegistry({ home: HOME, configLoader: emptyConfig }).entries.length, 0);
  });
});

describe('loadMCPRegistry: cross-source merge', () => {
  it('merges handles from multiple sources for the same server name', () => {
    writeJson(join(HOME, '.claude.json'), {
      mcpServers: { hass: { url: 'http://homeassistant.local:8123/api/mcp' } },
    });
    mkdirSync(join(HOME, '.openclaw'));
    writeJson(join(HOME, '.openclaw', 'openclaw.json'), {
      mcp: { servers: { hass: { url: 'http://homeassistant.local:8123/extra' } } },
    });
    const reg = loadMCPRegistry({ home: HOME, configLoader: emptyConfig });
    assert.equal(reg.entries.length, 1);
    assert.equal(reg.entries[0].urls.length, 2);
  });
});
