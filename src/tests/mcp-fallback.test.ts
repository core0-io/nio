// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateHook, buildMcpEnvelope } from '../adapters/hook-engine.js';
import type { HookInput } from '../adapters/types.js';
import { createTestContext } from './helpers/test-utils.js';
import { trackTempDir } from './helpers/tmp-dirs.js';

function freshDir(): string {
  return trackTempDir(mkdtempSync(join(tmpdir(), 'nio-mcp-fallback-')));
}

function readEntries(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ── buildMcpEnvelope ────────────────────────────────────────────────────

describe('buildMcpEnvelope', () => {
  const baseInput: HookInput = {
    toolName: 'mcp__hass__HassTurnOn',
    toolInput: { entity_id: 'light.kitchen' },
    eventType: 'pre',
    sessionId: 'sess-123',
    cwd: '/tmp',
    raw: {},
  };

  it('builds mcp_tool_call envelope with server + tool + args', () => {
    const env = buildMcpEnvelope(
      baseInput,
      { isMcp: true, server: 'hass', local: 'HassTurnOn' },
      null,
      'claude-code',
    );
    assert.equal(env.action.type, 'mcp_tool_call');
    assert.deepEqual(env.action.data, {
      server: 'hass',
      tool: 'HassTurnOn',
      args: { entity_id: 'light.kitchen' },
    });
    assert.equal(env.context.session_id, 'sess-123');
  });

  it('stores server=null and full tool name when parsed.server is undefined (hermes mcp_ form)', () => {
    const env = buildMcpEnvelope(
      { ...baseInput, toolName: 'mcp_config_db_get_current_config' },
      { isMcp: true, local: 'mcp_config_db_get_current_config' },
      null,
      'hermes',
    );
    const data = env.action.data as { server: string | null; tool: string };
    assert.equal(data.server, null);
    assert.equal(data.tool, 'mcp_config_db_get_current_config');
  });

  it('preserves initiatingSkill in actor + context', () => {
    const env = buildMcpEnvelope(
      baseInput,
      { isMcp: true, server: 'hass', local: 'HassTurnOn' },
      'mcp-control',
      'claude-code',
    );
    assert.equal(env.actor.skill.id, 'mcp-control');
    assert.equal(env.context.initiating_skill, 'mcp-control');
  });

  it('falls back to <platform>-session when no skill provided', () => {
    const env = buildMcpEnvelope(
      baseInput,
      { isMcp: true, server: 'hass', local: 'HassTurnOn' },
      null,
      'hermes',
    );
    assert.equal(env.actor.skill.id, 'hermes-session');
    assert.equal(env.actor.skill.source, 'hermes');
  });

  it('synthesises session_id when input.sessionId is missing', () => {
    const env = buildMcpEnvelope(
      { ...baseInput, sessionId: undefined },
      { isMcp: true, server: 'hass', local: 'HassTurnOn' },
      null,
      'hermes',
    );
    assert.match(env.context.session_id, /^hermes-mcp-\d+$/);
  });
});

// ── evaluateHook: MCP fallback produces mcp_tool_call envelope ─────────

describe('evaluateHook: MCP fallback across adapters', () => {
  let ctx: ReturnType<typeof createTestContext>;
  let dir: string;
  afterEach(() => {
    ctx?.cleanup();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('Claude Code: mcp__server__tool → mcp_tool_call envelope, guard audit written', async () => {
    ctx = createTestContext('balanced');
    dir = freshDir();
    const auditPath = join(dir, 'audit.jsonl');

    const result = await evaluateHook(
      ctx.claudeAdapter,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__hass__HassTurnOn',
        tool_input: { entity_id: 'light.kitchen' },
      },
      ctx.options,
      { logsConfig: { path: auditPath } },
    );

    assert.equal(result.decision, 'allow');
    const entries = readEntries(auditPath);
    assert.equal(entries.length, 1, 'guard audit entry must be written for MCP fallback');
    assert.equal(entries[0]!['event'], 'guard');
    assert.equal(entries[0]!['action_type'], 'mcp_tool_call');
    assert.equal(entries[0]!['decision'], 'allow');
    assert.equal(entries[0]!['tool_name'], 'mcp__hass__HassTurnOn');
  });

  it('Codex: mcp__server__tool → mcp_tool_call envelope, guard audit written', async () => {
    ctx = createTestContext('balanced');
    dir = freshDir();
    const auditPath = join(dir, 'audit.jsonl');

    const result = await evaluateHook(
      ctx.codexAdapter,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__github__create_issue',
        tool_input: { title: 'test' },
      },
      ctx.options,
      { logsConfig: { path: auditPath } },
    );

    assert.equal(result.decision, 'allow');
    const entries = readEntries(auditPath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!['action_type'], 'mcp_tool_call');
  });

  it('OpenClaw: server__tool → mcp_tool_call envelope, guard audit written', async () => {
    ctx = createTestContext('balanced');
    dir = freshDir();
    const auditPath = join(dir, 'audit.jsonl');

    const result = await evaluateHook(
      ctx.openclawAdapter,
      { toolName: 'hass__HassTurnOn', params: { entity_id: 'light.kitchen' } },
      ctx.options,
      { logsConfig: { path: auditPath } },
    );

    assert.equal(result.decision, 'allow');
    const entries = readEntries(auditPath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!['action_type'], 'mcp_tool_call');
  });

  it('Hermes (double-underscore): server__tool → mcp_tool_call envelope', async () => {
    ctx = createTestContext('balanced');
    dir = freshDir();
    const auditPath = join(dir, 'audit.jsonl');

    const result = await evaluateHook(
      ctx.hermesAdapter,
      {
        hook_event_name: 'pre_tool_call',
        tool_name: 'hass__HassTurnOn',
        tool_input: { entity_id: 'light.kitchen' },
      },
      ctx.options,
      { logsConfig: { path: auditPath } },
    );

    assert.equal(result.decision, 'allow');
    const entries = readEntries(auditPath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!['action_type'], 'mcp_tool_call');
  });

  it('Hermes (single-underscore): mcp_xxx → mcp_tool_call envelope, server=null', async () => {
    ctx = createTestContext('balanced');
    dir = freshDir();
    const auditPath = join(dir, 'audit.jsonl');

    const result = await evaluateHook(
      ctx.hermesAdapter,
      {
        hook_event_name: 'pre_tool_call',
        tool_name: 'mcp_config_db_get_current_config',
        tool_input: { device_id: 'firewall-01' },
      },
      ctx.options,
      { logsConfig: { path: auditPath } },
    );

    assert.equal(result.decision, 'allow');
    const entries = readEntries(auditPath);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!['action_type'], 'mcp_tool_call');
    assert.equal(entries[0]!['tool_name'], 'mcp_config_db_get_current_config');
  });
});

