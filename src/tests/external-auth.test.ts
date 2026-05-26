// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * external-auth.test.ts — BearerAuthStrategy + OAuthAuthStrategy.
 *
 * Uses node:http to spin up an isolated mock OAuth server per test, so
 * tests neither hit the network nor share state. nio uses only the
 * `client_credentials` grant against `/token` — no `/register`, no `/code`,
 * no PKCE, no refresh_token.
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
  _resetOAuthRegistryForTests,
} from '../core/analysers/external/auth.js';
import { _setDiagnosticsAuditPathForTests, DiagnosticCollector } from '../adapters/diagnostics.js';

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
  tokenCalls: number;
  unexpectedCalls: number;  // Anything other than POST /token bumps this.
  /** Last (client_id, client_secret) the server saw at /token. */
  lastClientId?: string;
  lastClientSecret?: string;
}

interface MockOptions {
  /** Override default expires_in (seconds). */
  expiresIn?: number;
  /** When set, /token replies with this HTTP status instead of 200. */
  tokenStatus?: number;
}

function startMockOAuth(opts: MockOptions = {}): Promise<{ url: string; server: Server; state: MockState }> {
  const state: MockState = { tokenCalls: 0, unexpectedCalls: 0 };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf-8');

    if (req.url === '/token' && req.method === 'POST') {
      state.tokenCalls += 1;
      const params = new URLSearchParams(body);
      state.lastClientId = params.get('client_id') ?? undefined;
      state.lastClientSecret = params.get('client_secret') ?? undefined;

      const grant = params.get('grant_type');
      if (grant !== 'client_credentials') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unsupported_grant_type', got: grant }));
        return;
      }
      if (opts.tokenStatus && opts.tokenStatus !== 200) {
        res.writeHead(opts.tokenStatus);
        res.end(JSON.stringify({ error: 'invalid_client' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        access_token: `at-${state.tokenCalls}`,
        token_type: 'Bearer',
        expires_in: opts.expiresIn ?? 3600,
      }));
      return;
    }

    state.unexpectedCalls += 1;
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'nio should only hit POST /token', url: req.url, method: req.method }));
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

