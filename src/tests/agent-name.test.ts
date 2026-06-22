// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * agent_name config field — telemetry-identity override coverage.
 *
 * Verifies the four observable contracts:
 *   1. NioConfigSchema accepts top-level agent_name
 *   2. genAiInvokeAgentAttributes does NOT emit gen_ai.agent.name (identity on Resource)
 *   3. auditEntryAttributes emits gen_ai.agent.name only when entry carries it
 *   4. buildGuardAuditEntry writes agent_name only when given
 *
 * The full end-to-end (config → dispatch → real span) is covered by
 * the dispatchCollectorEvent path; here we cover the seams.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { NioConfigSchema } from '../adapters/config-schema.js';
import { genAiInvokeAgentAttributes, nioResourceAttributes } from '../scripts/lib/traces-collector.js';
import { auditEntryAttributes } from '../scripts/lib/logs-collector.js';
import { buildGuardAuditEntry } from '../adapters/common.js';
import type { HookInput } from '../adapters/types.js';

// ── 1. Schema acceptance ────────────────────────────────────────────────

describe('NioConfigSchema.agent_name', () => {
  it('accepts a top-level string', () => {
    const parsed = NioConfigSchema.parse({ agent_name: 'alice-laptop' });
    assert.equal(parsed.agent_name, 'alice-laptop');
  });

  it('is optional (no error when omitted)', () => {
    const parsed = NioConfigSchema.parse({});
    assert.equal(parsed.agent_name, undefined);
  });

  it('rejects non-string values', () => {
    assert.throws(() => NioConfigSchema.parse({ agent_name: 42 }));
  });
});

// ── 2. genAiInvokeAgentAttributes — span attribute ──────────────────────

describe('genAiInvokeAgentAttributes', () => {
  it('does NOT emit gen_ai.agent.name (identity comes from the Resource)', () => {
    const attrs = genAiInvokeAgentAttributes('sess-1');
    assert.equal(attrs['gen_ai.agent.name'], undefined);
    assert.equal(attrs['gen_ai.conversation.id'], 'sess-1');
    assert.equal(attrs['session.id'], 'sess-1');
    assert.equal(attrs['gen_ai.operation.name'], 'invoke_agent');
  });

  it('passes through extra attributes', () => {
    const attrs = genAiInvokeAgentAttributes('sess-2', { 'nio.turn_number': 3 });
    assert.equal(attrs['nio.turn_number'], 3);
    assert.equal(attrs['gen_ai.agent.name'], undefined);
  });
});

// ── 3. auditEntryAttributes — OTEL log attribute ────────────────────────

describe('auditEntryAttributes', () => {
  it('does NOT emit gen_ai.agent.name or nio.platform (Resource carries them)', () => {
    const attrs = auditEntryAttributes({
      event: 'PreToolUse', platform: 'claude-code', agent_name: 'alice-laptop',
    } as never);
    assert.equal(attrs['gen_ai.agent.name'], undefined);
    assert.equal(attrs['nio.platform'], undefined);
    assert.equal(attrs['nio.event'], 'PreToolUse');
  });
});

// ── 4. buildGuardAuditEntry — JSONL audit-log shape ─────────────────────

describe('buildGuardAuditEntry agent_name handling', () => {
  const input: HookInput = {
    toolName: 'Bash',
    toolInput: { command: 'ls /tmp' },
    sessionId: 'sess-1',
    eventType: 'pre',
    raw: {},
  } as unknown as HookInput;

  it('includes agent_name field when provided', () => {
    const entry = buildGuardAuditEntry(input, null, null, 'claude-code', undefined, 'alice-laptop');
    assert.equal(entry.platform, 'claude-code');
    assert.equal(entry.agent_name, 'alice-laptop');
  });

  it('omits agent_name field when not provided (back-compat)', () => {
    const entry = buildGuardAuditEntry(input, null, null, 'claude-code');
    assert.equal(entry.platform, 'claude-code');
    assert.equal(entry.agent_name, undefined);
  });

  it('omits agent_name when given an empty string', () => {
    const entry = buildGuardAuditEntry(input, null, null, 'claude-code', undefined, '');
    assert.equal(entry.agent_name, undefined);
  });
});

// ── 5. nioResourceAttributes — pure attribute builder ─────────────────────

describe('nioResourceAttributes', () => {
  it('carries service.name, nio.platform, and gen_ai.agent.name when configured', () => {
    const r = nioResourceAttributes('claude-code', 'alice-laptop');
    assert.equal(r['service.name'], 'nio-claude-code');
    assert.equal(r['nio.platform'], 'claude-code');
    assert.equal(r['gen_ai.agent.name'], 'alice-laptop');
  });

  it('omits gen_ai.agent.name when agentName is empty or absent', () => {
    assert.equal(nioResourceAttributes('hermes', '')['gen_ai.agent.name'], undefined);
    assert.equal(nioResourceAttributes('hermes')['gen_ai.agent.name'], undefined);
  });
});
