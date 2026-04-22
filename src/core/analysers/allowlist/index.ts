// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 1: Allowlist Gate — fast-path for known-safe commands.
 *
 * Returns true if the action is definitively safe, allowing the pipeline
 * to short-circuit without running any scoring phases.
 *
 * Only applies to Bash commands with no shell metacharacters.
 */

import type { ActionEnvelope } from '../../../types/action.js';
import { SENSITIVE_FILE_PATHS } from '../../shared/detection-data.js';

// ── Safe Command Prefixes ───────────────────────────────────────────────

/** Read-only / standard dev commands that should be allowed without restriction. */
const SAFE_COMMAND_PREFIXES = [
  // Basic read-only
  'ls', 'echo', 'pwd', 'whoami', 'date', 'hostname', 'uname',
  'cat', 'head', 'tail', 'wc', 'grep', 'find', 'which', 'type',
  'tree', 'du', 'df', 'sort', 'uniq', 'diff', 'cd',
  // File operations (safe without metacharacters)
  'mkdir', 'cp', 'mv', 'touch',
  // Git (read + common write operations)
  'git status', 'git log', 'git diff', 'git branch', 'git show', 'git remote',
  'git checkout', 'git pull', 'git fetch', 'git merge', 'git add', 'git commit', 'git push',
  // Package managers (run/test/start only)
  'npm run', 'npm test', 'npm ci', 'npm start',
  'npx', 'yarn', 'pnpm',
  // Version checks
  'node --version', 'node -v', 'npm --version', 'npm -v', 'npx --version',
  'python --version', 'python3 --version', 'pip --version',
  'tsc --version', 'go version', 'rustc --version', 'java -version',
  // Build & run
  'tsc', 'go build', 'go run',
  'cargo build', 'cargo run', 'cargo test',
  'make',
];

/**
 * Commands that are safe but should be audited (elevated risk logging).
 * Can execute arbitrary code via postinstall scripts, hooks, or setup.py.
 */
const AUDIT_COMMAND_PREFIXES = [
  'npm install', 'pnpm install', 'yarn install',
  'pip install', 'pip3 install',
  'git clone',
];

/** Shell metacharacters that disqualify a command from the safe list. */
const SHELL_METACHAR_PATTERN = /[;|&`$(){}<>!#\n\t]/;

// ── File-mutating commands where target path matters ────────────────────

const FILE_MUTATING_COMMANDS = ['mv', 'cp', 'rsync', 'scp', 'install', 'ln', 'tee'];

function extractCommandTargetPaths(command: string): string[] {
  const tokens = command.trim().split(/\s+/);
  if (tokens.length < 2) return [];
  const base = tokens[0].toLowerCase();

  if (FILE_MUTATING_COMMANDS.includes(base)) {
    return tokens.slice(1).filter(t => !t.startsWith('-'));
  }
  return [];
}

// ── Sensitive path check (inline, no external deps) ─────────────────────

function isSensitivePath(filePath: string): boolean {
  if (!filePath) return false;
  let normalized = filePath.replace(/\\/g, '/');
  if (normalized.startsWith('~/')) {
    normalized = '/HOME' + normalized.slice(1);
  }
  return SENSITIVE_FILE_PATHS.some(
    (p) => normalized.includes(`/${p}`) || normalized.endsWith(p),
  );
}

// ── Allowlist Result ────────────────────────────────────────────────────

export type AllowlistResult =
  | { allowed: true; audit?: boolean; auditReason?: string }
  | { allowed: false };

// ── AllowlistAnalyser ───────────────────────────────────────────────────

export interface AllowlistAnalyserOptions {
  /** User-injected safe command prefixes from config (guard.allowed_commands). */
  allowedCommands?: string[];
}

/**
 * Phase 1 analyser: allowlist gate.
 *
 * Checks if an action matches a built-in safe prefix list plus any
 * user-configured `allowed_commands`. When matched, the pipeline can
 * short-circuit without running scoring phases (orchestrator controls
 * this via `allowlistMode`).
 *
 * Only applies to exec_command actions with no shell metacharacters.
 */
export class AllowlistAnalyser {
  private allowedCommands: string[];

  constructor(opts?: AllowlistAnalyserOptions) {
    this.allowedCommands = opts?.allowedCommands ?? [];
  }

  analyse(envelope: ActionEnvelope): AllowlistResult {
    // Only applies to exec_command actions
    if (envelope.action.type !== 'exec_command') {
      return { allowed: false };
    }

    const data = envelope.action.data as { command: string; args?: string[] };
    const fullCommand = data.args
      ? `${data.command} ${data.args.join(' ')}`
      : data.command;
    const lowerCommand = fullCommand.toLowerCase();

    // Shell metacharacters disqualify from allowlist
    if (SHELL_METACHAR_PATTERN.test(fullCommand)) {
      return { allowed: false };
    }

    // Check for sensitive path targets (mv, cp, etc.)
    const targetPaths = extractCommandTargetPaths(fullCommand);
    if (targetPaths.some(p => isSensitivePath(p))) {
      return { allowed: false };
    }

    // Check safe command prefixes
    const allPrefixes = [...SAFE_COMMAND_PREFIXES, ...this.allowedCommands];
    const isSafe = allPrefixes.some(prefix =>
      lowerCommand === prefix || lowerCommand.startsWith(prefix + ' '),
    );

    if (isSafe) {
      return { allowed: true };
    }

    // Check audit commands (allow but flag)
    const isAudit = AUDIT_COMMAND_PREFIXES.some(prefix =>
      lowerCommand === prefix || lowerCommand.startsWith(prefix + ' '),
    );

    if (isAudit) {
      return {
        allowed: true,
        audit: true,
        auditReason: 'Package install or clone command can execute arbitrary code via hooks',
      };
    }

    return { allowed: false };
  }
}