describe('OAuthAuthStrategy (client_credentials)', () => {
  let cacheDir: string;

  beforeEach(async () => {
    _resetOAuthRegistryForTests();
    cacheDir = await mkdtemp(join(tmpdir(), 'nio-oauth-test-'));
  });

  afterEach(() => {
    _resetOAuthRegistryForTests();
  });

  it('cold start POSTs /token once, sends client_credentials grant, caches token 0600', async () => {
    const { url, server, state } = await startMockOAuth();
    try {
      const cfg = { oauthUrl: url, clientId: 'cid', clientSecret: 'csec', cacheDir };
      const s = new OAuthAuthStrategy(cfg);
      const header = await s.getAuthHeader();

      assert.equal(header, 'Bearer at-1');
      assert.equal(state.tokenCalls, 1);
      assert.equal(state.unexpectedCalls, 0, 'nio must not hit /register, /code, or anything else');
      assert.equal(state.lastClientId, 'cid');
      assert.equal(state.lastClientSecret, 'csec');

      const expected = cacheFilePath(cfg);
      const st = await stat(expected);
      assert.equal(st.mode & 0o777, 0o600, `expected 0600, got ${(st.mode & 0o777).toString(8)}`);

      const cached = JSON.parse(await readFile(expected, 'utf-8'));
      assert.equal(cached.access_token, 'at-1');
      // No refresh_token in the cache — client_credentials doesn't have one.
      assert.equal(cached.refresh_token, undefined);
      assert.ok(typeof cached.expires_at === 'number' && cached.expires_at > 0);
    } finally {
      await stopServer(server);
    }
  });

  it('cache hit reuses token without any HTTP call', async () => {
    const { url, server, state } = await startMockOAuth();
    try {
      const cfg = { oauthUrl: url, clientId: 'cid', clientSecret: 'csec', cacheDir };
      const s = new OAuthAuthStrategy(cfg);
      await s.getAuthHeader();
      const callsAfterFirst = state.tokenCalls;

      const header = await s.getAuthHeader();
      assert.equal(header, 'Bearer at-1');
      assert.equal(state.tokenCalls, callsAfterFirst);

      // A fresh instance pointing at the same cacheDir/fingerprint also reuses the cache
      const s2 = new OAuthAuthStrategy(cfg);
      assert.equal(await s2.getAuthHeader(), 'Bearer at-1');
      assert.equal(state.tokenCalls, callsAfterFirst);
    } finally {
      await stopServer(server);
    }
  });

  it('expired cached token → re-POSTs /token once (no refresh, no PKCE)', async () => {
    const { url, server, state } = await startMockOAuth();
    try {
      const cfg = { oauthUrl: url, clientId: 'cid', clientSecret: 'csec', cacheDir };
      await writeFile(cacheFilePath(cfg), JSON.stringify({
        access_token: 'at-old',
        expires_at: 1,           // way in the past
      }));

      const s = new OAuthAuthStrategy(cfg);
      const header = await s.getAuthHeader();
      assert.equal(header, 'Bearer at-1');
      assert.equal(state.tokenCalls, 1);
      assert.equal(state.unexpectedCalls, 0);
    } finally {
      await stopServer(server);
    }
  });

  it('returns null and emits a diagnostic on 401', async () => {
    const { url, server, state } = await startMockOAuth({ tokenStatus: 401 });
    try {
      const cfg = { oauthUrl: url, clientId: 'cid', clientSecret: 'badsec', cacheDir };
      const s = new OAuthAuthStrategy(cfg);
      const reporter = new DiagnosticCollector();
      const header = await s.getAuthHeader(reporter);

      assert.equal(header, null);
      assert.equal(state.tokenCalls, 1);

      const diags = reporter.take();
      assert.equal(diags.length, 1);
      assert.equal(diags[0].source, 'oauth');
      assert.equal(diags[0].kind, 'token_failed');
      assert.match(diags[0].detail ?? '', /HTTP 401/);
      assert.match(diags[0].hint ?? '', /client_id \/ client_secret/);
    } finally {
      await stopServer(server);
    }
  });

  it('in-process inflight dedup: 10 concurrent getAuthHeader() → 1 POST', async () => {
    const { url, server, state } = await startMockOAuth();
    try {
      const s = new OAuthAuthStrategy({
        oauthUrl: url, clientId: 'cid', clientSecret: 'csec', cacheDir,
      });
      const results = await Promise.all(
        Array.from({ length: 10 }, () => s.getAuthHeader()),
      );
      assert.ok(results.every(r => r === 'Bearer at-1'));
      assert.equal(state.tokenCalls, 1);
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

  it('three strategies sharing the same OAuth identity make /token POST exactly once', async () => {
    const { url, server, state } = await startMockOAuth();
    try {
      const baseCfg = { oauthUrl: url, clientId: 'cid', clientSecret: 'csec', cacheDir };
      const s1 = getOrCreateOAuthStrategy(baseCfg);
      const s2 = getOrCreateOAuthStrategy(baseCfg);
      const s3 = getOrCreateOAuthStrategy(baseCfg);
      assert.equal(s1, s2);
      assert.equal(s2, s3);

      const [h1, h2, h3] = await Promise.all([
        s1.getAuthHeader(), s2.getAuthHeader(), s3.getAuthHeader(),
      ]);
      assert.equal(h1, 'Bearer at-1');
      assert.equal(h2, 'Bearer at-1');
      assert.equal(h3, 'Bearer at-1');
      assert.equal(state.tokenCalls, 1);
    } finally {
      await stopServer(server);
    }
  });

  it('different client_id → distinct strategies, two POSTs', async () => {
    const { url, server, state } = await startMockOAuth();
    try {
      const sA = getOrCreateOAuthStrategy({
        oauthUrl: url, clientId: 'cidA', clientSecret: 'csec', cacheDir,
      });
      const sB = getOrCreateOAuthStrategy({
        oauthUrl: url, clientId: 'cidB', clientSecret: 'csec', cacheDir,
      });
      assert.notEqual(sA, sB);

      const [hA, hB] = await Promise.all([sA.getAuthHeader(), sB.getAuthHeader()]);
      assert.match(hA!, /^Bearer at-[12]$/);
      assert.match(hB!, /^Bearer at-[12]$/);
      assert.notEqual(hA, hB);
      assert.equal(state.tokenCalls, 2);
    } finally {
      await stopServer(server);
    }
  });
});
