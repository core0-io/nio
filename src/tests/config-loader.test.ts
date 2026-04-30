// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadCollectorConfig,
  loadLogsConfig,
  type CollectorConfig,
} from '../scripts/lib/config-loader.js';

// loadCollectorConfig / loadLogsConfig read from $NIO_HOME/config.yaml.
// Each test installs a fresh tmpdir into NIO_HOME, writes a config, and
// restores afterwards.

function withNioHome<T>(yamlBody: string, fn: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'nio-config-loader-'));
  writeFileSync(join(dir, 'config.yaml'), yamlBody);
  const previous = process.env['NIO_HOME'];
  process.env['NIO_HOME'] = dir;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env['NIO_HOME'];
    else process.env['NIO_HOME'] = previous;
  }
}

// ── loadCollectorConfig ─────────────────────────────────────────────────

describe('loadCollectorConfig', () => {
  it('returns enabled=false when no endpoint is configured', () => {
    const cfg = withNioHome('collector: {}\n', loadCollectorConfig);
    assert.equal(cfg.endpoint, '');
    assert.equal(cfg.enabled, false);
  });

  it('returns enabled=true when endpoint is set', () => {
    const cfg = withNioHome(
      'collector:\n  endpoint: "http://localhost:4318"\n',
      loadCollectorConfig,
    );
    assert.equal(cfg.endpoint, 'http://localhost:4318');
    assert.equal(cfg.enabled, true);
  });

  it('does not regress on legacy yaml carrying collector.metrics.{local,log,max_size_mb}', () => {
    // A user with an old config.yaml from before the cleanup must still
    // load successfully. zod strips unknown fields by default.
    const yaml = [
      'collector:',
      '  endpoint: "http://localhost:4318"',
      '  metrics:',
      '    enabled: true',
      '    local: true',
      '    log: "~/.nio/metrics.jsonl"',
      '    max_size_mb: 100',
      '',
    ].join('\n');
    const cfg = withNioHome(yaml, loadCollectorConfig);
    assert.equal(cfg.enabled, true);
    // log field must NOT exist on the resolved config — sanity check the
    // type narrowing in case TS becomes structural in surprising ways.
    assert.equal((cfg as CollectorConfig & { log?: string }).log, undefined);
  });

  it('honors api_key, timeout, and protocol when set', () => {
    const yaml = [
      'collector:',
      '  endpoint: "http://localhost:4318"',
      '  api_key: "secret"',
      '  timeout: 1234',
      '  protocol: grpc',
      '',
    ].join('\n');
    const cfg = withNioHome(yaml, loadCollectorConfig);
    assert.equal(cfg.api_key, 'secret');
    assert.equal(cfg.timeout, 1234);
    assert.equal(cfg.protocol, 'grpc');
  });
});

// ── loadLogsConfig ──────────────────────────────────────────────────────

describe('loadLogsConfig', () => {
  it('returns audit.jsonl default when collector.logs is missing', () => {
    const cfg = withNioHome('collector: {}\n', loadLogsConfig);
    assert.ok(cfg.path.endsWith('/audit.jsonl'));
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.local, true);
    assert.equal(cfg.max_size_mb, 100);
  });

  it('honors collector.logs.path verbatim when absolute', () => {
    const yaml = [
      'collector:',
      '  logs:',
      '    path: "/var/log/nio/audit.jsonl"',
      '',
    ].join('\n');
    const cfg = withNioHome(yaml, loadLogsConfig);
    assert.equal(cfg.path, '/var/log/nio/audit.jsonl');
  });

  it('expands ~/ in collector.logs.path', () => {
    const yaml = [
      'collector:',
      '  logs:',
      '    path: "~/audit-custom/audit.jsonl"',
      '',
    ].join('\n');
    const cfg = withNioHome(yaml, loadLogsConfig);
    assert.ok(cfg.path.includes('audit-custom/audit.jsonl'));
    assert.ok(!cfg.path.startsWith('~/'), 'must not retain ~ prefix');
  });

  it('honors collector.logs.enabled and local toggles', () => {
    const yaml = [
      'collector:',
      '  logs:',
      '    enabled: false',
      '    local: false',
      '',
    ].join('\n');
    const cfg = withNioHome(yaml, loadLogsConfig);
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.local, false);
  });
});
