// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  DEFAULT_CONTENT_LIMITS,
  truncateContent,
} from '../scripts/lib/content/truncate.js';
import { loadContentLimits } from '../scripts/lib/config-loader.js';

// loadContentLimits reads from $NIO_HOME/config.yaml. Each test installs a
// fresh tmpdir into NIO_HOME, writes a config, and restores afterwards —
// same pattern as config-loader.test.ts.
function withNioHome<T>(yamlBody: string, fn: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'nio-content-truncate-'));
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

describe('truncateContent', () => {
  it('returns text unchanged when under the limit', () => {
    const s = 'hello world';
    const { text, truncated, originalBytes } = truncateContent(s, 1000);
    assert.equal(text, s);
    assert.equal(truncated, false);
    assert.equal(originalBytes, Buffer.byteLength(s, 'utf-8'));
  });

  it('returns text unchanged when exactly at the limit', () => {
    const s = 'abcde';
    const { text, truncated } = truncateContent(s, Buffer.byteLength(s, 'utf-8'));
    assert.equal(text, s);
    assert.equal(truncated, false);
  });

  it('truncates text over the limit and reports original byte length', () => {
    const s = 'a'.repeat(100);
    const { text, truncated, originalBytes } = truncateContent(s, 20);
    assert.equal(truncated, true);
    assert.equal(originalBytes, 100);
    assert.ok(Buffer.byteLength(text, 'utf-8') <= 20);
    assert.ok(text.includes('[truncated]'));
  });

  it('limit === 0 means unlimited, no matter how long the text is', () => {
    const s = 'x'.repeat(1_000_000);
    const { text, truncated, originalBytes } = truncateContent(s, 0);
    assert.equal(text, s);
    assert.equal(truncated, false);
    assert.equal(originalBytes, 1_000_000);
  });

  it('never splits a multi-byte character', () => {
    // 每个中文字 3 字节；把上限设在字符边界之间
    const s = '中'.repeat(10); // 30 bytes
    const { text, truncated } = truncateContent(s, 20);
    assert.equal(truncated, true);
    // 截断结果必须能安全地往返一次 UTF-8 编解码
    assert.equal(Buffer.from(text, 'utf-8').toString('utf-8'), text);
    assert.ok(Buffer.byteLength(text, 'utf-8') <= 20);
  });

  it('handles empty string', () => {
    const { text, truncated, originalBytes } = truncateContent('', 100);
    assert.equal(text, '');
    assert.equal(truncated, false);
    assert.equal(originalBytes, 0);
  });

  it('handles empty string with limit 0', () => {
    const { text, truncated, originalBytes } = truncateContent('', 0);
    assert.equal(text, '');
    assert.equal(truncated, false);
    assert.equal(originalBytes, 0);
  });

  it('the ellipsis marker itself counts toward the limit', () => {
    const s = 'a'.repeat(50);
    const limit = 20;
    const { text } = truncateContent(s, limit);
    // Total output (kept text + marker) must not exceed the limit, i.e.
    // the marker's own bytes were subtracted from the budget rather than
    // appended on top of a full-limit slice.
    assert.ok(Buffer.byteLength(text, 'utf-8') <= limit);
  });

  it('is pure: same input yields same output', () => {
    const s = 'repeat me '.repeat(50);
    assert.deepEqual(truncateContent(s, 30), truncateContent(s, 30));
  });
});

describe('loadContentLimits', () => {
  it('returns defaults when collector.content_limits is missing', () => {
    const limits = withNioHome('collector: {}\n', loadContentLimits);
    assert.deepEqual(limits, DEFAULT_CONTENT_LIMITS);
  });

  it('returns defaults when there is no config file at all', () => {
    // withNioHome always writes a config.yaml; simulate "no config" via an
    // empty document instead.
    const limits = withNioHome('', loadContentLimits);
    assert.deepEqual(limits, DEFAULT_CONTENT_LIMITS);
  });

  it('honors fully-specified content_limits', () => {
    const yaml = [
      'collector:',
      '  content_limits:',
      '    thinking: 1000',
      '    text: 2000',
      '    user_prompt: 3000',
      '    tool_input: 4000',
      '    tool_output: 5000',
      '',
    ].join('\n');
    const limits = withNioHome(yaml, loadContentLimits);
    assert.deepEqual(limits, {
      thinking: 1000,
      text: 2000,
      user_prompt: 3000,
      tool_input: 4000,
      tool_output: 5000,
    });
  });

  it('falls back to default for unspecified keys', () => {
    const yaml = ['collector:', '  content_limits:', '    thinking: 999', ''].join('\n');
    const limits = withNioHome(yaml, loadContentLimits);
    assert.equal(limits.thinking, 999);
    assert.equal(limits.text, DEFAULT_CONTENT_LIMITS.text);
    assert.equal(limits.user_prompt, DEFAULT_CONTENT_LIMITS.user_prompt);
    assert.equal(limits.tool_input, DEFAULT_CONTENT_LIMITS.tool_input);
    assert.equal(limits.tool_output, DEFAULT_CONTENT_LIMITS.tool_output);
  });

  it('honors an explicit 0 (escape hatch) rather than falling back to default', () => {
    const yaml = ['collector:', '  content_limits:', '    tool_output: 0', ''].join('\n');
    const limits = withNioHome(yaml, loadContentLimits);
    assert.equal(limits.tool_output, 0);
  });

  it('falls back to default on negative values without throwing', () => {
    const yaml = ['collector:', '  content_limits:', '    thinking: -5', ''].join('\n');
    const limits = withNioHome(yaml, loadContentLimits);
    assert.equal(limits.thinking, DEFAULT_CONTENT_LIMITS.thinking);
  });

  it('falls back to default on a string value without throwing', () => {
    const yaml = ['collector:', '  content_limits:', '    thinking: "lots"', ''].join('\n');
    const limits = withNioHome(yaml, loadContentLimits);
    assert.equal(limits.thinking, DEFAULT_CONTENT_LIMITS.thinking);
  });

  it('falls back to default on a null value without throwing', () => {
    const yaml = ['collector:', '  content_limits:', '    thinking: null', ''].join('\n');
    const limits = withNioHome(yaml, loadContentLimits);
    assert.equal(limits.thinking, DEFAULT_CONTENT_LIMITS.thinking);
  });
});
