// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * OpenClaw `/nio` slash-command dispatcher.
 *
 * Wired via `command-dispatch: tool` in SKILL.md: OpenClaw routes the raw
 * slash-command args string to a plugin-registered tool, bypassing the LLM
 * entirely. This module is the body of that tool.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dump as yamlDump } from 'js-yaml';
import { loadConfig, resetConfig } from './common.js';
import type { NioConfig } from './config-schema.js';
import type { RuntimeAnalyser } from '../core/analysers/runtime/index.js';
import type { SkillScanner } from '../scanner/index.js';
import type { ActionEnvelope, ActionType, ActionData } from '../types/action.js';

const NIO_DIR = process.env.NIO_HOME || join(homedir(), '.nio');
const CONFIG_YAML_PATH = join(NIO_DIR, 'config.yaml');
const AUDIT_PATH = join(NIO_DIR, 'audit.jsonl');

const VALID_ACTION_TYPES: ActionType[] = [
  'exec_command',
  'network_request',
  'read_file',
  'write_file',
  'secret_access',
];
const VALID_LEVELS = ['strict', 'balanced', 'permissive'] as const;
type Level = (typeof VALID_LEVELS)[number];

export interface DispatchDeps {
  runtimeAnalyser: RuntimeAnalyser;
  scanner: SkillScanner;
}

export async function dispatchNioCommand(raw: string, deps: DispatchDeps): Promise<string> {
  const trimmed = (raw ?? '').trim();
  const [head = '', ...rest] = trimmed.split(/\s+/);
  const restStr = rest.join(' ').trim();

  switch (head) {
    case '':
    case 'config':
      return handleConfig(restStr);
    case 'reset':
      return handleConfig('reset');
    case 'action':
      return handleAction(restStr, deps.runtimeAnalyser);
    case 'scan':
      return handleScan(restStr, deps.scanner);
    case 'report':
      return handleReport();
    default:
      return `Unknown subcommand: ${head}\n\n${usageText()}`;
  }
}

function usageText(): string {
  return [
    'Usage:',
    '  /nio config [show]                        — show current config',
    '  /nio config <strict|balanced|permissive>  — set protection level',
    '  /nio config reset                         — reset config to defaults',
    '  /nio action <type>: <body>                — evaluate a runtime action',
    '     types: exec_command, network_request, read_file, write_file, secret_access',
    '     examples:',
    '       action exec_command: ls -la',
    '       action network_request: POST https://example.com body',
    '       action read_file: /etc/passwd',
    '       action secret_access: AWS_KEY read',
    '  /nio scan <path>                          — static scan of a directory',
    '  /nio report                               — recent audit events',
  ].join('\n');
}

// ── config ───────────────────────────────────────────────────────────────────

function handleConfig(rest: string): string {
  const sub = rest.trim();

  if (sub === '' || sub === 'show') {
    return JSON.stringify(loadConfig(), null, 2);
  }

  if (sub === 'reset') {
    const cfg = resetConfig();
    return `Config reset to defaults.\n\n${JSON.stringify(cfg, null, 2)}`;
  }

  if ((VALID_LEVELS as readonly string[]).includes(sub)) {
    const updated = setProtectionLevel(sub as Level);
    return `Protection level set to: ${sub}\n\n${JSON.stringify(updated, null, 2)}`;
  }

  return `Unknown config subcommand: ${sub}\n\n${usageText()}`;
}

function setProtectionLevel(level: Level): NioConfig {
  const current = loadConfig();
  const merged: NioConfig = {
    ...current,
    guard: { ...(current.guard ?? {}), protection_level: level },
  };
  writeFileSync(CONFIG_YAML_PATH, yamlDump(merged));
  return merged;
}

// ── action ───────────────────────────────────────────────────────────────────

async function handleAction(rest: string, runtimeAnalyser: RuntimeAnalyser): Promise<string> {
  const parsed = parseActionEnvelope(rest);
  if (!parsed.ok) return parsed.error;
  const result = await runtimeAnalyser.evaluate(parsed.value);
  return JSON.stringify(result, null, 2);
}

type ParseResult =
  | { ok: true; value: ActionEnvelope }
  | { ok: false; error: string };

