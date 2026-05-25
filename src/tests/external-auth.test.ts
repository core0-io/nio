// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * external-auth.test.ts — BearerAuthStrategy + OAuthAuthStrategy.
 *
 * Uses node:http to spin up an isolated mock OAuth server per test, so
 * tests neither hit the network nor share state.
 */

import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

import {
  BearerAuthStrategy,
  OAuthAuthStrategy,
  cacheFilePath,
  getOrCreateOAuthStrategy,
  oauthFingerprint,
  _resetOAuthRegistryForTests,
} from '../core/analysers/external/auth.js';
import { _setDiagnosticsAuditPathForTests } from '../adapters/diagnostics.js';

// Sandbox diagnostic writes so tests never touch ~/.nio/audit.jsonl.
let testAuditDir: string;
before(() => {
  testAuditDir = mkdtempSync(join(tmpdir(), 'nio-external-auth-test-'));
  _setDiagnosticsAuditPathForTests(join(testAuditDir, 'audit.jsonl'));
});
after(() => {
  _setDiagnosticsAuditPathForTests(null);
  try { rmSync(testAuditDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── Mock OAuth server harness ───────────────────────────────────────────

interface MockState {
  registerCalls: number;
  codeCalls: number;
  tokenCalls: number;
  refreshCalls: number;
  /** Last code-verifier received at /token (for PKCE assertion). */
  lastCodeVerifier?: string;
}

interface MockOptions {
  /** When true, /register returns hyphenated keys (`client-id`, `client-secret`). */
  hyphenateRegister?: boolean;
  /** Override default expires_in (seconds). */
  expiresIn?: number;
  /** When true, refresh_token endpoint replies 400 (forces full re-PKCE). */
  refreshFails?: boolean;
}

function startMockOAuth(opts: MockOptions = {}): Promise<{ url: string; server: Server; state: MockState }> {
  const state: MockState = { registerCalls: 0, codeCalls: 0, tokenCalls: 0, refreshCalls: 0 };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf-8');

    if (req.url === '/register' && req.method === 'POST') {
      state.registerCalls += 1;
      const clientId = `client-${state.registerCalls}`;
      const payload = opts.hyphenateRegister
        ? { 'client-id': clientId, 'client-secret': null }
        : { client_id: clientId, client_secret: null };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
      return;
    }

    if (req.url === '/code' && req.method === 'POST') {
      state.codeCalls += 1;
      const parsed = JSON.parse(body) as Record<string, string>;
      // Verify hyphenated keys are sent by the client
      if (!parsed['key-id'] || !parsed['key-secret'] || !parsed['client-id'] || !parsed['code-challenge']) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'missing fields', got: Object.keys(parsed) }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: `code-${state.codeCalls}` }));
      return;
    }

    if (req.url === '/token' && req.method === 'POST') {
      const params = new URLSearchParams(body);
      const grantType = params.get('grant_type');
      if (grantType === 'refresh_token') {
        state.refreshCalls += 1;
        if (opts.refreshFails) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'refresh denied' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          access_token: `at-refreshed-${state.refreshCalls}`,
          refresh_token: `rt-refreshed-${state.refreshCalls}`,
          expires_in: opts.expiresIn ?? 3600,
          token_type: 'Bearer',
        }));
        return;
      }
      // authorization_code grant
      state.tokenCalls += 1;
      state.lastCodeVerifier = params.get('code_verifier') ?? undefined;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        access_token: `at-${state.tokenCalls}`,
        refresh_token: `rt-${state.tokenCalls}`,
        expires_in: opts.expiresIn ?? 3600,
        token_type: 'Bearer',
      }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, server, state });
    });
  });
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>(r => server.close(() => r()));
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('BearerAuthStrategy', () => {
  it('returns Bearer <api_key>', async () => {
    const s = new BearerAuthStrategy('sk-test');
    assert.equal(await s.getAuthHeader(), 'Bearer sk-test');
  });
});

