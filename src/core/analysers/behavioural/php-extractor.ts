/**
 * PHP Extractor — regex-based security extraction for PHP files.
 *
 * PHP has the most mature taint analysis tradition in security scanning.
 * Well-known superglobal sources and dangerous function sinks:
 *
 *   Sources: $_GET, $_POST, $_ENV, $_REQUEST, file_get_contents()
 *   Sinks:   exec(), system(), eval(), shell_exec(), curl_exec()
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
  // Superglobals
  { re: /\$_ENV\b/, kind: 'env', name: '$_ENV' },
  { re: /\bgetenv\s*\(/, kind: 'env', name: 'getenv()' },
  { re: /\$_SERVER\b/, kind: 'env', name: '$_SERVER' },

  // User input
  { re: /\$_GET\b/, kind: 'user_input', name: '$_GET' },
  { re: /\$_POST\b/, kind: 'user_input', name: '$_POST' },
  { re: /\$_REQUEST\b/, kind: 'user_input', name: '$_REQUEST' },
  { re: /\$_COOKIE\b/, kind: 'user_input', name: '$_COOKIE' },
  { re: /\$_FILES\b/, kind: 'user_input', name: '$_FILES' },
  { re: /\bphp:\/\/input\b/, kind: 'user_input', name: 'php://input' },
  { re: /\$argv\b/, kind: 'user_input', name: '$argv' },

  // File reads
  { re: /\bfile_get_contents\s*\(/, kind: 'fs_read', name: 'file_get_contents' },
  { re: /\bfread\s*\(/, kind: 'fs_read', name: 'fread' },
  { re: /\bfile\s*\(/, kind: 'fs_read', name: 'file()' },
  { re: /\breadfile\s*\(/, kind: 'fs_read', name: 'readfile' },

  // Credential files
  { re: /\bfile_get_contents\s*\(\s*['"][^'"]*(?:\.ssh|\.aws|\.env|credentials|id_rsa|\.pem)/, kind: 'credential_file', name: 'credential file read' },

  // Network responses
  { re: /\bcurl_exec\s*\(/, kind: 'network_response', name: 'curl_exec' },
  { re: /\bfile_get_contents\s*\(\s*['"]https?:/, kind: 'network_response', name: 'file_get_contents(url)' },
];

const SINK_PATTERNS: Array<{ re: RegExp; kind: TaintSink['kind']; name: string }> = [
  // Command execution
  { re: /\bexec\s*\(/, kind: 'exec', name: 'exec' },
  { re: /\bsystem\s*\(/, kind: 'exec', name: 'system' },
  { re: /\bshell_exec\s*\(/, kind: 'exec', name: 'shell_exec' },
  { re: /\bpassthru\s*\(/, kind: 'exec', name: 'passthru' },
  { re: /\bpopen\s*\(/, kind: 'spawn', name: 'popen' },
  { re: /\bproc_open\s*\(/, kind: 'spawn', name: 'proc_open' },
  { re: /`[^`]+`/, kind: 'exec', name: 'backtick' },
  { re: /\bpcntl_exec\s*\(/, kind: 'exec', name: 'pcntl_exec' },

  // Code evaluation
  { re: /\beval\s*\(/, kind: 'eval', name: 'eval' },
  { re: /\bassert\s*\(/, kind: 'eval', name: 'assert' },
  { re: /\bpreg_replace\s*\(\s*['"]\/[^'"]*\/e/, kind: 'eval', name: 'preg_replace /e' },
  { re: /\bcreate_function\s*\(/, kind: 'eval', name: 'create_function' },
  { re: /\bcall_user_func\s*\(/, kind: 'eval', name: 'call_user_func' },

  // Network send
  { re: /\bcurl_exec\s*\(/, kind: 'network_send', name: 'curl_exec' },
  { re: /\bfile_get_contents\s*\(\s*['"]https?:/, kind: 'fetch', name: 'file_get_contents(url)' },
  { re: /\bfsockopen\s*\(/, kind: 'network_send', name: 'fsockopen' },
  { re: /\bstream_socket_client\s*\(/, kind: 'network_send', name: 'stream_socket_client' },

  // File write
  { re: /\bfile_put_contents\s*\(/, kind: 'file_write', name: 'file_put_contents' },
  { re: /\bfwrite\s*\(/, kind: 'file_write', name: 'fwrite' },
  { re: /\bmove_uploaded_file\s*\(/, kind: 'file_write', name: 'move_uploaded_file' },
  { re: /\bcopy\s*\(/, kind: 'file_write', name: 'copy' },

  // Include (acts as eval for PHP)
  { re: /\binclude\s*\(?\s*\$/, kind: 'eval', name: 'include($var)' },
  { re: /\brequire\s*\(?\s*\$/, kind: 'eval', name: 'require($var)' },
];

const SUSPICIOUS_STRING_RE = /https?:\/\/(?!localhost|127\.0\.0\.1)/;
const CREDENTIAL_PATH_RE = /(?:\.ssh|\.aws|\.gnupg|\.kube)\b|\.env\b|credentials|id_rsa|\.pem$/;

// ── Extractor ───────────────────────────────────────────────────────────

const PHP_EXTENSIONS = new Set(['.php', '.phtml']);

function extractPHP(source: string, _filePath: string): ASTExtraction | null {
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

    // Skip comments
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) continue;
    if (trimmed === '') continue;

    // ── Imports (use/require/include) ─────────────────────────────
    const useMatch = trimmed.match(/^use\s+([\w\\]+)(?:\s+as\s+(\w+))?/);
    if (useMatch) {
      result.imports.push({
        source: useMatch[1],
        imported: [useMatch[2] || useMatch[1].split('\\').pop() || '*'],
        line: lineNum,
      });
    }
    // require/include with string literal (not variable — those are sinks)
    const reqMatch = trimmed.match(/^(?:require_once|require|include_once|include)\s*\(?\s*['"]([^'"]+)['"]/);
    if (reqMatch) {
      result.imports.push({
        source: reqMatch[1],
        imported: ['*'],
        line: lineNum,
      });
    }

    // ── Functions ─────────────────────────────────────────────────
    const funcMatch = trimmed.match(/^(?:public|private|protected|static|\s)*function\s+(\w+)\s*\(([^)]*)\)/);
    if (funcMatch) {
      const params = funcMatch[2]
        ? funcMatch[2].split(',').map(p => p.trim().replace(/^[?&]?\s*\w+\s+/, '').split('=')[0].replace('$', '').trim()).filter(Boolean)
        : [];
      result.functions.push({
        name: funcMatch[1],
        params,
        line: lineNum,
        exported: trimmed.includes('public') || (!trimmed.includes('private') && !trimmed.includes('protected')),
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

export const phpExtractor: LanguageExtractor = {
  language: 'php',
  extensions: PHP_EXTENSIONS,
  extract: extractPHP,
};
