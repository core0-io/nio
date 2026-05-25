// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * AuthStrategy — Authorization header providers for ExternalAnalyser.
 *
 *   BearerAuthStrategy  — static "Bearer <api_key>".
 *   OAuthAuthStrategy   — FFWD-flavored OAuth2 PKCE flow with disk-backed
 *                         token cache, refresh_token re-use, automatic
 *                         re-registration on full expiry, and cross-endpoint
 *                         de-duplication keyed by an OAuth-client fingerprint.
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
  keyId: string;
  keySecret: string;
  clientId?: string;
  clientSecret?: string;
  /** Override the disk cache directory (test injection). */
  cacheDir?: string;
}

interface TokenCacheEntry {
  access_token: string;
  refresh_token?: string;
  expires_at: number;        // unix seconds
  client_id: string;
  client_secret?: string;
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

/** Pick the first present field from a list of candidate keys (FFWD has hyphen/underscore variants). */
function readField(data: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const v = data[name];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(64).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Stable fingerprint of an OAuth identity. Two configs with identical OAuth
 * fields share a token cache; differing fields (e.g. different key_id) are
 * isolated.
 */
export function oauthFingerprint(cfg: OAuthConfig): string {
  const h = createHash('sha256');
  h.update(cfg.oauthUrl);       h.update('\0');
  h.update(cfg.keyId);          h.update('\0');
  h.update(cfg.keySecret);      h.update('\0');
  h.update(cfg.clientId ?? ''); h.update('\0');
  h.update(cfg.clientSecret ?? '');
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

    // 2) Try refresh_token grant
    if (cached?.refresh_token) {
      const refreshed = await this.tryRefresh(cached, reporter);
      if (refreshed) return refreshed.access_token;
    }

    // 3) Fresh PKCE flow
    try {
      const entry = await this.runPkceFlow(cached);
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
        kind: 'pkce_failed',
        component: this.oauthHost,
        message: `PKCE flow failed for ${this.cfg.oauthUrl}`,
        detail: error.message,
        hint: 'Check key_id / key_secret in guard.external_analyser[].auth, or run /nio doctor.',
      });
      return null;
    }
  }

  private async tryRefresh(cached: TokenCacheEntry, reporter?: DiagnosticCollector): Promise<TokenCacheEntry | null> {
    try {
      const body = new URLSearchParams();
      body.set('grant_type', 'refresh_token');
      body.set('refresh_token', cached.refresh_token!);
      body.set('client_id', cached.client_id);
      if (cached.client_secret) body.set('client_secret', cached.client_secret);

      const resp = await fetch(`${this.cfg.oauthUrl}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (!resp.ok) {
        reporter?.collect({
          severity: 'warning',
          source: 'oauth',
          kind: 'refresh_failed',
          component: this.oauthHost,
          message: `refresh_token grant rejected (HTTP ${resp.status}); falling back to full PKCE`,
          detail: `${resp.status} ${resp.statusText}`,
        });
        return null;
      }

      const data = await resp.json() as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };
      if (!data.access_token) return null;

      const entry: TokenCacheEntry = {
        access_token: data.access_token,
        refresh_token: data.refresh_token ?? cached.refresh_token,
        expires_at: nowSeconds() + (data.expires_in ?? 3600),
        client_id: cached.client_id,
        client_secret: cached.client_secret,
      };
      try {
        await writeCache(this.cachePath, entry);
      } catch (err: unknown) {
        reporter?.collect({
          severity: 'warning',
          source: 'oauth',
          kind: 'cache_write_failed',
          component: this.oauthHost,
          message: `Failed to persist refreshed token to ${this.cachePath}`,
          detail: (err as { message?: string })?.message,
        });
      }
      return entry;
    } catch (err: unknown) {
      reporter?.collect({
        severity: 'warning',
        source: 'oauth',
        kind: 'refresh_failed',
        component: this.oauthHost,
        message: `refresh_token request errored; falling back to full PKCE`,
        detail: (err as { message?: string })?.message,
      });
      return null;
    }
  }

  private async runPkceFlow(cached: TokenCacheEntry | null): Promise<TokenCacheEntry> {
    // Resolve client identity: config-provided > cached > /register.
    let clientId    = this.cfg.clientId    ?? cached?.client_id;
    let clientSecret = this.cfg.clientSecret ?? cached?.client_secret;

    if (!clientId) {
      const reg = await this.postJson(`${this.cfg.oauthUrl}/register`, {});
      clientId = readField(reg, 'client_id', 'client-id', 'id');
      if (!clientId) throw new Error('register: missing client_id in response');
      clientSecret = readField(reg, 'client_secret', 'client-secret') ?? clientSecret;
    }

    const { verifier, challenge } = createPkcePair();
    const code = await this.postJson(`${this.cfg.oauthUrl}/code`, {
      'key-id':         this.cfg.keyId,
      'key-secret':     this.cfg.keySecret,
      'client-id':      clientId,
      'code-challenge': challenge,
    });
    const codeStr = readField(code, 'code');
    if (!codeStr) throw new Error('code: missing code in response');

    const tokenBody = new URLSearchParams();
    tokenBody.set('grant_type', 'authorization_code');
    tokenBody.set('code', codeStr);
    tokenBody.set('client_id', clientId);
    tokenBody.set('code_verifier', verifier);
    if (clientSecret) tokenBody.set('client_secret', clientSecret);

    const tokResp = await fetch(`${this.cfg.oauthUrl}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody.toString(),
    });
    if (!tokResp.ok) throw new Error(`token: HTTP ${tokResp.status}`);
    const tok = await tokResp.json() as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!tok.access_token) throw new Error('token: missing access_token');

    return {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      expires_at: nowSeconds() + (tok.expires_in ?? 3600),
      client_id: clientId,
      client_secret: clientSecret,
    };
  }

  private async postJson(url: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
    return await resp.json() as Record<string, unknown>;
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
 * cache, so PKCE only runs once even when N endpoints fire concurrently.
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