describe('OAuthAuthStrategy', () => {
  let cacheDir: string;

  beforeEach(async () => {
    _resetOAuthRegistryForTests();
    cacheDir = await mkdtemp(join(tmpdir(), 'nio-oauth-test-'));
  });

  afterEach(() => {
    _resetOAuthRegistryForTests();
  });

  it('cold start runs register + code + token; caches token to disk with mode 0600', async () => {
    const { url, server, state } = await startMockOAuth();
    try {
      const s = new OAuthAuthStrategy({
        oauthUrl: url, keyId: 'kid', keySecret: 'ksec', cacheDir,
      });
      const header = await s.getAuthHeader();
      assert.equal(header, 'Bearer at-1');
      assert.equal(state.registerCalls, 1);
      assert.equal(state.codeCalls, 1);
      assert.equal(state.tokenCalls, 1);

      // cache file present
      const expected = cacheFilePath({
        oauthUrl: url, keyId: 'kid', keySecret: 'ksec', cacheDir,
      });
      const st = await stat(expected);
      // mode bits — only check user/group/other permission bits
      assert.equal(st.mode & 0o777, 0o600, `expected 0600, got ${(st.mode & 0o777).toString(8)}`);

      const cached = JSON.parse(await readFile(expected, 'utf-8'));
      assert.equal(cached.access_token, 'at-1');
      assert.equal(cached.refresh_token, 'rt-1');
      assert.equal(cached.client_id, 'client-1');
    } finally {
      await stopServer(server);
    }
  });

  it('cache hit reuses token without any HTTP call', async () => {
    const { url, server, state } = await startMockOAuth();
    try {
      const s = new OAuthAuthStrategy({
        oauthUrl: url, keyId: 'kid', keySecret: 'ksec', cacheDir,
      });
      // First call populates cache
      await s.getAuthHeader();
      const callsAfterFirst = { ...state };

      // Second call on same instance — inflight is reset, must re-read from cache
      const header = await s.getAuthHeader();
      assert.equal(header, 'Bearer at-1');
      assert.equal(state.registerCalls, callsAfterFirst.registerCalls);
      assert.equal(state.codeCalls, callsAfterFirst.codeCalls);
      assert.equal(state.tokenCalls, callsAfterFirst.tokenCalls);

      // A fresh instance pointing at same cacheDir/fingerprint also reuses the cache
      const s2 = new OAuthAuthStrategy({
        oauthUrl: url, keyId: 'kid', keySecret: 'ksec', cacheDir,
      });
      assert.equal(await s2.getAuthHeader(), 'Bearer at-1');
      assert.equal(state.tokenCalls, callsAfterFirst.tokenCalls);
    } finally {
      await stopServer(server);
    }
  });

  it('refresh path: expired token + refresh_token → only /token (refresh) is called', async () => {
    const { url, server, state } = await startMockOAuth();
    try {
      // Seed the cache with an expired token + refresh_token
      const cfg = { oauthUrl: url, keyId: 'kid', keySecret: 'ksec', cacheDir };
      const fp = oauthFingerprint(cfg);
      const seed = {
        access_token: 'at-old',
        refresh_token: 'rt-old',
        expires_at: 1,           // way in the past
        client_id: 'client-seed',
        client_secret: null,
      };
      await writeFile(cacheFilePath(cfg), JSON.stringify(seed));

      const s = new OAuthAuthStrategy(cfg);
      const header = await s.getAuthHeader();
      assert.equal(header, 'Bearer at-refreshed-1');
      assert.equal(state.refreshCalls, 1);
      assert.equal(state.registerCalls, 0, 'no /register');
      assert.equal(state.codeCalls, 0, 'no /code');
      assert.equal(state.tokenCalls, 0, 'authorization_code /token not called');
    } finally {
      await stopServer(server);
    }
  });

  it('refresh failure falls back to full PKCE flow', async () => {
    const { url, server, state } = await startMockOAuth({ refreshFails: true });
    try {
      const cfg = { oauthUrl: url, keyId: 'kid', keySecret: 'ksec', cacheDir };
      const fp = oauthFingerprint(cfg);
      const seed = {
        access_token: 'at-old',
        refresh_token: 'rt-old',
        expires_at: 1,
        client_id: 'client-seed',
        client_secret: null,
      };
      await writeFile(cacheFilePath(cfg), JSON.stringify(seed));

      const s = new OAuthAuthStrategy(cfg);
      const header = await s.getAuthHeader();
      assert.equal(header, 'Bearer at-1');
      assert.equal(state.refreshCalls, 1, 'refresh attempted');
      // cached.client_id is reused → /register is skipped on the PKCE fallback
      assert.equal(state.registerCalls, 0, 'register reuses cached client_id');
      assert.equal(state.codeCalls, 1, 'code re-issued with cached client_id');
      assert.equal(state.tokenCalls, 1, 'fresh token via authorization_code grant');
    } finally {
      await stopServer(server);
    }
  });

  it('pre-issued client_id skips /register', async () => {
    const { url, server, state } = await startMockOAuth();
    try {
      const s = new OAuthAuthStrategy({
        oauthUrl: url, keyId: 'kid', keySecret: 'ksec',
        clientId: 'pre-issued-42',
        cacheDir,
      });
      const header = await s.getAuthHeader();
      assert.equal(header, 'Bearer at-1');
      assert.equal(state.registerCalls, 0, '/register must NOT be called');
      assert.equal(state.codeCalls, 1);
      assert.equal(state.tokenCalls, 1);
    } finally {
      await stopServer(server);
    }
  });

  it('register endpoint with hyphenated keys (FFWD flavor) is parsed', async () => {
    const { url, server, state } = await startMockOAuth({ hyphenateRegister: true });
    try {
      const s = new OAuthAuthStrategy({
        oauthUrl: url, keyId: 'kid', keySecret: 'ksec', cacheDir,
      });
      const header = await s.getAuthHeader();
      assert.equal(header, 'Bearer at-1');
      assert.equal(state.registerCalls, 1);
      assert.equal(state.tokenCalls, 1);
    } finally {
      await stopServer(server);
    }
  });

  it('in-process inflight dedup: 10 concurrent getAuthHeader() → only 1 PKCE flow', async () => {
    const { url, server, state } = await startMockOAuth();
    try {
      const s = new OAuthAuthStrategy({
        oauthUrl: url, keyId: 'kid', keySecret: 'ksec', cacheDir,
      });
      const results = await Promise.all(
        Array.from({ length: 10 }, () => s.getAuthHeader()),
      );
      // All concurrent callers see the same token
      assert.ok(results.every(r => r === 'Bearer at-1'));
      assert.equal(state.tokenCalls, 1);
      assert.equal(state.registerCalls, 1);
      assert.equal(state.codeCalls, 1);
    } finally {
      await stopServer(server);
    }
  });
});

