// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Python Extractor — regex-based security extraction for Python files.
 *
 * Extracts the same ASTExtraction shape as the JS extractor, but without
 * a full AST parser. Python's simpler syntax (no destructuring, no var/let/const)
 * makes regex-based extraction viable for the common attack patterns:
 *
 *   Sources: os.environ, os.getenv, open().read(), pathlib
 *   Sinks:   subprocess, os.system, eval, exec, requests, urllib, httpx
 *
 * Can be upgraded to web-tree-sitter later for higher precision.
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

/** Source patterns: expressions that produce tainted data. */
const SOURCE_PATTERNS: Array<{ re: RegExp; kind: TaintSource['kind']; name: string }> = [
  // os.environ["KEY"], os.environ.get("KEY"), os.environ["KEY"]
  { re: /\bos\.environ\b/, kind: 'env', name: 'os.environ' },
  { re: /\bos\.getenv\s*\(/, kind: 'env', name: 'os.getenv' },
  // dotenv: os.environ after load_dotenv(), or dotenv_values()
  { re: /\bdotenv_values\s*\(/, kind: 'env', name: 'dotenv_values' },

  // File reads
  { re: /\bopen\s*\([^)]*\)\.read/, kind: 'fs_read', name: 'open().read' },
  { re: /\bPath\s*\([^)]*\)\.read_text\s*\(/, kind: 'fs_read', name: 'Path.read_text' },
  { re: /\bpathlib\.Path\s*\([^)]*\)\.read_text\s*\(/, kind: 'fs_read', name: 'pathlib.Path.read_text' },

  // Credential file paths
  { re: /\bopen\s*\(\s*['"][^'"]*(?:\.ssh|\.aws|\.env|credentials|id_rsa|\.pem)/, kind: 'credential_file', name: 'credential file read' },

  // Network responses
  { re: /\brequests\.get\s*\(/, kind: 'network_response', name: 'requests.get' },
  { re: /\burllib\.request\.urlopen\s*\(/, kind: 'network_response', name: 'urllib.request.urlopen' },
  { re: /\bhttpx\.get\s*\(/, kind: 'network_response', name: 'httpx.get' },

  // User input
  { re: /\binput\s*\(/, kind: 'user_input', name: 'input()' },
  { re: /\bsys\.argv\b/, kind: 'user_input', name: 'sys.argv' },
  { re: /\bargparse\b/, kind: 'user_input', name: 'argparse' },
];

/** Sink patterns: expressions that consume data dangerously. */
const SINK_PATTERNS: Array<{ re: RegExp; kind: TaintSink['kind']; name: string }> = [
  // Command execution
  { re: /\bsubprocess\.(?:run|call|check_call|check_output|Popen)\s*\(/, kind: 'exec', name: 'subprocess' },
  { re: /\bos\.system\s*\(/, kind: 'exec', name: 'os.system' },
  { re: /\bos\.popen\s*\(/, kind: 'exec', name: 'os.popen' },
  { re: /\bos\.exec[lv]p?e?\s*\(/, kind: 'spawn', name: 'os.exec*' },

  // Code evaluation
  { re: /\beval\s*\(/, kind: 'eval', name: 'eval' },
  { re: /\bexec\s*\(/, kind: 'eval', name: 'exec' },
  { re: /\bcompile\s*\([^)]*,\s*[^)]*,\s*['"]exec['"]/, kind: 'eval', name: 'compile(..., "exec")' },
  { re: /\b__import__\s*\(/, kind: 'eval', name: '__import__' },

  // Network send
  { re: /\brequests\.(?:post|put|patch|delete)\s*\(/, kind: 'network_send', name: 'requests.post' },
  { re: /\bhttpx\.(?:post|put|patch|delete)\s*\(/, kind: 'network_send', name: 'httpx.post' },
  { re: /\burllib\.request\.(?:urlopen|Request)\s*\(/, kind: 'network_send', name: 'urllib.request' },
  { re: /\bsocket\b.*\.(?:send|sendall|sendto)\s*\(/, kind: 'network_send', name: 'socket.send' },

  // Fetch (GET with potential data in URL)
  { re: /\brequests\.get\s*\(/, kind: 'fetch', name: 'requests.get' },
  { re: /\bhttpx\.get\s*\(/, kind: 'fetch', name: 'httpx.get' },

  // File write
  { re: /\bopen\s*\([^)]*,\s*['"][wWaA]/, kind: 'file_write', name: 'open(w)' },
  { re: /\bPath\s*\([^)]*\)\.write_text\s*\(/, kind: 'file_write', name: 'Path.write_text' },
  { re: /\bshutil\.copy/, kind: 'file_write', name: 'shutil.copy' },
];

/** Import patterns for dangerous modules. */
const DANGEROUS_MODULES = new Set([
  'subprocess', 'os', 'sys', 'shutil',
  'socket', 'http', 'http.client', 'http.server',
  'urllib', 'urllib.request', 'requests', 'httpx',
  'ctypes', 'multiprocessing',
]);

/** Suspicious URL/path patterns in strings. */
const SUSPICIOUS_STRING_RE = /https?:\/\/(?!localhost|127\.0\.0\.1)/;
const CREDENTIAL_PATH_RE = /(?:\.ssh|\.aws|\.gnupg|\.kube)\b|\.env\b|credentials|id_rsa|\.pem$/;

// ── Extractor ───────────────────────────────────────────────────────────

const PY_EXTENSIONS = new Set(['.py', '.pyw']);

function extractPython(source: string, filePath: string): ASTExtraction | null {
  // Quick sanity check — skip obviously non-Python content
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

    // ── Imports ────────────────────────────────────────────────────
    extractImports(trimmed, lineNum, result.imports);

    // ── Functions ──────────────────────────────────────────────────
    extractFunction(trimmed, lineNum, result.functions);

    // ── Sources ───────────────────────────────────────────────────
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

    // ── Sinks ─────────────────────────────────────────────────────
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

    // ── Suspicious strings ────────────────────────────────────────
    extractStrings(line, lineNum, result.suspiciousStrings);
  }

  return result;
}

// ── Import extraction ───────────────────────────────────────────────────

function extractImports(trimmed: string, lineNum: number, imports: ImportInfo[]): void {
  // import module
  const importMatch = trimmed.match(/^import\s+([\w.]+)(?:\s+as\s+\w+)?$/);
  if (importMatch) {
    imports.push({
      source: importMatch[1],
      imported: ['*'],
      line: lineNum,
    });
    return;
  }

  // from module import x, y, z
  const fromMatch = trimmed.match(/^from\s+([\w.]+)\s+import\s+(.+)$/);
  if (fromMatch) {
    const mod = fromMatch[1];
    const names = fromMatch[2].split(',').map(s => {
      const asMatch = s.trim().match(/^(\w+)(?:\s+as\s+\w+)?$/);
      return asMatch ? asMatch[1] : s.trim();
    }).filter(s => s && s !== '(');
    imports.push({
      source: mod,
      imported: names.includes('*') ? ['*'] : names,
      line: lineNum,
    });
  }
}

// ── Function extraction ─────────────────────────────────────────────────

function extractFunction(trimmed: string, lineNum: number, functions: FunctionInfo[]): void {
  const funcMatch = trimmed.match(/^(async\s+)?def\s+(\w+)\s*\(([^)]*)\)/);
  if (!funcMatch) return;

  const name = funcMatch[2];
  const paramsStr = funcMatch[3];
  const params = paramsStr
    ? paramsStr.split(',').map(p => p.trim().split(':')[0].split('=')[0].trim()).filter(Boolean)
    : [];

  // In Python, a function at module level with no indentation before "def" is "exported"
  // (a rough heuristic — Python doesn't have explicit exports)
  const exported = !trimmed.startsWith(' ') && !name.startsWith('_');

  functions.push({ name, params, line: lineNum, exported });
}

// ── String extraction ───────────────────────────────────────────────────

function extractStrings(
  line: string,
  lineNum: number,
  suspicious: Array<{ value: string; line: number }>,
): void {
  // Match single and double quoted strings
  const stringRe = /(?:f?r?b?)(["'])(?:(?!\1).)*\1/g;
  let match;
  while ((match = stringRe.exec(line)) !== null) {
    const val = match[0].slice(1, -1); // strip quotes
    if (SUSPICIOUS_STRING_RE.test(val) || CREDENTIAL_PATH_RE.test(val)) {
      suspicious.push({ value: val, line: lineNum });
    }
  }
}

// ── Export ───────────────────────────────────────────────────────────────

export const pyExtractor: LanguageExtractor = {
  language: 'python',
  extensions: PY_EXTENSIONS,
  extract: extractPython,
};
