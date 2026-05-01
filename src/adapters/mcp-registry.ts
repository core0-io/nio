// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * MCP server registry.
 *
 * Discovers configured MCP servers from known config files (Claude Code,
 * Claude Desktop, Hermes, OpenClaw) plus manual overrides in
 * `~/.nio/config.yaml` `guard.mcp_servers`. Each registered server is
 * indexed by every reachable handle (URL, unix socket, server binary,
 * CLI package) so downstream detectors can map an indirect shell-side
 * invocation back to the server name and re-apply the existing
 * `permitted_tools.mcp` / `blocked_tools.mcp` allowlist.
 *
 * Caching: per-source file mtime. `loadMCPRegistry()` checks each source's
 * mtime on every call and only re-parses changed sources.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { loadConfig } from './common.js';
import type { NioConfig } from './config-schema.js';

export type MCPSource = 'claude' | 'claude_desktop' | 'hermes' | 'openclaw' | 'manual';

export interface MCPServerEntry {
  serverName: string;
  urls: string[];
  sockets: string[];
  binaries: string[];
  cliPackages: string[];
  source: MCPSource;
}

export interface MCPRegistry {
  entries: ReadonlyArray<MCPServerEntry>;
  lookupByUrl(url: string): MCPServerEntry | null;
  lookupBySocket(path: string): MCPServerEntry | null;
  lookupByBinary(name: string): MCPServerEntry | null;
  lookupByCliPackage(pkg: string): MCPServerEntry | null;
}

// ---------------------------------------------------------------------------
// Source discovery
// ---------------------------------------------------------------------------

interface SourceDescriptor {
  path: string;
  source: MCPSource;
  format: 'json' | 'yaml';
  parse: (parsed: unknown) => Record<string, unknown> | null;
}

function claudeDesktopConfigPath(home: string): string | null {
  switch (platform()) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    case 'win32': {
      const appdata = process.env.APPDATA;
      return appdata ? join(appdata, 'Claude', 'claude_desktop_config.json') : null;
    }
    default: {
      const xdg = process.env.XDG_CONFIG_HOME || join(home, '.config');
      return join(xdg, 'Claude', 'claude_desktop_config.json');
    }
  }
}

function discoverSources(home: string): SourceDescriptor[] {
  const sources: SourceDescriptor[] = [];

  sources.push({
    path: join(home, '.claude.json'),
    source: 'claude',
    format: 'json',
    parse: (data) => extractFromMcpServers(data, ['mcpServers']),
  });

  const desktopPath = claudeDesktopConfigPath(home);
  if (desktopPath) {
    sources.push({
      path: desktopPath,
      source: 'claude_desktop',
      format: 'json',
      parse: (data) => extractFromMcpServers(data, ['mcpServers']),
    });
  }

  sources.push({
    path: join(home, '.hermes', 'config.yaml'),
    source: 'hermes',
    format: 'yaml',
    parse: (data) => extractFromMcpServers(data, ['mcp_servers']),
  });

  sources.push({
    path: join(home, '.openclaw', 'openclaw.json'),
    source: 'openclaw',
    format: 'json',
    parse: (data) => extractFromMcpServers(data, ['mcp', 'servers']),
  });

  return sources;
}

