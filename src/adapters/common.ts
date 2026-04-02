import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { HookInput } from './types.js';
import type { RiskLevel } from '../types/scanner.js';
import { riskLevelToNumericScore } from '../types/scanner.js';
import { validateConfig } from './config-schema.js';
import type { AgentGuardConfig, MetricsConfig, ResolvedMetricsConfig } from './config-schema.js';
export type { AgentGuardConfig, MetricsConfig, ResolvedMetricsConfig } from './config-schema.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const FFWD_AGENT_GUARD_DIR = process.env.FFWD_AGENT_GUARD_HOME || join(homedir(), '.ffwd-agent-guard');
const CONFIG_PATH = join(FFWD_AGENT_GUARD_DIR, 'config.json');
const CONFIG_DEFAULT_PATH = join(dirname(__filename), '..', '..', 'config.default.json');
const AUDIT_PATH = join(FFWD_AGENT_GUARD_DIR, 'audit.jsonl');

function ensureDir(): void {
  if (!existsSync(FFWD_AGENT_GUARD_DIR)) {
    mkdirSync(FFWD_AGENT_GUARD_DIR, { recursive: true });
  }
}

function loadDefaults(): AgentGuardConfig {
  const raw = JSON.parse(readFileSync(CONFIG_DEFAULT_PATH, 'utf-8'));
  return validateConfig(raw, CONFIG_DEFAULT_PATH);
}

const CONFIG_DEFAULTS: AgentGuardConfig = loadDefaults();

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

export function resetConfig(): AgentGuardConfig {
  ensureDir();
  writeFileSync(CONFIG_PATH, readFileSync(CONFIG_DEFAULT_PATH, 'utf-8'));
  return { ...CONFIG_DEFAULTS };
}

export function loadConfig(): AgentGuardConfig {
  if (!existsSync(CONFIG_PATH)) {
    try {
      ensureDir();
      writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG_DEFAULTS, null, 2) + '\n');
    } catch {
      // Best-effort: filesystem may be read-only
    }
    return { ...CONFIG_DEFAULTS };
  }

  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  const validated = validateConfig(raw, CONFIG_PATH);
  return { ...CONFIG_DEFAULTS, ...validated };
}

export function loadMetricsConfig(): ResolvedMetricsConfig {
  const config = loadConfig();
  const m = config.metrics ?? {};

  const endpoint = m.endpoint ?? '';
  const api_key = m.api_key ?? '';
  const timeout = m.timeout || 5000;
  let log = m.log ?? '';

  if (log.startsWith('~/')) {
    log = join(homedir(), log.slice(2));
  }

  return { endpoint, api_key, timeout, log, enabled: !!(endpoint || log) };
}

// ---------------------------------------------------------------------------
// Sensitive path detection
// ---------------------------------------------------------------------------

const SENSITIVE_PATHS = [
  '.env', '.env.local', '.env.production',
  '.ssh/', 'id_rsa', 'id_ed25519',
  '.aws/credentials', '.aws/config',
  '.npmrc', '.netrc',
  'credentials.json', 'serviceAccountKey.json',
  '.kube/config',
];

export function isSensitivePath(filePath: string): boolean {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, '/');
  return SENSITIVE_PATHS.some(
    (p) => normalized.includes(`/${p}`) || normalized.endsWith(p)
  );
}

// ---------------------------------------------------------------------------
// Protection level thresholds
// ---------------------------------------------------------------------------

export function shouldDenyAtLevel(
  decision: { decision: string; risk_level?: string },
  config: { level?: string }
): boolean {
  const level = config.level || 'balanced';

  if (level === 'strict') {
    return decision.decision === 'deny' || decision.decision === 'confirm';
  }

  if (level === 'balanced') {
    return decision.decision === 'deny';
  }

  if (level === 'permissive') {
    return decision.decision === 'deny' && decision.risk_level === 'critical';
  }

  return decision.decision === 'deny';
}

