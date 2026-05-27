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
import type { ActionOrchestrator } from '../core/action-orchestrator.js';
import type { SkillScanner } from '../scanner/index.js';
import type { ActionEnvelope, ActionType, ActionData } from '../types/action.js';

// Resolved lazily so tests can set NIO_HOME after this module is imported.
function nioDir(): string { return process.env.NIO_HOME || join(homedir(), '.nio'); }
function configYamlPath(): string { return join(nioDir(), 'config.yaml'); }
function auditPath(): string { return join(nioDir(), 'audit.jsonl'); }

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
  orchestrator: ActionOrchestrator;
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
      return handleAction(restStr, deps.orchestrator);
    case 'scan':
      return handleScan(restStr, deps.scanner);
    case 'report':
      return handleReport();
    case 'doctor':
      return handleDoctor();
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
    '  /nio report                               — recent audit events + diagnostics summary',
    '  /nio doctor                               — dry-run validate config + test OAuth/LLM/collector connectivity',
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
  writeFileSync(configYamlPath(), yamlDump(merged));
  return merged;
}

// ── action ───────────────────────────────────────────────────────────────────

async function handleAction(rest: string, orchestrator: ActionOrchestrator): Promise<string> {
  const parsed = parseActionEnvelope(rest);
  if (!parsed.ok) return parsed.error;
  const result = await orchestrator.evaluate(parsed.value);
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
  if (!existsSync(auditPath())) {
    return `No execution events recorded yet.\n\nAudit log: ${auditPath()}`;
  }

  let lines: string[];
  try {
    lines = readFileSync(auditPath(), 'utf-8').split('\n').filter(Boolean);
  } catch (err) {
    return `Failed to read audit log: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (lines.length === 0) return 'No execution events recorded yet.';

  // Look back across a wider window than the decision table so diagnostics
  // that fire on every action don't crowd everything else out. The decision
  // table still uses the last 50 entries; the diagnostics summary aggregates
  // up to the last 200 events.
  const tail = lines.slice(-200);
  const allEntries = tail
    .map((l) => {
      try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; }
    })
    .filter((e): e is Record<string, unknown> => e !== null);

  // Decision table (guard events only)
  const decisionEntries = allEntries.filter(e => e.event === 'guard').slice(-50);
  const blocked = decisionEntries.filter((e) => e.decision === 'deny').length;
  const confirmed = decisionEntries.filter((e) => e.decision === 'ask' || e.decision === 'confirm').length;

  const rows = decisionEntries.map((e) => {
    const ts = typeof e.timestamp === 'string' ? e.timestamp.slice(11, 19) : '—';
    const tool = (e.tool_name as string | undefined) ?? (e.event as string | undefined) ?? '—';
    const decision = (e.decision as string | undefined) ?? '—';
    const risk = (e.risk_level as string | undefined) ?? '—';
    const tags = Array.isArray(e.risk_tags) ? (e.risk_tags as string[]).join(',') : '—';
    return `| ${ts} | ${tool} | ${decision} | ${risk} | ${tags} |`;
  });

  const out = [
    '## Nio Security Report',
    '',
    `**Events**: ${decisionEntries.length}`,
    `**Blocked**: ${blocked}`,
    `**Confirmed**: ${confirmed}`,
    '',
    '| Time | Tool | Decision | Risk | Tags |',
    '|------|------|----------|------|------|',
    ...rows,
  ];

  // Diagnostics summary — aggregate by (source, kind, component, config_path).
  const diagSection = formatDiagnosticsAggregate(allEntries);
  if (diagSection) {
    out.push('', diagSection);
  }

  return out.join('\n');
}

interface DiagAggregate {
  count: number;
  source: string;
  kind: string;
  component: string;
  config_path: string;
  first_seen: string;
  last_seen: string;
  latest_message: string;
  latest_hint?: string;
}

function formatDiagnosticsAggregate(entries: ReadonlyArray<Record<string, unknown>>): string {
  const diags = entries.filter(e => e.event === 'diagnostic');
  if (diags.length === 0) return '';

  const groups = new Map<string, DiagAggregate>();
  for (const d of diags) {
    const source = String(d.source ?? '—');
    const kind = String(d.kind ?? '—');
    const component = String(d.component ?? '—');
    const configPath = String(d.config_path ?? '—');
    const key = `${source}|${kind}|${component}|${configPath}`;
    const ts = typeof d.timestamp === 'string' ? d.timestamp : '';
    const msg = String(d.message ?? '');
    const hint = d.hint != null ? String(d.hint) : undefined;

    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (ts && ts > existing.last_seen) {
        existing.last_seen = ts;
        existing.latest_message = msg;
        existing.latest_hint = hint;
      }
      if (ts && (!existing.first_seen || ts < existing.first_seen)) {
        existing.first_seen = ts;
      }
    } else {
      groups.set(key, {
        count: 1,
        source, kind, component, config_path: configPath,
        first_seen: ts, last_seen: ts,
        latest_message: msg, latest_hint: hint,
      });
    }
  }

  const sorted = [...groups.values()].sort((a, b) =>
    b.last_seen.localeCompare(a.last_seen) || b.count - a.count,
  );

  const fmt = (s: string) => s.length > 11 ? s.slice(11, 19) : s;
  const rows = sorted.map(g =>
    `| ${g.count} | ${g.source} | ${g.kind} | ${g.component} | ${fmt(g.first_seen)} | ${fmt(g.last_seen)} | ${g.latest_message.replace(/\|/g, '\\|')} |`,
  );

  const hints = sorted
    .filter(g => g.latest_hint)
    .map(g => `  - ${g.source} ${g.kind}: ${g.latest_hint}`);

  const out = [
    `## Diagnostics (last ${diags.length} of ${entries.length} events)`,
    '',
    '| Count | Source | Kind | Component | First seen | Last seen | Latest message |',
    '|-------|--------|------|-----------|------------|-----------|----------------|',
    ...rows,
  ];
  if (hints.length > 0) {
    out.push('', 'Hints:', ...hints);
  }
  out.push('', 'Run `/nio doctor` to dry-run a config check.');
  return out.join('\n');
}