function extractFromMcpServers(data: unknown, path: string[]): Record<string, unknown> | null {
  let cur: unknown = data;
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  if (!cur || typeof cur !== 'object') return null;
  return cur as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Per-server entry parsing
// ---------------------------------------------------------------------------

const PACKAGE_RUNNERS = new Set([
  'npx', 'bunx', 'pnpm', 'yarn', 'pipx', 'uv', 'uvx', 'deno',
]);

/**
 * Parse one server config block (Claude / Claude Desktop / Hermes / OpenClaw
 * all share the same shape: a record under their respective key).
 *
 * Supported fields:
 *  - `url` / `endpoint` → urls (with `unix:/path` rerouted to sockets)
 *  - `socket` → sockets
 *  - `command` → binaries (basename) or, when it's a package runner,
 *    `args[0]` becomes a cliPackage and the runner itself is recorded as a
 *    binary
 *  - `args` → for package runners, scan for the package name
 */
function parseServerBlock(serverName: string, block: unknown, source: MCPSource): MCPServerEntry {
  const entry: MCPServerEntry = {
    serverName,
    urls: [],
    sockets: [],
    binaries: [],
    cliPackages: [],
    source,
  };

  if (!block || typeof block !== 'object') return entry;
  const b = block as Record<string, unknown>;

  // url / endpoint → urls or sockets (unix: prefix)
  for (const key of ['url', 'endpoint']) {
    const v = b[key];
    if (typeof v === 'string' && v.length > 0) {
      if (v.startsWith('unix:')) {
        entry.sockets.push(v.slice(5));
      } else {
        entry.urls.push(v);
      }
    }
  }

  // socket / sockets → sockets
  const sock = b['socket'];
  if (typeof sock === 'string' && sock.length > 0) entry.sockets.push(sock);
  const socks = b['sockets'];
  if (Array.isArray(socks)) {
    for (const s of socks) if (typeof s === 'string') entry.sockets.push(s);
  }

  // command → binaries / cliPackages depending on whether it's a runner
  const cmd = b['command'];
  const args = b['args'];
  if (typeof cmd === 'string' && cmd.length > 0) {
    const cmdBase = basename(cmd);
    entry.binaries.push(cmdBase);
    if (PACKAGE_RUNNERS.has(cmdBase) && Array.isArray(args)) {
      const pkg = firstPackageArg(args as unknown[]);
      if (pkg) entry.cliPackages.push(pkg);
    }
  }

  return entry;
}

/**
 * Pull the first non-flag argument from a package-runner arg list.
 * Skips the conventional `-y` / `--yes` / `--package=...` style flags.
 */
function firstPackageArg(args: unknown[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string') continue;
    if (a.startsWith('-')) {
      // `--key=value` or `-y` — both consume only this token. Conservative:
      // do not reach into the next token, since detector-side resolution
      // handles ambiguity gracefully.
      continue;
    }
    return a;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

interface CacheEntry {
  mtimeMs: number;
  entries: MCPServerEntry[];
}

const sourceCache = new Map<string, CacheEntry>();

function loadFromSource(desc: SourceDescriptor): MCPServerEntry[] {
  if (!existsSync(desc.path)) {
    sourceCache.delete(desc.path);
    return [];
  }

  let mtimeMs: number;
  try {
    mtimeMs = statSync(desc.path).mtimeMs;
  } catch {
    return [];
  }

  const cached = sourceCache.get(desc.path);
  if (cached && cached.mtimeMs === mtimeMs) return cached.entries;

  let parsed: unknown;
  try {
    const raw = readFileSync(desc.path, 'utf-8');
    parsed = desc.format === 'json' ? JSON.parse(raw) : yamlLoad(raw);
  } catch {
    // Conservative: a malformed source contributes zero entries; downstream
    // discovery continues with the remaining sources.
    sourceCache.set(desc.path, { mtimeMs, entries: [] });
    return [];
  }

  const servers = desc.parse(parsed);
  if (!servers) {
    sourceCache.set(desc.path, { mtimeMs, entries: [] });
    return [];
  }

  const entries: MCPServerEntry[] = [];
  for (const [name, block] of Object.entries(servers)) {
    if (!name) continue;
    entries.push(parseServerBlock(name, block, desc.source));
  }
  sourceCache.set(desc.path, { mtimeMs, entries });
  return entries;
}

function loadManualOverride(configLoader: () => NioConfig): MCPServerEntry[] {
  let cfg: NioConfig;
  try {
    cfg = configLoader();
  } catch {
    return [];
  }
  const decl = cfg.guard?.mcp_servers;
  if (!decl) return [];

  const entries: MCPServerEntry[] = [];
  for (const [name, raw] of Object.entries(decl)) {
    if (!name || !raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    entries.push({
      serverName: name,
      urls: stringArray(r['urls']),
      sockets: stringArray(r['sockets']),
      binaries: stringArray(r['binaries']),
      cliPackages: stringArray(r['cliPackages']),
      source: 'manual',
    });
  }
  return entries;
}

function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

// ---------------------------------------------------------------------------
// Merge & lookup
// ---------------------------------------------------------------------------

/**
 * Merge entries from all sources by `serverName`. Manual overrides take
 * precedence (they are appended last and source-marked accordingly), but
 * handles from auto-discovered sources are still preserved on the same
 * serverName so detectors can match via any handle.
 */
function mergeEntries(groups: MCPServerEntry[][]): MCPServerEntry[] {
  const byName = new Map<string, MCPServerEntry>();
  for (const group of groups) {
    for (const entry of group) {
      const existing = byName.get(entry.serverName);
      if (!existing) {
        byName.set(entry.serverName, { ...entry });
        continue;
      }
      existing.urls = dedup([...existing.urls, ...entry.urls]);
      existing.sockets = dedup([...existing.sockets, ...entry.sockets]);
      existing.binaries = dedup([...existing.binaries, ...entry.binaries]);
      existing.cliPackages = dedup([...existing.cliPackages, ...entry.cliPackages]);
      // Manual override wins for `source` attribution
      if (entry.source === 'manual') existing.source = 'manual';
    }
  }
  return Array.from(byName.values());
}

function dedup(xs: string[]): string[] {
  return Array.from(new Set(xs));
}

function normalizeUrl(u: string): string {
  try {
    const parsed = new URL(u);
    parsed.hash = '';
    parsed.username = '';
    parsed.password = '';
    parsed.host = parsed.host.toLowerCase();
    let result = parsed.toString();
    if (result.endsWith('/') && parsed.pathname === '/') result = result.slice(0, -1);
    return result;
  } catch {
    return u.toLowerCase();
  }
}

function urlMatchesEntry(target: string, entry: MCPServerEntry): boolean {
  const tNorm = normalizeUrl(target);
  for (const u of entry.urls) {
    const uNorm = normalizeUrl(u);
    if (tNorm === uNorm) return true;
    // Origin match: same scheme + host[:port]
    try {
      const a = new URL(target);
      const b = new URL(u);
      if (a.protocol === b.protocol && a.host.toLowerCase() === b.host.toLowerCase()) return true;
    } catch {
      // both literals — string compare already done above
    }
  }
  return false;
}

function buildRegistry(entries: MCPServerEntry[]): MCPRegistry {
  return {
    entries,
    lookupByUrl(url: string): MCPServerEntry | null {
      if (!url) return null;
      for (const e of entries) {
        if (urlMatchesEntry(url, e)) return e;
      }
      return null;
    },
    lookupBySocket(path: string): MCPServerEntry | null {
      if (!path) return null;
      for (const e of entries) {
        for (const s of e.sockets) {
          if (s === path || basename(s) === basename(path)) return e;
        }
      }
      return null;
    },
    lookupByBinary(name: string): MCPServerEntry | null {
      if (!name) return null;
      const target = basename(name).toLowerCase();
      for (const e of entries) {
        for (const b of e.binaries) {
          if (basename(b).toLowerCase() === target) return e;
        }
      }
      return null;
    },
    lookupByCliPackage(pkg: string): MCPServerEntry | null {
      if (!pkg) return null;
      const target = pkg.toLowerCase();
      for (const e of entries) {
        for (const p of e.cliPackages) {
          if (p.toLowerCase() === target) return e;
        }
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LoadMCPRegistryOptions {
  /** Override the home directory used for source discovery (testing). */
  home?: string;
  /** Override the nio config loader for the manual-override source (testing). */
  configLoader?: () => NioConfig;
}

/**
 * Load the registry from all known sources. Caches per-source by mtime, so
 * unchanged files are not re-parsed across calls within a process.
 */
export function loadMCPRegistry(opts: LoadMCPRegistryOptions = {}): MCPRegistry {
  const home = opts.home ?? homedir();
  const configLoader = opts.configLoader ?? loadConfig;
  const sources = discoverSources(home);
  const groups: MCPServerEntry[][] = [];
  for (const desc of sources) groups.push(loadFromSource(desc));
  groups.push(loadManualOverride(configLoader));
  return buildRegistry(mergeEntries(groups));
}

/** Test helper: clear the per-source mtime cache. */
export function clearMCPRegistryCache(): void {
  sourceCache.clear();
}