// ── evaluateHook: UNCATEGORIZED_TOOL audit fallback ─────────────────────

describe('evaluateHook: UNCATEGORIZED_TOOL fallback', () => {
  let ctx: ReturnType<typeof createTestContext>;
  let dir: string;
  afterEach(() => {
    ctx?.cleanup();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('writes UNCATEGORIZED_TOOL audit entry for unknown non-MCP tool', async () => {
    ctx = createTestContext('balanced');
    dir = freshDir();
    const auditPath = join(dir, 'audit.jsonl');

    const result = await evaluateHook(
      ctx.claudeAdapter,
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'SomeRandomTool',
        tool_input: { foo: 'bar' },
      },
      ctx.options,
      { logsConfig: { path: auditPath } },
    );

    assert.equal(result.decision, 'allow');
    const entries = readEntries(auditPath);
    assert.equal(entries.length, 1, 'audit entry must be written for uncategorised tools');
    assert.equal(entries[0]!['event'], 'guard');
    assert.equal(entries[0]!['decision'], 'allow');
    assert.deepEqual(entries[0]!['risk_tags'], ['UNCATEGORIZED_TOOL:SomeRandomTool']);
    assert.equal(entries[0]!['phase_stopped'], 0);
  });
});

// ── Phase 0 permitted_tools.mcp gate: hermes mcp_ single-underscore ────

describe('Phase 0 permitted_tools.mcp: hermes mcp_ single-underscore', () => {
  let ctx: ReturnType<typeof createTestContext>;
  afterEach(() => ctx?.cleanup());

  it('mcp_xxx tool matches verbatim against permitted_tools.mcp (no prefix stripping)', async () => {
    ctx = createTestContext({
      level: 'balanced',
      guard: {
        permitted_tools: {
          mcp: ['mcp_config_db_get_current_config'],
        },
      },
    });

    const result = await evaluateHook(
      ctx.hermesAdapter,
      {
        hook_event_name: 'pre_tool_call',
        tool_name: 'mcp_config_db_get_current_config',
        tool_input: { device_id: 'firewall-01' },
      },
      ctx.options,
    );
    assert.equal(result.decision, 'allow');
  });

  it('mcp_xxx tool NOT in permitted_tools.mcp is denied at Phase 0', async () => {
    ctx = createTestContext({
      level: 'balanced',
      guard: {
        permitted_tools: {
          mcp: ['mcp_config_db_get_current_config'],
        },
      },
    });

    const result = await evaluateHook(
      ctx.hermesAdapter,
      {
        hook_event_name: 'pre_tool_call',
        tool_name: 'mcp_some_other_call',
        tool_input: {},
      },
      ctx.options,
    );
    assert.equal(result.decision, 'deny');
    assert.ok(result.riskTags?.includes('TOOL_GATE_NOT_PERMITTED'));
  });

  it('mcp_xxx tool listed in blocked_tools.mcp is denied at Phase 0', async () => {
    ctx = createTestContext({
      level: 'balanced',
      guard: {
        blocked_tools: {
          mcp: ['mcp_config_db_update_current_config'],
        },
      },
    });

    const result = await evaluateHook(
      ctx.hermesAdapter,
      {
        hook_event_name: 'pre_tool_call',
        tool_name: 'mcp_config_db_update_current_config',
        tool_input: {},
      },
      ctx.options,
    );
    assert.equal(result.decision, 'deny');
    assert.ok(result.riskTags?.includes('TOOL_GATE_BLOCKED'));
  });
});

// ── Orchestrator Phase 3: secret in MCP args ────────────────────────────

describe('Orchestrator Phase 3: secret-in-args detection for mcp_tool_call', () => {
  let ctx: ReturnType<typeof createTestContext>;
  afterEach(() => ctx?.cleanup());

  it('user-injected secrets pattern via file_scan_rules.secrets fires on MCP args', async () => {
    // file_scan_rules.secrets adds patterns to every rule in the SECRETS
    // module. PRIVATE_KEY_PATTERN has file_patterns: ['*'] so the user
    // pattern reaches our virtual .json path. Tests the injection path
    // end-to-end for the new mcp_tool_call action type.
    ctx = createTestContext({
      level: 'balanced',
      guard: {
        file_scan_rules: {
          secrets: ['/NIO_TEST_LEAK_[A-Z0-9]{16}/'],
        },
      },
    });

    const result = await evaluateHook(
      ctx.hermesAdapter,
      {
        hook_event_name: 'pre_tool_call',
        tool_name: 'mcp_config_db_update_current_config',
        tool_input: {
          marker: 'NIO_TEST_LEAK_ABCDEF1234567890',
        },
      },
      ctx.options,
    );

    assert.notEqual(result.decision, 'allow', 'user-injected secrets pattern must trigger non-allow');
  });
});