// ── doctor ───────────────────────────────────────────────────────────────────

/**
 * Run a series of dry-run health checks against the current config and report
 * each as ✓ / ✗. Network checks (OAuth, collector reachability) actually hit
 * the configured endpoints, so this is the canonical place users go BEFORE
 * triggering a hook to validate setup.
 */
async function handleDoctor(): Promise<string> {
  const out: string[] = ['## Nio Doctor', ''];

  // ─── Configuration ──────────────────────────────────────────────────
  out.push('### Configuration');

  let config: NioConfig;
  let configLoadOk = true;
  try {
    config = loadConfig();
  } catch (err) {
    configLoadOk = false;
    out.push(`- ✗ ${configYamlPath()}: ${err instanceof Error ? err.message : String(err)}`);
    config = {} as NioConfig;
  }
  if (configLoadOk) {
    // Even when loadConfig returns successfully, it may have logged a
    // diagnostic and silently fallen back to defaults. Detect that by
    // re-running validateConfig on the raw YAML.
    let validationIssues: string[] = [];
    if (existsSync(configYamlPath())) {
      try {
        const { load: yamlLoad } = await import('js-yaml');
        const { validateConfig } = await import('./config-schema.js');
        const raw = yamlLoad(readFileSync(configYamlPath(), 'utf-8'));
        validateConfig(raw, configYamlPath());
      } catch (err) {
        validationIssues = String(err instanceof Error ? err.message : err).split('\n').filter(Boolean);
      }
    }
    if (validationIssues.length === 0) {
      out.push(`- ✓ ${configYamlPath()} loaded successfully`);
    } else {
      out.push(`- ✗ ${configYamlPath()} has schema issues:`);
      for (const issue of validationIssues) out.push(`    ${issue}`);
    }
  }

  // ─── External Analysers ─────────────────────────────────────────────
  const externals = config.guard?.external_analyser ?? [];
  if (externals.length > 0) {
    out.push('', `### External Analysers (${externals.length} configured)`);
    for (const entry of externals) {
      if (entry.enabled === false) {
        out.push(`- · ${entry.name} (${entry.endpoint}) — disabled`);
        continue;
      }
      const authLabel = entry.auth?.type ? ` [${entry.auth.type}]` : ' [no auth]';
      const result = await probeExternalAnalyser(entry);
      if (result.ok) {
        out.push(`- ✓ ${entry.name} (${entry.endpoint}) — ${result.message}${authLabel}`);
      } else {
        out.push(`- ✗ ${entry.name} (${entry.endpoint})${authLabel}: ${result.message}`);
        if (result.hint) out.push(`    hint: ${result.hint}`);
      }
    }
  }

  // ─── LLM Analyser ───────────────────────────────────────────────────
  const llm = config.guard?.llm_analyser;
  if (llm?.enabled || llm?.api_key) {
    out.push('', '### LLM Analyser');
    if (llm?.enabled && !llm?.api_key) {
      out.push('- ✗ guard.llm_analyser.enabled=true but api_key is empty');
      out.push('    hint: Set guard.llm_analyser.api_key to an Anthropic API key, or set enabled: false.');
    } else if (llm?.api_key && !llm?.enabled) {
      out.push('- · guard.llm_analyser.api_key set but enabled=false (Phase 5 is OFF)');
    } else if (llm?.enabled && llm?.api_key) {
      out.push('- ✓ enabled with api_key set (key validity not actually tested)');
    }
  }

  // ─── Collector ──────────────────────────────────────────────────────
  const collector = config.collector;
  if (collector?.endpoint) {
    out.push('', '### Collector');
    const result = await dryRunCollector(collector.endpoint, collector.timeout);
    if (result.ok) {
      out.push(`- ✓ ${collector.endpoint} reachable (${result.message})`);
    } else {
      out.push(`- ✗ ${collector.endpoint}: ${result.message}`);
    }
  }

  return out.join('\n');
}

