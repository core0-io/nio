// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * AuthStrategy — Authorization header providers for ExternalAnalyser.
 *
 *   BearerAuthStrategy  — static "Bearer <api_key>".
 *   OAuthAuthStrategy   — OAuth2 `client_credentials` grant against the
 *                         configured `/token` endpoint. Tokens are cached on
 *                         disk at ~/.nio/oauth-cache/<host>-<fingerprint>.json
 *                         with mode 0600. When the cached token nears expiry
 *                         nio simply requests a new one — client_credentials
 *                         has no refresh_token, just re-fetch.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { DiagnosticCollector } from '../../../adapters/diagnostics.js';

// ── AuthStrategy interface ──────────────────────────────────────────────

export interface AuthStrategy {
  /**
   * Resolve the Authorization header value (e.g. "Bearer xyz"), or null on
   * failure. Pass a DiagnosticCollector to capture structured failure info
   * the orchestrator can surface back to the user.
   */
  getAuthHeader(reporter?: DiagnosticCollector): Promise<string | null>;
}

// ── BearerAuthStrategy ──────────────────────────────────────────────────

export class BearerAuthStrategy implements AuthStrategy {
  constructor(private readonly apiKey: string) {}
  async getAuthHeader(_reporter?: DiagnosticCollector): Promise<string | null> {
    return `Bearer ${this.apiKey}`;
  }
}

// ── OAuth types ─────────────────────────────────────────────────────────

export interface OAuthConfig {
  oauthUrl: string;
  clientId: string;
  clientSecret: string;
  /** Override the disk cache directory (test injection). */
  cacheDir?: string;
}

interface TokenCacheEntry {
  access_token: string;
  expires_at: number;        // unix seconds
}

// ── Helpers ─────────────────────────────────────────────────────────────

const TOKEN_SAFETY_MARGIN_S = 60;

function defaultCacheDir(): string {
  const root = process.env.NIO_HOME || join(homedir(), '.nio');
  return join(root, 'oauth-cache');
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Stable fingerprint of an OAuth identity. Two configs with identical OAuth
 * fields share a token cache; differing fields are isolated.
 */
export function oauthFingerprint(cfg: OAuthConfig): string {
  const h = createHash('sha256');
  h.update(cfg.oauthUrl);     h.update('\0');
  h.update(cfg.clientId);     h.update('\0');
  h.update(cfg.clientSecret);
  return h.digest('hex').slice(0, 16);
}

function slugHost(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/[^a-zA-Z0-9_-]/g, '_');
  } catch {
    return 'oauth';
  }
}

/**
 * Resolve the cache file path for a given OAuth config. Exported so tests
 * (and callers wanting to inspect / wipe the cache) don't have to mirror the
 * path-construction logic.
 */
export function cacheFilePath(cfg: OAuthConfig): string {
  const dir = cfg.cacheDir ?? defaultCacheDir();
  return join(dir, `${slugHost(cfg.oauthUrl)}-${oauthFingerprint(cfg)}.json`);
}

async function readCache(path: string): Promise<TokenCacheEntry | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as TokenCacheEntry;
  } catch {
    return null;
  }
}

async function writeCache(path: string, entry: TokenCacheEntry): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  await writeFile(tmp, JSON.stringify(entry), { mode: 0o600 });
  await rename(tmp, path);
  // rename preserves mode of the source file (0o600), but be defensive.
  try { await chmod(path, 0o600); } catch { /* ignore */ }
}

// ── OAuthAuthStrategy ───────────────────────────────────────────────────

export class OAuthAuthStrategy implements AuthStrategy {
  private inflight?: Promise<string | null>;
  private readonly cachePath: string;

  constructor(private readonly cfg: OAuthConfig) {
    this.cachePath = cacheFilePath(cfg);
  }

  async getAuthHeader(reporter?: DiagnosticCollector): Promise<string | null> {
    const tok = await this.ensureToken(reporter);
    return tok ? `Bearer ${tok}` : null;
  }

  private async ensureToken(reporter?: DiagnosticCollector): Promise<string | null> {
    // Note: when multiple concurrent calls share an in-flight promise, only
    // the first caller's reporter receives diagnostics. That's acceptable —
    // any caller will see the failure via the returned null, and audit-log
    // entries are written unconditionally by reporter.collect().
    if (this.inflight) return this.inflight;
    this.inflight = this.acquireToken(reporter).finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  private get oauthHost(): string {
    try { return new URL(this.cfg.oauthUrl).hostname; } catch { return this.cfg.oauthUrl; }
  }

  private async acquireToken(reporter?: DiagnosticCollector): Promise<string | null> {
    // 1) Cache hit
    const cached = await readCache(this.cachePath);
    if (cached && cached.expires_at > nowSeconds() + TOKEN_SAFETY_MARGIN_S) {
      return cached.access_token;
    }

    // 2) Fetch a fresh token via client_credentials grant
    try {
      const entry = await this.fetchToken();
      try {
        await writeCache(this.cachePath, entry);
      } catch (err: unknown) {
        reporter?.collect({
          severity: 'warning',
          source: 'oauth',
          kind: 'cache_write_failed',
          component: this.oauthHost,
          message: `Failed to persist OAuth token cache to ${this.cachePath}`,
          detail: (err as { message?: string })?.message,
          hint: 'Check disk permissions on ~/.nio/oauth-cache/. Token is still usable in-memory for this process.',
        });
      }
      return entry.access_token;
    } catch (err: unknown) {
      const error = err as { message?: string };
      reporter?.collect({
        severity: 'error',
        source: 'oauth',
        kind: 'token_failed',
        component: this.oauthHost,
        message: `client_credentials grant failed at ${this.cfg.oauthUrl}/token`,
        detail: error.message,
        hint: 'Check client_id / client_secret in guard.external_analyser[].auth, or run /nio doctor.',
      });
      return null;
    }
  }

  private async fetchToken(): Promise<TokenCacheEntry> {
    const body = new URLSearchParams();
    body.set('grant_type', 'client_credentials');
    body.set('client_id', this.cfg.clientId);
    body.set('client_secret', this.cfg.clientSecret);

    const resp = await fetch(`${this.cfg.oauthUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!resp.ok) throw new Error(`token: HTTP ${resp.status} ${resp.statusText}`);

    const data = await resp.json() as {
      access_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) throw new Error('token: missing access_token in response');

    return {
      access_token: data.access_token,
      expires_at: nowSeconds() + (data.expires_in ?? 3600),
    };
  }
}

// ── Cross-endpoint registry ─────────────────────────────────────────────

const oauthRegistry = new Map<string, OAuthAuthStrategy>();

/**
 * Returns the OAuthAuthStrategy for the given config, sharing instances
 * across endpoints whose OAuth identity is identical (same fingerprint).
 *
 * This is what gives multiple `external_analyser` entries pointing at the
 * same OAuth client a shared in-process inflight-promise and a shared disk
 * cache, so the token POST only fires once even when N endpoints fire
 * concurrently.
 */
export function getOrCreateOAuthStrategy(cfg: OAuthConfig): OAuthAuthStrategy {
  const fp = oauthFingerprint(cfg);
  // cacheDir differences are deliberately included in the registry key so
  // tests using isolated dirs don't bleed into one another.
  const key = `${fp}|${cfg.cacheDir ?? ''}`;
  let s = oauthRegistry.get(key);
  if (!s) {
    s = new OAuthAuthStrategy(cfg);
    oauthRegistry.set(key, s);
  }
  return s;
}

/** Test helper — clears the in-process OAuth strategy registry. */
export function _resetOAuthRegistryForTests(): void {
  oauthRegistry.clear();
}
