/**
 * Phase 2: RuntimeAnalyser — pattern-based action analysis.
 *
 * Produces Finding[] from action data. Covers three action types:
 *   - Bash commands: dangerous commands, fork bombs, metacharacters, base64 decode
 *   - WebFetch/network: webhook domains, high-risk TLDs, secret leak in body
 *   - Write/Edit: path traversal, sensitive path detection
 *
 * Migrated from src/action/detectors/ (exec.ts, network.ts, secret-leak.ts).
 */

import type { ActionEnvelope } from '../../../types/action.js';
import type { Finding } from '../../models.js';
import { findingId } from '../../models.js';
import {
  WEBHOOK_EXFIL_DOMAINS,
  HIGH_RISK_TLDS,
  SENSITIVE_FILE_PATHS,
  SECRET_PATTERNS,
  SECRET_PRIORITY,
} from '../../shared/detection-data.js';
import { extractAndDecodeBase64 } from '../../detection-engine.js';

// ── Config-driven extra patterns ────────────────────────────────────────

export interface GuardRulesConfig {
  dangerous_commands?:  string[];
  dangerous_patterns?:  string[];
  sensitive_commands?:   string[];
  system_commands?:      string[];
  network_commands?:     string[];
  webhook_domains?:      string[];
  sensitive_paths?:      string[];
  secret_patterns?:      string[];
}

// ── Bash Command Patterns ───────────────────────────────────────────────

const FORK_BOMB_PATTERNS = [
  /:\s*\(\s*\)\s*\{.*:\s*\|\s*:.*&.*\}/,
  /\bfork\s*bomb\b/i,
];

const DANGEROUS_COMMAND_STRINGS = [
  'rm -rf', 'rm -fr', 'mkfs', 'dd if=', 'chmod 777', 'chmod -R 777',
  '> /dev/sda', 'mv /* ',
];

const DANGEROUS_COMMAND_PATTERNS = [
  /wget\s.*\|\s*sh/i,
  /curl\s.*\|\s*sh/i,
  /curl\s.*\|\s*bash/i,
  /wget\s.*\|\s*bash/i,
];

const SENSITIVE_COMMANDS = [
  'cat /etc/passwd', 'cat /etc/shadow',
  'cat ~/.ssh', 'cat ~/.aws', 'cat ~/.kube', 'cat ~/.npmrc', 'cat ~/.netrc',
  'printenv', 'env', 'set',
];

const SYSTEM_COMMANDS = [
  'sudo', 'su ', 'chown', 'chmod', 'chgrp',
  'useradd', 'userdel', 'groupadd', 'passwd', 'visudo',
  'systemctl', 'service ', 'init ', 'shutdown', 'reboot', 'halt',
];

const NETWORK_COMMANDS = [
  'curl ', 'wget ', 'nc ', 'netcat', 'ncat',
  'ssh ', 'scp ', 'rsync ', 'ftp ', 'sftp ',
];