export function shouldAskAtLevel(
  decision: { decision: string; risk_level?: string },
  config: { level?: string }
): boolean {
  const level = config.level || 'balanced';

  if (level === 'strict') {
    return false;
  }

  if (level === 'balanced') {
    return decision.decision === 'confirm';
  }

  if (level === 'permissive') {
    return (
      (decision.decision === 'deny' && decision.risk_level !== 'critical') ||
      (decision.decision === 'confirm' &&
        (decision.risk_level === 'high' || decision.risk_level === 'critical'))
    );
  }

  return decision.decision === 'confirm';
}

// ---------------------------------------------------------------------------
// Platform detection (reads env vars set by the calling agent runtime)
// ---------------------------------------------------------------------------

export function detectPlatform(): string {
  if (process.env.OPENCLAW_STATE_DIR) return 'openclaw';
  if (process.env.CODEX_SESSION_ID) return 'codex';
  if (process.env.CURSOR_SESSION_ID) return 'cursor';
  if (process.env.CLAUDE_CODE) return 'claude-code';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Audit logging
// ---------------------------------------------------------------------------

export function writeAuditLog(
  input: HookInput,
  decision: { decision?: string; risk_level?: string; risk_tags?: string[] } | null,
  initiatingSkill?: string | null,
  platform?: string | null
): void {
  try {
    ensureDir();
    const rl = decision?.risk_level || 'low';
    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      platform: platform || 'unknown',
      tool_name: input.toolName,
      tool_input_summary: summarizeToolInput(input),
      decision: decision?.decision || 'allow',
      risk_level: rl,
      risk_tags: decision?.risk_tags || [],
      risk_score: riskLevelToNumericScore(rl as RiskLevel),
    };
    if (initiatingSkill) {
      entry.initiating_skill = initiatingSkill;
    }
    appendFileSync(AUDIT_PATH, JSON.stringify(entry) + '\n');
  } catch {
    // Non-critical
  }
}

function summarizeToolInput(input: HookInput): string {
  const toolInput = input.toolInput;
  if (typeof toolInput === 'object' && toolInput !== null) {
    const cmd = (toolInput as Record<string, unknown>).command;
    if (typeof cmd === 'string') return cmd.slice(0, 200);
    const fp = (toolInput as Record<string, unknown>).file_path ||
               (toolInput as Record<string, unknown>).path;
    if (typeof fp === 'string') return fp;
    const url = (toolInput as Record<string, unknown>).url ||
                (toolInput as Record<string, unknown>).query;
    if (typeof url === 'string') return url;
  }
  return JSON.stringify(toolInput).slice(0, 200);
}

// ---------------------------------------------------------------------------
// Skill trust policy helpers
// ---------------------------------------------------------------------------

export async function getSkillTrustPolicy(
  skillId: string,
  registry: { lookup: (s: { id: string; source: string; version_ref: string; artifact_hash: string }) => Promise<{ effective_trust_level: string; effective_capabilities: Record<string, unknown>; record: unknown | null }> }
): Promise<{ trustLevel: string | null; capabilities: Record<string, unknown> | null; isKnown: boolean }> {
  if (!skillId) {
    return { trustLevel: null, capabilities: null, isKnown: false };
  }
  try {
    const result = await registry.lookup({
      id: skillId,
      source: skillId,
      version_ref: '0.0.0',
      artifact_hash: '',
    });
    return {
      trustLevel: result.effective_trust_level,
      capabilities: result.effective_capabilities,
      isKnown: result.record !== null,
    };
  } catch {
    return { trustLevel: null, capabilities: null, isKnown: false };
  }
}

export function isActionAllowedByCapabilities(
  actionType: string,
  capabilities: Record<string, unknown>
): boolean {
  if (!capabilities) return true;
  switch (actionType) {
    case 'exec_command':
      return capabilities.can_exec !== false;
    case 'network_request':
      return capabilities.can_network !== false;
    case 'write_file':
      return capabilities.can_write !== false;
    case 'read_file':
      return capabilities.can_read !== false;
    default:
      return true;
  }
}