describe('OAuth cross-endpoint sharing via registry', () => {
  let cacheDir: string;

  beforeEach(async () => {
    _resetOAuthRegistryForTests();
    cacheDir = await mkdtemp(join(tmpdir(), 'nio-oauth-share-test-'));
  });

  afterEach(() => {
    _resetOAuthRegistryForTests();
  });

  it('three strategies sharing same OAuth fields run PKCE exactly once', async () => {
    const { url, server, state } = await startMockOAuth();
    try {
      const baseCfg = { oauthUrl: url, keyId: 'kid', keySecret: 'ksec', cacheDir };
      const s1 = getOrCreateOAuthStrategy(baseCfg);
      const s2 = getOrCreateOAuthStrategy(baseCfg);
      const s3 = getOrCreateOAuthStrategy(baseCfg);
      assert.equal(s1, s2, 'same instance');
      assert.equal(s2, s3, 'same instance');

      const [h1, h2, h3] = await Promise.all([
        s1.getAuthHeader(), s2.getAuthHeader(), s3.getAuthHeader(),
      ]);
      assert.equal(h1, 'Bearer at-1');
      assert.equal(h2, 'Bearer at-1');
      assert.equal(h3, 'Bearer at-1');
      assert.equal(state.tokenCalls, 1);
      assert.equal(state.registerCalls, 1);
    } finally {
      await stopServer(server);
    }
  });

  it('two strategies with different key_id produce two PKCE flows and two cache files', async () => {
    const { url, server, state } = await startMockOAuth();
    try {
      const sA = getOrCreateOAuthStrategy({
        oauthUrl: url, keyId: 'kidA', keySecret: 'ksec', cacheDir,
      });
      const sB = getOrCreateOAuthStrategy({
        oauthUrl: url, keyId: 'kidB', keySecret: 'ksec', cacheDir,
      });
      assert.notEqual(sA, sB, 'different instances');

      const [hA, hB] = await Promise.all([sA.getAuthHeader(), sB.getAuthHeader()]);
      assert.match(hA!, /^Bearer at-[12]$/);
      assert.match(hB!, /^Bearer at-[12]$/);
      assert.notEqual(hA, hB);
      assert.equal(state.tokenCalls, 2);
      assert.equal(state.registerCalls, 2);
    } finally {
      await stopServer(server);
    }
  });
});