const SHELL_INJECTION_PATTERNS = [
  /;\s*\w+/,
  /\|\s*\w+/,
  /`[^`]+`/,
  /\$\([^)]+\)/,
  /&&\s*\w+/,
  /\|\|\s*\w+/,
];

// ── Helpers ─────────────────────────────────────────────────────────────

function isSensitivePath(filePath: string, extraPaths?: string[]): boolean {
  if (!filePath) return false;
  let normalized = filePath.replace(/\\/g, '/');
  if (normalized.startsWith('~/')) {
    normalized = '/HOME' + normalized.slice(1);
  }
  const paths = extraPaths
    ? [...SENSITIVE_FILE_PATHS, ...extraPaths]
    : SENSITIVE_FILE_PATHS as unknown as string[];
  return paths.some(
    (p) => normalized.includes(`/${p}`) || normalized.endsWith(p),
  );
}

function checkSecretLeak(content: string): Finding[] {
  const findings: Finding[] = [];

  for (const [type, pattern] of Object.entries(SECRET_PATTERNS)) {
    pattern.lastIndex = 0;
    if (pattern.test(content)) {
      const priority = SECRET_PRIORITY[type] || 0;
      const severity = priority >= 90 ? 'critical' as const
        : priority >= 70 ? 'high' as const
        : priority >= 50 ? 'medium' as const
        : 'low' as const;

      findings.push({
        id: findingId(`SECRET_LEAK_${type}`, 'request_body', 0),
        rule_id: `SECRET_LEAK_${type}`,
        category: 'secrets',
        severity,
        title: `${type} detected in request body`,
        description: `Request body contains ${type} pattern`,
        location: { file: 'request_body', line: 0 },
        remediation: 'Remove sensitive data from HTTP request body',
        analyser: 'static',
        confidence: 0.95,
      });
    }
  }

  return findings;
}

// ── Main Analysis Functions ─────────────────────────────────────────────

function analyzeBashCommand(envelope: ActionEnvelope, extra?: GuardRulesConfig): Finding[] {
  const findings: Finding[] = [];
  const data = envelope.action.data as { command: string; args?: string[]; env?: Record<string, string> };
  const fullCommand = data.args
    ? `${data.command} ${data.args.join(' ')}`
    : data.command;
  const lowerCommand = fullCommand.toLowerCase();

  // Merge extra patterns from config
  const dangerousStrings = extra?.dangerous_commands
    ? [...DANGEROUS_COMMAND_STRINGS, ...extra.dangerous_commands]
    : DANGEROUS_COMMAND_STRINGS;
  const dangerousPatterns = extra?.dangerous_patterns
    ? [...DANGEROUS_COMMAND_PATTERNS, ...extra.dangerous_patterns.map(p => new RegExp(p))]
    : DANGEROUS_COMMAND_PATTERNS;
  const sensitiveCommands = extra?.sensitive_commands
    ? [...SENSITIVE_COMMANDS, ...extra.sensitive_commands]
    : SENSITIVE_COMMANDS;
  const systemCommands = extra?.system_commands
    ? [...SYSTEM_COMMANDS, ...extra.system_commands]
    : SYSTEM_COMMANDS;
  const networkCommands = extra?.network_commands
    ? [...NETWORK_COMMANDS, ...extra.network_commands]
    : NETWORK_COMMANDS;

  // Fork bombs
  for (const pattern of FORK_BOMB_PATTERNS) {
    if (pattern.test(fullCommand)) {
      findings.push({
        id: findingId('FORK_BOMB', 'command', 0),
        rule_id: 'FORK_BOMB',
        category: 'execution',
        severity: 'critical',
        title: 'Fork bomb detected',
        description: 'Command contains a fork bomb pattern',
        location: { file: 'command', line: 0, snippet: fullCommand.slice(0, 200) },
        analyser: 'static',
        confidence: 1.0,
      });
      return findings; // critical — no need to check further
    }
  }

  // Dangerous commands (string match)
  for (const dangerous of dangerousStrings) {
    if (lowerCommand.includes(dangerous.toLowerCase())) {
      findings.push({
        id: findingId('DANGEROUS_COMMAND', 'command', 0),
        rule_id: 'DANGEROUS_COMMAND',
        category: 'execution',
        severity: 'critical',
        title: `Dangerous command: ${dangerous}`,
        description: `Dangerous command pattern detected: ${dangerous}`,
        location: { file: 'command', line: 0, snippet: fullCommand.slice(0, 200) },
        analyser: 'static',
        confidence: 1.0,
      });
      return findings; // critical
    }
  }

  // Dangerous commands (regex match, e.g. curl ... | bash)
  for (const pattern of dangerousPatterns) {
    if (pattern.test(fullCommand)) {
      findings.push({
        id: findingId('DANGEROUS_COMMAND', 'command', 0),
        rule_id: 'DANGEROUS_COMMAND',
        category: 'execution',
        severity: 'critical',
        title: 'Dangerous command: pipe to shell',
        description: `Dangerous command pattern detected: pipe to shell interpreter`,
        location: { file: 'command', line: 0, snippet: fullCommand.slice(0, 200) },
        analyser: 'static',
        confidence: 1.0,
      });
      return findings; // critical
    }
  }

  // Sensitive data access
  for (const sensitive of sensitiveCommands) {
    if (lowerCommand.includes(sensitive.toLowerCase())) {
      findings.push({
        id: findingId('SENSITIVE_DATA_ACCESS', 'command', 0),
        rule_id: 'SENSITIVE_DATA_ACCESS',
        category: 'secrets',
        severity: 'high',
        title: `Sensitive data access: ${sensitive}`,
        description: `Command accesses sensitive data: ${sensitive}`,
        location: { file: 'command', line: 0, snippet: fullCommand.slice(0, 200) },
        analyser: 'static',
        confidence: 0.9,
      });
    }
  }

  // System commands
  for (const sys of systemCommands) {
    if (lowerCommand.startsWith(sys.toLowerCase()) || lowerCommand.includes(' ' + sys.toLowerCase())) {
      findings.push({
        id: findingId('SYSTEM_COMMAND', 'command', 0),
        rule_id: 'SYSTEM_COMMAND',
        category: 'execution',
        severity: 'high',
        title: `System command: ${sys.trim()}`,
        description: `System modification command: ${sys.trim()}`,
        location: { file: 'command', line: 0, snippet: fullCommand.slice(0, 200) },
        analyser: 'static',
        confidence: 0.9,
      });
    }
  }

  // Network commands
  for (const net of networkCommands) {
    if (lowerCommand.startsWith(net.toLowerCase()) || lowerCommand.includes(' ' + net.toLowerCase())) {
      findings.push({
        id: findingId('NETWORK_COMMAND', 'command', 0),
        rule_id: 'NETWORK_COMMAND',
        category: 'exfiltration',
        severity: 'medium',
        title: `Network command: ${net.trim()}`,
        description: `Network command: ${net.trim()}`,
        location: { file: 'command', line: 0, snippet: fullCommand.slice(0, 200) },
        analyser: 'static',
        confidence: 0.8,
      });
    }
  }

  // Shell injection
  for (const pattern of SHELL_INJECTION_PATTERNS) {
    if (pattern.test(fullCommand)) {
      findings.push({
        id: findingId('SHELL_INJECTION', 'command', 0),
        rule_id: 'SHELL_INJECTION',
        category: 'execution',
        severity: 'medium',
        title: 'Shell injection risk',
        description: 'Command contains shell metacharacters',
        location: { file: 'command', line: 0, snippet: fullCommand.slice(0, 200) },
        analyser: 'static',
        confidence: 0.7,
      });
      break;
    }
  }

  // Sensitive env vars
  if (data.env) {
    const sensitiveEnvKeys = ['API_KEY', 'SECRET', 'PASSWORD', 'TOKEN', 'PRIVATE', 'CREDENTIAL'];
    for (const key of Object.keys(data.env)) {
      if (sensitiveEnvKeys.some(s => key.toUpperCase().includes(s))) {
        findings.push({
          id: findingId('SENSITIVE_ENV', 'env', 0),
          rule_id: 'SENSITIVE_ENV',
          category: 'secrets',
          severity: 'medium',
          title: `Sensitive env var: ${key}`,
          description: `Sensitive environment variable passed: ${key}`,
          location: { file: 'env', line: 0 },
          analyser: 'static',
          confidence: 0.8,
        });
      }
    }
  }

  // Base64 decode pass — extract encoded payloads and re-scan
  const decodedPayloads = extractAndDecodeBase64(fullCommand);
  for (const decoded of decodedPayloads) {
    // Re-check dangerous commands in decoded content
    const decodedLower = decoded.toLowerCase();
    for (const dangerous of DANGEROUS_COMMAND_STRINGS) {
      if (decodedLower.includes(dangerous.toLowerCase())) {
        findings.push({
          id: findingId('BASE64_DANGEROUS', 'command', 0),
          rule_id: 'BASE64_DANGEROUS',
          category: 'execution',
          severity: 'critical',
          title: `Base64-encoded dangerous command: ${dangerous}`,
          description: `Decoded base64 payload contains dangerous command: ${dangerous}`,
          location: { file: 'command', line: 0, snippet: decoded.slice(0, 200) },
          analyser: 'static',
          confidence: 0.95,
          metadata: { context: 'decoded_from:base64' },
        });
      }
    }
  }

  return findings;
}

function analyzeNetworkRequest(envelope: ActionEnvelope, extra?: GuardRulesConfig): Finding[] {
  const findings: Finding[] = [];
  const data = envelope.action.data as { url?: string; method?: string; body_preview?: string };

  const url = data.url || '';
  let domain: string | null = null;

  const webhookDomains = extra?.webhook_domains
    ? [...WEBHOOK_EXFIL_DOMAINS, ...extra.webhook_domains]
    : WEBHOOK_EXFIL_DOMAINS as unknown as string[];

  try {
    domain = new URL(url).hostname;
  } catch {
    if (url) {
      findings.push({
        id: findingId('INVALID_URL', 'url', 0),
        rule_id: 'INVALID_URL',
        category: 'exfiltration',
        severity: 'high',
        title: 'Invalid URL',
        description: `Could not parse URL: ${url.slice(0, 100)}`,
        location: { file: 'url', line: 0 },
        analyser: 'static',
        confidence: 0.9,
      });
      return findings;
    }
  }

  if (domain) {
    // Webhook exfil domains
    const isWebhook = webhookDomains.some(
      d => domain === d || domain!.endsWith('.' + d),
    );
    if (isWebhook) {
      findings.push({
        id: findingId('WEBHOOK_EXFIL', 'url', 0),
        rule_id: 'WEBHOOK_EXFIL',
        category: 'exfiltration',
        severity: 'high',
        title: `Webhook exfil domain: ${domain}`,
        description: `Webhook/exfiltration domain detected: ${domain}`,
        location: { file: 'url', line: 0, snippet: url.slice(0, 200) },
        analyser: 'static',
        confidence: 0.95,
      });
    }

    // High-risk TLDs
    const hasHighRiskTLD = HIGH_RISK_TLDS.some(tld => domain!.endsWith(tld));
    if (hasHighRiskTLD) {
      findings.push({
        id: findingId('HIGH_RISK_TLD', 'url', 0),
        rule_id: 'HIGH_RISK_TLD',
        category: 'exfiltration',
        severity: 'medium',
        title: `High-risk TLD: ${domain}`,
        description: `Domain uses a high-risk TLD`,
        location: { file: 'url', line: 0, snippet: url.slice(0, 200) },
        analyser: 'static',
        confidence: 0.7,
      });
    }
  }

  // Secret leak in request body
  if (data.body_preview) {
    findings.push(...checkSecretLeak(data.body_preview));
  }

  return findings;
}

function analyzeFileOperation(envelope: ActionEnvelope, extra?: GuardRulesConfig): Finding[] {
  const findings: Finding[] = [];
  const data = envelope.action.data as { path?: string; content_preview?: string };
  const filePath = data.path || '';

  // Sensitive path
  if (isSensitivePath(filePath, extra?.sensitive_paths)) {
    findings.push({
      id: findingId('SENSITIVE_PATH', filePath, 0),
      rule_id: 'SENSITIVE_PATH',
      category: 'secrets',
      severity: 'critical',
      title: `Sensitive path: ${filePath}`,
      description: `Write to sensitive path: ${filePath}`,
      location: { file: filePath, line: 0 },
      analyser: 'static',
      confidence: 1.0,
    });
  }

  // Path traversal
  if (filePath.includes('../') || filePath.includes('..\\')) {
    findings.push({
      id: findingId('PATH_TRAVERSAL', filePath, 0),
      rule_id: 'PATH_TRAVERSAL',
      category: 'execution',
      severity: 'high',
      title: 'Path traversal detected',
      description: `Path traversal in file path: ${filePath}`,
      location: { file: filePath, line: 0 },
      analyser: 'static',
      confidence: 0.9,
    });
  }

  return findings;
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Run Phase 2 pattern analysis on an action envelope.
 * Returns Finding[] — empty means no issues found.
 */
export function analyzeAction(envelope: ActionEnvelope, extra?: GuardRulesConfig): Finding[] {
  switch (envelope.action.type) {
    case 'exec_command':
      return analyzeBashCommand(envelope, extra);
    case 'network_request':
      return analyzeNetworkRequest(envelope, extra);
    case 'write_file':
      return analyzeFileOperation(envelope, extra);
    case 'read_file':
      return []; // Read operations are generally safe
    default:
      return [];
  }
}
