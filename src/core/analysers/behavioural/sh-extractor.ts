// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Shell Extractor — regex-based security extraction for shell scripts.
 *
 * Shell is the most common attack surface in agent scenarios (Bash tool).
 * Full dataflow tracking is impractical due to shell's dynamic nature,
 * but linear source→sink patterns are detectable:
 *
 *   Sources: $ENV_VAR, $(cat file), read input, curl response
 *   Sinks:   curl, wget, eval, exec, nc, ssh, base64 -d | bash
 */

import type {
  LanguageExtractor,
  ASTExtraction,
  TaintSource,
  TaintSink,
  ImportInfo,
  FunctionInfo,
} from './types.js';

// ── Patterns ────────────────────────────────────────────────────────────

const SOURCE_PATTERNS: Array<{ re: RegExp; kind: TaintSource['kind']; name: string }> = [
  // Environment variables
  { re: /\$\{?\w+\}?/, kind: 'env', name: 'env variable' },
  { re: /\bprintenv\b/, kind: 'env', name: 'printenv' },

  // File reads
  { re: /\$\(cat\s+/, kind: 'fs_read', name: '$(cat)' },
  { re: /\bcat\s+[^|;]+/, kind: 'fs_read', name: 'cat' },
  { re: /\bsource\s+/, kind: 'fs_read', name: 'source' },
  { re: /\.\s+[\/~]/, kind: 'fs_read', name: '. (source)' },

  // Credential file reads
  { re: /\bcat\s+[^|;]*(?:\.ssh|\.aws|\.env|credentials|id_rsa|\.pem|\.gnupg)/, kind: 'credential_file', name: 'credential file read' },
  { re: /\$\(cat\s+[^)]*(?:\.ssh|\.aws|\.env|credentials|id_rsa|\.pem)/, kind: 'credential_file', name: '$(cat credential)' },

  // User input
  { re: /\bread\s+(?:-[a-z]\s+)*\w+/, kind: 'user_input', name: 'read' },
  { re: /\$[1-9@*]/, kind: 'user_input', name: 'positional arg' },

  // Network responses
  { re: /\$\(curl\s+/, kind: 'network_response', name: '$(curl)' },
  { re: /\$\(wget\s+/, kind: 'network_response', name: '$(wget)' },
  { re: /curl\s+[^|;]+\|\s*/, kind: 'network_response', name: 'curl pipe' },
];

const SINK_PATTERNS: Array<{ re: RegExp; kind: TaintSink['kind']; name: string }> = [
  // Command execution
  { re: /\beval\s+/, kind: 'eval', name: 'eval' },
  { re: /\bexec\s+/, kind: 'exec', name: 'exec' },
  { re: /\bbase64\s+(?:-d|--decode)\s*\|/, kind: 'eval', name: 'base64 -d | ...' },
  { re: /\|\s*(?:bash|sh|zsh|dash)\b/, kind: 'eval', name: 'pipe to shell' },
  { re: /\bxargs\s+/, kind: 'exec', name: 'xargs' },
  { re: /\bsudo\s+/, kind: 'exec', name: 'sudo' },

  // Network send
  { re: /\bcurl\s+.*(?:-X\s*POST|-d\s|--data)/, kind: 'network_send', name: 'curl POST' },
  { re: /\bcurl\s+/, kind: 'fetch', name: 'curl' },
  { re: /\bwget\s+/, kind: 'fetch', name: 'wget' },
  { re: /\bnc\s+/, kind: 'network_send', name: 'nc (netcat)' },
  { re: /\bssh\s+/, kind: 'network_send', name: 'ssh' },
  { re: /\bscp\s+/, kind: 'network_send', name: 'scp' },

  // File write
  { re: />\s*[\/~]/, kind: 'file_write', name: 'redirect write' },
  { re: /\btee\s+/, kind: 'file_write', name: 'tee' },
  { re: /\bdd\s+.*of=/, kind: 'file_write', name: 'dd' },

  // Process spawn
  { re: /\bnohup\s+/, kind: 'spawn', name: 'nohup' },
  { re: /&\s*$/, kind: 'spawn', name: 'background process' },
];

/** Suspicious URL/path patterns. */
const SUSPICIOUS_STRING_RE = /https?:\/\/(?!localhost|127\.0\.0\.1)/;
const CREDENTIAL_PATH_RE = /(?:\.ssh|\.aws|\.gnupg|\.kube)\b|\.env\b|credentials|id_rsa|\.pem$/;

// ── Extractor ───────────────────────────────────────────────────────────

const SH_EXTENSIONS = new Set(['.sh', '.bash', '.zsh', '.fish', '.ksh']);

function extractShell(source: string, _filePath: string): ASTExtraction | null {
  if (!source || source.length === 0) return null;

  const lines = source.split('\n');
  const result: ASTExtraction = {
    imports: [],
    functions: [],
    sources: [],
    sinks: [],
    suspiciousStrings: [],
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    // Skip comments and empty lines
    if (trimmed.startsWith('#') || trimmed === '') continue;

    // ── "Imports" (source/. commands) ─────────────────────────────
    const sourceMatch = trimmed.match(/^(?:source|\.) +["']?([^\s"']+)/);
    if (sourceMatch) {
      result.imports.push({
        source: sourceMatch[1],
        imported: ['*'],
        line: lineNum,
      });
    }

    // ── Functions ─────────────────────────────────────────────────
    const funcMatch = trimmed.match(/^(?:function\s+)?(\w+)\s*\(\s*\)\s*\{?/);
    if (funcMatch && !['if', 'while', 'for', 'until', 'case', 'elif'].includes(funcMatch[1])) {
      result.functions.push({
        name: funcMatch[1],
        params: [],
        line: lineNum,
        exported: false,
      });
    }

    // ── Sources ──────────────────────────────────────────────────
    for (const pat of SOURCE_PATTERNS) {
      if (pat.re.test(line)) {
        result.sources.push({
          kind: pat.kind,
          name: pat.name,
          line: lineNum,
          column: 0,
          snippet: trimmed.slice(0, 120),
        });
      }
    }

    // ── Sinks ────────────────────────────────────────────────────
    for (const pat of SINK_PATTERNS) {
      if (pat.re.test(line)) {
        result.sinks.push({
          kind: pat.kind,
          name: pat.name,
          line: lineNum,
          column: 0,
          snippet: trimmed.slice(0, 120),
        });
      }
    }

    // ── Suspicious strings ───────────────────────────────────────
    // Extract quoted strings
    const stringRe = /(["'])(?:(?!\1).)*\1/g;
    let match;
    while ((match = stringRe.exec(line)) !== null) {
      const val = match[0].slice(1, -1);
      if (SUSPICIOUS_STRING_RE.test(val) || CREDENTIAL_PATH_RE.test(val)) {
        result.suspiciousStrings.push({ value: val, line: lineNum });
      }
    }
  }

  return result;
}

export const shExtractor: LanguageExtractor = {
  language: 'shell',
  extensions: SH_EXTENSIONS,
  extract: extractShell,
};
