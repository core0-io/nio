/**
 * Go Extractor — regex-based security extraction for Go files.
 *
 * Go's extremely regular syntax makes regex extraction reliable:
 *
 *   Sources: os.Getenv(), os.ReadFile(), ioutil.ReadFile()
 *   Sinks:   exec.Command(), http.Post(), os.WriteFile()
 *
 * Multi-return assignments (x, err := ...) need special handling.
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
  // Environment
  { re: /\bos\.Getenv\s*\(/, kind: 'env', name: 'os.Getenv' },
  { re: /\bos\.LookupEnv\s*\(/, kind: 'env', name: 'os.LookupEnv' },
  { re: /\bos\.Environ\s*\(/, kind: 'env', name: 'os.Environ' },

  // File reads
  { re: /\bos\.ReadFile\s*\(/, kind: 'fs_read', name: 'os.ReadFile' },
  { re: /\bioutil\.ReadFile\s*\(/, kind: 'fs_read', name: 'ioutil.ReadFile' },
  { re: /\bio\.ReadAll\s*\(/, kind: 'fs_read', name: 'io.ReadAll' },
  { re: /\bbufio\.NewReader\s*\(/, kind: 'fs_read', name: 'bufio.NewReader' },
  { re: /\bos\.Open\s*\(/, kind: 'fs_read', name: 'os.Open' },

  // Credential files
  { re: /\bos\.(?:ReadFile|Open)\s*\(\s*"[^"]*(?:\.ssh|\.aws|\.env|credentials|id_rsa|\.pem)/, kind: 'credential_file', name: 'credential file read' },

  // User input
  { re: /\bos\.Args\b/, kind: 'user_input', name: 'os.Args' },
  { re: /\bflag\.\w+\s*\(/, kind: 'user_input', name: 'flag' },
  { re: /\bbufio\.NewScanner\s*\(os\.Stdin\)/, kind: 'user_input', name: 'stdin scanner' },
  { re: /\bfmt\.Scan/, kind: 'user_input', name: 'fmt.Scan' },

  // Network responses
  { re: /\bhttp\.Get\s*\(/, kind: 'network_response', name: 'http.Get' },
  { re: /\bhttp\.DefaultClient\.Get\s*\(/, kind: 'network_response', name: 'http.DefaultClient.Get' },
];

const SINK_PATTERNS: Array<{ re: RegExp; kind: TaintSink['kind']; name: string }> = [
  // Command execution
  { re: /\bexec\.Command\s*\(/, kind: 'exec', name: 'exec.Command' },
  { re: /\bexec\.CommandContext\s*\(/, kind: 'exec', name: 'exec.CommandContext' },
  { re: /\bsyscall\.Exec\s*\(/, kind: 'exec', name: 'syscall.Exec' },

  // Network send
  { re: /\bhttp\.Post\s*\(/, kind: 'network_send', name: 'http.Post' },
  { re: /\bhttp\.PostForm\s*\(/, kind: 'network_send', name: 'http.PostForm' },
  { re: /\bhttp\.NewRequest\s*\(\s*"(?:POST|PUT|PATCH|DELETE)"/, kind: 'network_send', name: 'http.NewRequest(POST)' },
  { re: /\bnet\.Dial\s*\(/, kind: 'network_send', name: 'net.Dial' },

  // Fetch
  { re: /\bhttp\.Get\s*\(/, kind: 'fetch', name: 'http.Get' },
  { re: /\bhttp\.NewRequest\s*\(\s*"GET"/, kind: 'fetch', name: 'http.NewRequest(GET)' },

  // File write
  { re: /\bos\.WriteFile\s*\(/, kind: 'file_write', name: 'os.WriteFile' },
  { re: /\bioutil\.WriteFile\s*\(/, kind: 'file_write', name: 'ioutil.WriteFile' },
  { re: /\bos\.Create\s*\(/, kind: 'file_write', name: 'os.Create' },
  { re: /\bos\.OpenFile\s*\(/, kind: 'file_write', name: 'os.OpenFile' },

  // Process spawn
  { re: /\b\.Start\s*\(\s*\)/, kind: 'spawn', name: 'cmd.Start()' },

  // Code evaluation (Go has limited eval, but unsafe + reflect count)
  { re: /\breflect\.ValueOf\s*\(.*\)\.Call\s*\(/, kind: 'eval', name: 'reflect.Call' },
  { re: /\bunsafe\.Pointer\s*\(/, kind: 'eval', name: 'unsafe.Pointer' },
];

const SUSPICIOUS_STRING_RE = /https?:\/\/(?!localhost|127\.0\.0\.1)/;
const CREDENTIAL_PATH_RE = /(?:\.ssh|\.aws|\.gnupg|\.kube)\b|\.env\b|credentials|id_rsa|\.pem$/;

// ── Extractor ───────────────────────────────────────────────────────────

const GO_EXTENSIONS = new Set(['.go']);

function extractGo(source: string, _filePath: string): ASTExtraction | null {
  if (!source || source.length === 0) return null;

  const lines = source.split('\n');
  const result: ASTExtraction = {
    imports: [],
    functions: [],
    sources: [],
    sinks: [],
    suspiciousStrings: [],
  };

  let inImportBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    if (trimmed.startsWith('//') || trimmed === '') continue;

    // ── Imports ──────────────────────────────────────────────────
    // import "fmt"
    const singleImport = trimmed.match(/^import\s+"([^"]+)"/);
    if (singleImport) {
      result.imports.push({
        source: singleImport[1],
        imported: [singleImport[1].split('/').pop() || '*'],
        line: lineNum,
      });
    }
    // import ( ... ) block
    if (trimmed === 'import (') { inImportBlock = true; continue; }
    if (inImportBlock) {
      if (trimmed === ')') { inImportBlock = false; continue; }
      const pkgMatch = trimmed.match(/^\s*(?:\w+\s+)?"([^"]+)"/);
      if (pkgMatch) {
        result.imports.push({
          source: pkgMatch[1],
          imported: [pkgMatch[1].split('/').pop() || '*'],
          line: lineNum,
        });
      }
      continue;
    }

    // ── Functions ────────────────────────────────────────────────
    const funcMatch = trimmed.match(/^func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(([^)]*)\)/);
    if (funcMatch) {
      const name = funcMatch[1];
      const params = funcMatch[2]
        ? funcMatch[2].split(',').map(p => p.trim().split(/\s+/)[0]).filter(Boolean)
        : [];
      result.functions.push({
        name,
        params,
        line: lineNum,
        exported: /^[A-Z]/.test(name), // Go exports start with uppercase
      });
    }

    // ── Sources ──────────────────────────────────────────────────
    for (const pat of SOURCE_PATTERNS) {
      if (pat.re.test(line)) {
        result.sources.push({
          kind: pat.kind, name: pat.name,
          line: lineNum, column: 0,
          snippet: trimmed.slice(0, 120),
        });
      }
    }

    // ── Sinks ────────────────────────────────────────────────────
    for (const pat of SINK_PATTERNS) {
      if (pat.re.test(line)) {
        result.sinks.push({
          kind: pat.kind, name: pat.name,
          line: lineNum, column: 0,
          snippet: trimmed.slice(0, 120),
        });
      }
    }

    // ── Suspicious strings ───────────────────────────────────────
    const stringRe = /"(?:[^"\\]|\\.)*"/g;
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

export const goExtractor: LanguageExtractor = {
  language: 'go',
  extensions: GO_EXTENSIONS,
  extract: extractGo,
};