interface DryRunResult {
  ok: boolean;
  message: string;
  hint?: string;
}

/**
 * Probe a single external_analyser entry end-to-end: build its auth strategy,
 * GET the scoring endpoint with all the configured machinery (headers,
 * headers, auth), and verify the response shape. Returns the actual
 * returned score on success so the user can confirm the endpoint is
 * answering plausibly. Uses a silent DiagnosticCollector so the probe does
 * not write anything to the audit log.
 */
async function probeExternalAnalyser(
  entry: NonNullable<NonNullable<NioConfig['guard']>['external_analyser']>[number],
): Promise<DryRunResult> {
  const { ExternalAnalyser } = await import('../core/analysers/external/index.js');
  const { BearerAuthStrategy, getOrCreateOAuthStrategy } = await import('../core/analysers/external/auth.js');
  const { DiagnosticCollector } = await import('./diagnostics.js');

  let auth;
  if (entry.auth?.type === 'bearer') {
    auth = new BearerAuthStrategy(entry.auth.api_key);
  } else if (entry.auth?.type === 'oauth') {
    auth = getOrCreateOAuthStrategy({
      oauthUrl:     entry.auth.oauth_url,
      clientId:     entry.auth.client_id,
      clientSecret: entry.auth.client_secret,
    });
  }

  const scorer = new ExternalAnalyser({
    name:     entry.name,
    endpoint: entry.endpoint,
    headers:  entry.headers,
    timeout:  entry.timeout,
    weight:   entry.weight,
    auth,
  });

  // Silent reporter — doctor's probe must not pollute the audit log.
  const reporter = new DiagnosticCollector(true);
  const result = await scorer.call(reporter);

  if (result) {
    const reason = result.reason ? ` — ${result.reason}` : '';
    return { ok: true, message: `score ${result.score}${reason}` };
  }

  const last = reporter.take().pop();
  return {
    ok: false,
    message: last?.detail ?? last?.message ?? 'request failed',
    hint: last?.hint,
  };
}

async function dryRunCollector(endpoint: string, timeoutMs?: number): Promise<DryRunResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? 3000);
  try {
    const resp = await fetch(endpoint, { method: 'HEAD', signal: controller.signal });
    clearTimeout(timer);
    // 4xx/5xx is still "reachable" — OTLP collectors commonly 405 a bare HEAD.
    return { ok: true, message: `HTTP ${resp.status} on HEAD` };
  } catch (err) {
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  }
}
