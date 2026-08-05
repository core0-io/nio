// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

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
import { trackTempDir } from './helpers/tmp-dirs.js';

let HOME: string;
let originalXdgConfigHome: string | undefined;
let originalPiCodingAgentDir: string | undefined;

const emptyConfig = (): NioConfig => ({});

// `discoverSources` reads XDG_CONFIG_HOME (opencode source) and
// PI_CODING_AGENT_DIR (pi source) unconditionally, on every `describe`
// block in this file, not just the ones that exercise those sources.
// Clearing them only inside the blocks that test them would still leave
// every OTHER block reading the developer's real environment (and, via
// PI_CODING_AGENT_DIR, a real user path) whenever those vars happen to be
// set — a flake source and a violation of test isolation. Clear both here
// file-wide and restore per-test; restore an originally-unset var by
// deleting it, never by assigning the literal string "undefined".
beforeEach(() => {
  HOME = trackTempDir(mkdtempSync(join(tmpdir(), 'nio-mcp-registry-')));
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
  originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  clearMCPRegistryCache();
});

afterEach(() => {
  rmSync(HOME, { recursive: true, force: true });
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
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

describe('loadMCPRegistry: manual override (guard.mcp_servers)', () => {
  it('declares a server with all four handle types', () => {
    const cfg: NioConfig = {
      guard: {
        mcp_servers: {
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
      guard: { mcp_servers: { hass: { sockets: ['/tmp/extra.sock'] } } },
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
      guard: { mcp_servers: { x: { sockets: ['/tmp/x.sock'] } } },
    };
    const reg = loadMCPRegistry({ home: HOME, configLoader: () => cfg });
    assert.equal(reg.lookupBySocket('/tmp/x.sock')?.serverName, 'x');
  });

  it('lookupBySocket matches by basename (different dir)', () => {
    const cfg: NioConfig = {
      guard: { mcp_servers: { x: { sockets: ['/tmp/x.sock'] } } },
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
      guard: { mcp_servers: { x: { urls: ['http://x'] } } },
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

describe('loadMCPRegistry: ~/.config/opencode/opencode.json', () => {
  // XDG_CONFIG_HOME is cleared/restored by the file-level beforeEach/afterEach.

  it('parses local and remote opencode MCP servers and skips disabled ones', () => {
    mkdirSync(join(HOME, '.config', 'opencode'), { recursive: true });
    writeJson(join(HOME, '.config', 'opencode', 'opencode.json'), {
      mcp: {
        github: { type: 'remote', url: 'https://mcp.github.test/sse', enabled: true },
        fs: { type: 'local', command: ['npx', '-y', 'mcp-fs'], enabled: true },
        off: { type: 'local', command: ['npx', 'nope'], enabled: false },
      },
    });

    const reg = loadMCPRegistry({ home: HOME, configLoader: emptyConfig });
    const byName = (n: string) => reg.entries.find(e => e.serverName === n);

    assert.equal(byName('github')?.urls[0], 'https://mcp.github.test/sse');
    assert.equal(byName('github')?.source, 'opencode');
    // Array-form command: argv[0] is the binary, the rest are args, and
    // npx is a package runner so the package name lands in cliPackages.
    assert.deepEqual(byName('fs')?.binaries, ['npx']);
    assert.deepEqual(byName('fs')?.cliPackages, ['mcp-fs']);
    assert.equal(byName('off'), undefined);
  });
});

describe('loadMCPRegistry: enabled:false applies to every source, not just opencode', () => {
  it('skips a disabled server declared in ~/.claude.json', () => {
    writeJson(join(HOME, '.claude.json'), {
      mcpServers: {
        hass: { url: 'http://homeassistant.local:8123/api/mcp', enabled: false },
        active: { url: 'http://active.local/mcp' },
      },
    });
    const reg = loadMCPRegistry({ home: HOME, configLoader: emptyConfig });
    assert.equal(reg.entries.find(e => e.serverName === 'hass'), undefined);
    assert.equal(reg.entries.find(e => e.serverName === 'active')?.serverName, 'active');
  });
});

describe('loadMCPRegistry: ~/.pi/agent/mcp.json (pi-mcp-adapter)', () => {
  // PI_CODING_AGENT_DIR is cleared/restored by the file-level beforeEach/afterEach.

  it('parses a mcpServers map with source "pi"', () => {
    mkdirSync(join(HOME, '.pi', 'agent'), { recursive: true });
    writeJson(join(HOME, '.pi', 'agent', 'mcp.json'), {
      mcpServers: { xcodebuild: { command: 'npx', args: ['-y', 'xcodebuild-mcp'] } },
    });
    const reg = loadMCPRegistry({ home: HOME, configLoader: emptyConfig });
    assert.equal(reg.entries.length, 1);
    assert.equal(reg.entries[0].serverName, 'xcodebuild');
    assert.equal(reg.entries[0].source, 'pi');
    assert.deepEqual(reg.entries[0].cliPackages, ['xcodebuild-mcp']);
  });

  it('falls back to the "mcp-servers" key', () => {
    mkdirSync(join(HOME, '.pi', 'agent'), { recursive: true });
    writeJson(join(HOME, '.pi', 'agent', 'mcp.json'), {
      'mcp-servers': { hass: { url: 'http://homeassistant.local:8123/api/mcp' } },
    });
    const reg = loadMCPRegistry({ home: HOME, configLoader: emptyConfig });
    assert.equal(reg.entries.length, 1);
    assert.equal(reg.entries[0].serverName, 'hass');
    assert.equal(reg.entries[0].source, 'pi');
  });

  it('honours PI_CODING_AGENT_DIR — reads that dir\'s mcp.json, not ~/.pi/agent/mcp.json', () => {
    const altDir = mkdtempSync(join(tmpdir(), 'nio-pi-agent-dir-'));
    try {
      process.env.PI_CODING_AGENT_DIR = altDir;
      writeJson(join(altDir, 'mcp.json'), {
        mcpServers: { alt: { url: 'http://alt.local/mcp' } },
      });
      // A decoy at the default location must NOT be read.
      mkdirSync(join(HOME, '.pi', 'agent'), { recursive: true });
      writeJson(join(HOME, '.pi', 'agent', 'mcp.json'), {
        mcpServers: { decoy: { url: 'http://decoy.local/mcp' } },
      });
      const reg = loadMCPRegistry({ home: HOME, configLoader: emptyConfig });
      assert.equal(reg.entries.length, 1);
      assert.equal(reg.entries[0].serverName, 'alt');
    } finally {
      rmSync(altDir, { recursive: true, force: true });
    }
  });

  it('expands a leading ~ in PI_CODING_AGENT_DIR against home, not literally', () => {
    process.env.PI_CODING_AGENT_DIR = '~/custom-pi-dir';
    mkdirSync(join(HOME, 'custom-pi-dir'), { recursive: true });
    writeJson(join(HOME, 'custom-pi-dir', 'mcp.json'), {
      mcpServers: { tilde: { url: 'http://tilde.local/mcp' } },
    });
    const reg = loadMCPRegistry({ home: HOME, configLoader: emptyConfig });
    assert.equal(reg.entries.length, 1);
    assert.equal(reg.entries[0].serverName, 'tilde');
  });

  it('absent mcp.json contributes no entries and does not throw', () => {
    assert.doesNotThrow(() => {
      const reg = loadMCPRegistry({ home: HOME, configLoader: emptyConfig });
      assert.equal(reg.entries.length, 0);
    });
  });

  it('malformed mcp.json contributes no entries and does not throw', () => {
    mkdirSync(join(HOME, '.pi', 'agent'), { recursive: true });
    writeFileSync(join(HOME, '.pi', 'agent', 'mcp.json'), '{not valid json');
    assert.doesNotThrow(() => {
      const reg = loadMCPRegistry({ home: HOME, configLoader: emptyConfig });
      assert.equal(reg.entries.length, 0);
    });
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
