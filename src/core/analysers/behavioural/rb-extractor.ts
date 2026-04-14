/**
 * Ruby Extractor — regex-based security extraction for Ruby files.
 *
 * Ruby's syntax is close to Python, making regex extraction straightforward:
 *
 *   Sources: ENV['KEY'], File.read(), ARGV, gets
 *   Sinks:   system(), exec(), eval(), `backtick`, Net::HTTP, open-uri
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
  { re: /\bENV\s*\[/, kind: 'env', name: 'ENV[]' },
  { re: /\bENV\.fetch\s*\(/, kind: 'env', name: 'ENV.fetch' },

  // File reads
  { re: /\bFile\.read\s*\(/, kind: 'fs_read', name: 'File.read' },
  { re: /\bFile\.open\s*\(/, kind: 'fs_read', name: 'File.open' },
  { re: /\bIO\.read\s*\(/, kind: 'fs_read', name: 'IO.read' },
  { re: /\bFile\.readlines\s*\(/, kind: 'fs_read', name: 'File.readlines' },

  // Credential files
  { re: /\bFile\.(?:read|open)\s*\(\s*['"][^'"]*(?:\.ssh|\.aws|\.env|credentials|id_rsa|\.pem)/, kind: 'credential_file', name: 'credential file read' },

  // User input
  { re: /\bgets\b/, kind: 'user_input', name: 'gets' },
  { re: /\bARGV\b/, kind: 'user_input', name: 'ARGV' },
  { re: /\bSTDIN\./, kind: 'user_input', name: 'STDIN' },
  { re: /\breadline\b/, kind: 'user_input', name: 'readline' },

  // Network responses
  { re: /\bNet::HTTP\.get\b/, kind: 'network_response', name: 'Net::HTTP.get' },
  { re: /\bHTTParty\.get\s*\(/, kind: 'network_response', name: 'HTTParty.get' },
  { re: /\bFaraday\.\w+\s*\(/, kind: 'network_response', name: 'Faraday' },
  { re: /\bopen-uri\b/, kind: 'network_response', name: 'open-uri' },
];

const SINK_PATTERNS: Array<{ re: RegExp; kind: TaintSink['kind']; name: string }> = [
  // Command execution
  { re: /\bsystem\s*\(/, kind: 'exec', name: 'system' },
  { re: /\bexec\s*\(/, kind: 'exec', name: 'exec' },
  { re: /\b%x\{/, kind: 'exec', name: '%x{}' },
  { re: /\b%x\[/, kind: 'exec', name: '%x[]' },
  { re: /`[^`]+`/, kind: 'exec', name: 'backtick' },
  { re: /\bIO\.popen\s*\(/, kind: 'spawn', name: 'IO.popen' },
  { re: /\bOpen3\./, kind: 'spawn', name: 'Open3' },
  { re: /\bKernel\.system\s*\(/, kind: 'exec', name: 'Kernel.system' },
  { re: /\bProcess\.spawn\s*\(/, kind: 'spawn', name: 'Process.spawn' },

  // Code evaluation
  { re: /\beval\s*\(/, kind: 'eval', name: 'eval' },
  { re: /\binstance_eval\b/, kind: 'eval', name: 'instance_eval' },
  { re: /\bclass_eval\b/, kind: 'eval', name: 'class_eval' },
  { re: /\bmodule_eval\b/, kind: 'eval', name: 'module_eval' },
  { re: /\bsend\s*\(/, kind: 'eval', name: 'send' },

  // Network send
  { re: /\bNet::HTTP\.post\b/, kind: 'network_send', name: 'Net::HTTP.post' },
  { re: /\bHTTParty\.post\s*\(/, kind: 'network_send', name: 'HTTParty.post' },
  { re: /\bFaraday\.post\s*\(/, kind: 'network_send', name: 'Faraday.post' },
  { re: /\bRestClient\.post\s*\(/, kind: 'network_send', name: 'RestClient.post' },

  // Fetch
  { re: /\bNet::HTTP\.get\b/, kind: 'fetch', name: 'Net::HTTP.get' },
  { re: /\bHTTParty\.get\s*\(/, kind: 'fetch', name: 'HTTParty.get' },
  { re: /\bopen\s*\(\s*['"]https?:/, kind: 'fetch', name: 'open(url)' },

  // File write
  { re: /\bFile\.write\s*\(/, kind: 'file_write', name: 'File.write' },
  { re: /\bFile\.open\s*\([^)]*,\s*['"]w/, kind: 'file_write', name: 'File.open(w)' },
  { re: /\bIO\.write\s*\(/, kind: 'file_write', name: 'IO.write' },
  { re: /\bFileUtils\./, kind: 'file_write', name: 'FileUtils' },
];

const DANGEROUS_MODULES = new Set([
  'open3', 'open-uri', 'net/http', 'net/https',
  'socket', 'fileutils', 'shellwords',
]);

const SUSPICIOUS_STRING_RE = /https?:\/\/(?!localhost|127\.0\.0\.1)/;
const CREDENTIAL_PATH_RE = /(?:\.ssh|\.aws|\.gnupg|\.kube)\b|\.env\b|credentials|id_rsa|\.pem$/;

// ── Extractor ───────────────────────────────────────────────────────────

const RB_EXTENSIONS = new Set(['.rb', '.rake', '.gemspec']);

function extractRuby(source: string, _filePath: string): ASTExtraction | null {
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

    if (trimmed.startsWith('#') || trimmed === '') continue;

    // ── Imports (require/require_relative) ────────────────────────
    const reqMatch = trimmed.match(/^(?:require|require_relative|gem)\s+['"]([^'"]+)['"]/);
    if (reqMatch) {
      result.imports.push({
        source: reqMatch[1],
        imported: ['*'],
        line: lineNum,
      });
    }

    // ── Functions ─────────────────────────────────────────────────
    const funcMatch = trimmed.match(/^def\s+(self\.)?(\w+[!?]?)(?:\s*\(([^)]*)\))?/);
    if (funcMatch) {
      const name = (funcMatch[1] || '') + funcMatch[2];
      const params = funcMatch[3]
        ? funcMatch[3].split(',').map(p => p.trim().replace(/^[*&]/, '').split('=')[0].split(':')[0].trim()).filter(Boolean)
        : [];
      result.functions.push({
        name,
        params,
        line: lineNum,
        exported: !name.startsWith('_'),
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

export const rbExtractor: LanguageExtractor = {
  language: 'ruby',
  extensions: RB_EXTENSIONS,
  extract: extractRuby,
};