function parseActionEnvelope(rest: string): ParseResult {
  const m = rest.match(/^(\w+)\s*:\s*([\s\S]+)$/);
  if (!m) {
    return {
      ok: false,
      error: `Could not parse action. Expected "<type>: <body>".\n\n${usageText()}`,
    };
  }

  const rawType = m[1].toLowerCase() as ActionType;
  const body = m[2].trim();

  if (!VALID_ACTION_TYPES.includes(rawType)) {
    return {
      ok: false,
      error: `Unknown action type: ${rawType}. Valid types: ${VALID_ACTION_TYPES.join(', ')}`,
    };
  }

  let data: ActionData;
  switch (rawType) {
    case 'exec_command':
      data = { command: body };
      break;
    case 'read_file':
    case 'write_file':
      data = { path: body };
      break;
    case 'network_request': {
      const nm = body.match(/^(\S+)\s+(\S+)(?:\s+([\s\S]+))?$/);
      if (!nm) {
        return { ok: false, error: 'network_request: expected "<METHOD> <URL> [body]"' };
      }
      const rawMethod = nm[1].toUpperCase();
      const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;
      if (!(validMethods as readonly string[]).includes(rawMethod)) {
        return {
          ok: false,
          error: `network_request: unsupported method ${rawMethod}. Use one of: ${validMethods.join(', ')}`,
        };
      }
      data = {
        method: rawMethod as (typeof validMethods)[number],
        url: nm[2],
        body_preview: nm[3],
      };
      break;
    }
    case 'secret_access': {
      const sm = body.match(/^(\S+)(?:\s+(read|write))?$/);
      if (!sm) {
        return { ok: false, error: 'secret_access: expected "<name> [read|write]"' };
      }
      data = {
        secret_name: sm[1],
        access_type: (sm[2] ?? 'read') as 'read' | 'write',
      };
      break;
    }
  }

  return {
    ok: true,
    value: {
      actor: {
        skill: {
          id: 'openclaw-dispatch',
          source: 'openclaw',
          version_ref: '0.0.0',
          artifact_hash: '',
        },
      },
      action: { type: rawType, data },
      context: {
        session_id: `openclaw-${Date.now()}`,
        user_present: false,
        env: 'prod',
        time: new Date().toISOString(),
      },
    },
  };
}

// ── scan ─────────────────────────────────────────────────────────────────────

async function handleScan(rest: string, scanner: SkillScanner): Promise<string> {
  const path = rest.trim() || '.';
  try {
    const result = await scanner.quickScan(path);
    return [
      `## Nio Scan — ${path}`,
      '',
      `**Risk Level**: ${result.risk_level.toUpperCase()}`,
      `**Risk Tags**: ${result.risk_tags.length ? result.risk_tags.join(', ') : '(none)'}`,
      '',
      result.summary || '(no findings)',
    ].join('\n');
  } catch (err) {
    return `Scan failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── report ───────────────────────────────────────────────────────────────────

function handleReport(): string {
  if (!existsSync(AUDIT_PATH)) {
    return `No security events recorded yet.\n\nAudit log: ${AUDIT_PATH}`;
  }

  let lines: string[];
  try {
    lines = readFileSync(AUDIT_PATH, 'utf-8').split('\n').filter(Boolean);
  } catch (err) {
    return `Failed to read audit log: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (lines.length === 0) return 'No security events recorded yet.';

  const entries = lines
    .slice(-50)
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((e): e is Record<string, unknown> => e !== null);

  const blocked = entries.filter((e) => e.decision === 'deny').length;
  const confirmed = entries.filter((e) => e.decision === 'ask' || e.decision === 'confirm').length;

  const rows = entries.map((e) => {
    const ts = typeof e.timestamp === 'string' ? e.timestamp.slice(11, 19) : '—';
    const tool = (e.tool_name as string | undefined) ?? (e.event as string | undefined) ?? '—';
    const decision = (e.decision as string | undefined) ?? '—';
    const risk = (e.risk_level as string | undefined) ?? '—';
    const tags = Array.isArray(e.risk_tags) ? (e.risk_tags as string[]).join(',') : '—';
    return `| ${ts} | ${tool} | ${decision} | ${risk} | ${tags} |`;
  });

  return [
    '## Nio Security Report',
    '',
    `**Events**: ${entries.length}`,
    `**Blocked**: ${blocked}`,
    `**Confirmed**: ${confirmed}`,
    '',
    '| Time | Tool | Decision | Risk | Tags |',
    '|------|------|----------|------|------|',
    ...rows,
  ].join('\n');
}
