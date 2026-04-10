/**
 * JS/TS Extractor — extracts security-relevant information from TypeScript/JavaScript.
 *
 * Uses @babel/parser to build the AST and @babel/traverse to walk it.
 * Extracts:
 *   - Import/require declarations (what modules are loaded)
 *   - Function declarations with their bodies
 *   - Call expressions that match security-relevant sinks
 *   - String literals that look like URLs, IPs, or paths
 *
 * Implements LanguageExtractor so the BehavioralAnalyzer can dispatch by extension.
 */

import { parse, type ParserPlugin } from '@babel/parser';
import type { Node, CallExpression, MemberExpression } from '@babel/types';
import type { LanguageExtractor, ASTExtraction, TaintSource, TaintSink } from './types.js';

// Re-export shared types for backward compatibility
export type { TaintSource, TaintSink, ImportInfo, FunctionInfo, ASTExtraction } from './types.js';

// @babel/traverse ships as CJS with a default export.
// We use createRequire for reliable interop in ESM.
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const traverse = _require('@babel/traverse').default as any;

// ── Security patterns ────────────────────────────────────────────────────

/** Modules that provide dangerous capabilities. */
const DANGEROUS_MODULES = new Set([
  'child_process', 'node:child_process',
  'fs', 'node:fs', 'fs/promises', 'node:fs/promises',
]);

/** Function/method names that are taint sources. */
const SOURCE_PATTERNS: Record<string, TaintSource['kind']> = {
  'process.env': 'env',
  'fs.readFileSync': 'fs_read',
  'fs.readFile': 'fs_read',
  'fsPromises.readFile': 'fs_read',
  'readFileSync': 'fs_read',
  'readFile': 'fs_read',
};

/** Function/method names that are taint sinks. */
const SINK_PATTERNS: Record<string, TaintSink['kind']> = {
  'exec': 'exec',
  'execSync': 'exec',
  'execFile': 'exec',
  'execFileSync': 'exec',
  'spawn': 'spawn',
  'spawnSync': 'spawn',
  'eval': 'eval',
  'Function': 'eval',
  'fetch': 'fetch',
  'axios.post': 'network_send',
  'axios.put': 'network_send',
  'axios.patch': 'network_send',
  'request': 'network_send',
  'http.request': 'network_send',
  'https.request': 'network_send',
  'fs.writeFileSync': 'file_write',
  'fs.writeFile': 'file_write',
  'writeFileSync': 'file_write',
  'writeFile': 'file_write',
};

/** Regex for suspicious string literals. */
const SUSPICIOUS_STRING_RE = /^https?:\/\/(?!localhost|127\.0\.0\.1)/;
const CREDENTIAL_PATH_RE = /\.(ssh|aws|gnupg|kube)\b|\.env\b|credentials|id_rsa|\.pem$/;

// ── Parser ───────────────────────────────────────────────────────────────

/**
 * Parse a TS/JS file and extract security-relevant information.
 *
 * Returns null if parsing fails (e.g. non-JS content).
 */
export function parseAndExtract(
  source: string,
  filePath: string,
): ASTExtraction | null {
  // Determine parser plugins from extension
  const plugins: ParserPlugin[] = ['decorators'];
  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
    plugins.push('typescript');
  }
  if (filePath.endsWith('.jsx') || filePath.endsWith('.tsx')) {
    plugins.push('jsx');
  }

  let ast: ReturnType<typeof parse>;
  try {
    ast = parse(source, {
      sourceType: 'unambiguous',
      plugins,
      errorRecovery: true, // don't bail on minor syntax errors
    });
  } catch {
    return null; // unparseable file — skip
  }

  const result: ASTExtraction = {
    imports: [],
    functions: [],
    sources: [],
    sinks: [],
    suspiciousStrings: [],
  };

  const lines = source.split('\n');

  traverse(ast, {
    // ── Imports ──────────────────────────────────────────────────────
    ImportDeclaration(path: any) {
      const node = path.node;
      const imported = node.specifiers.map((s: any) => {
        if (s.type === 'ImportDefaultSpecifier') return 'default';
        if (s.type === 'ImportNamespaceSpecifier') return '*';
        return s.imported.type === 'Identifier' ? s.imported.name : s.imported.value;
      });
      result.imports.push({
        source: node.source.value,
        imported,
        line: node.loc?.start.line ?? 0,
      });
    },

    // ── Require calls ───────────────────────────────────────────────
    CallExpression(path: any) {
      const node = path.node;

      // require('...')
      if (
        node.callee.type === 'Identifier' &&
        node.callee.name === 'require' &&
        node.arguments.length === 1 &&
        node.arguments[0].type === 'StringLiteral'
      ) {
        result.imports.push({
          source: node.arguments[0].value,
          imported: ['*'],
          line: node.loc?.start.line ?? 0,
        });
      }

      // Detect sinks
      const sinkName = callExpressionName(node);
      if (sinkName) {
        const sinkKind = SINK_PATTERNS[sinkName];
        if (sinkKind) {
          const line = node.loc?.start.line ?? 0;
          result.sinks.push({
            kind: sinkKind,
            name: sinkName,
            line,
            column: node.loc?.start.column ?? 0,
            snippet: lines[line - 1]?.trim().slice(0, 120),
          });
        }
      }

      // Detect dynamic import() with variable argument (not string literal)
      if (node.callee.type === 'Import' && node.arguments.length > 0) {
        if (node.arguments[0].type !== 'StringLiteral') {
          const line = node.loc?.start.line ?? 0;
          result.sinks.push({
            kind: 'eval',
            name: 'import()',
            line,
            column: node.loc?.start.column ?? 0,
            snippet: lines[line - 1]?.trim().slice(0, 120),
          });
        }
      }
    },

    // ── Member expressions for sources ──────────────────────────────
    MemberExpression(path: any) {
      const node = path.node;
      const name = memberExpressionName(node);
      if (!name) return;

      const sourceKind = SOURCE_PATTERNS[name];
      if (sourceKind) {
        const line = node.loc?.start.line ?? 0;
        result.sources.push({
          kind: sourceKind,
          name,
          line,
          column: node.loc?.start.column ?? 0,
          snippet: lines[line - 1]?.trim().slice(0, 120),
        });
      }
    },

    // ── Function declarations ───────────────────────────────────────
    FunctionDeclaration(path: any) {
      const node = path.node;
      result.functions.push({
        name: node.id?.name ?? '<anonymous>',
        params: node.params.map(paramName),
        line: node.loc?.start.line ?? 0,
        exported: path.parentPath?.isExportNamedDeclaration() ||
                  path.parentPath?.isExportDefaultDeclaration() || false,
      });
    },

    // Arrow functions assigned to variables
    VariableDeclarator(path: any) {
      const node = path.node;
      if (
        node.init &&
        (node.init.type === 'ArrowFunctionExpression' ||
         node.init.type === 'FunctionExpression') &&
        node.id.type === 'Identifier'
      ) {
        const grandParent = path.parentPath?.parentPath;
        result.functions.push({
          name: node.id.name,
          params: node.init.params.map(paramName),
          line: node.loc?.start.line ?? 0,
          exported: grandParent?.isExportNamedDeclaration() || false,
        });
      }
    },

    // ── String literals ─────────────────────────────────────────────
    StringLiteral(path: any) {
      const val = path.node.value;
      if (SUSPICIOUS_STRING_RE.test(val) || CREDENTIAL_PATH_RE.test(val)) {
        result.suspiciousStrings.push({
          value: val,
          line: path.node.loc?.start.line ?? 0,
        });
      }
    },

    TemplateLiteral(path: any) {
      // Check quasis (static parts of template strings)
      for (const q of path.node.quasis) {
        const val = q.value.raw;
        if (SUSPICIOUS_STRING_RE.test(val) || CREDENTIAL_PATH_RE.test(val)) {
          result.suspiciousStrings.push({
            value: val.slice(0, 200),
            line: q.loc?.start.line ?? 0,
          });
        }
      }
    },
  });

  return result;
}

// ── Utilities ────────────────────────────────────────────────────────────

/** Extract a dotted name from a CallExpression (e.g. "fs.readFileSync"). */
function callExpressionName(node: CallExpression): string | null {
  if (node.callee.type === 'Identifier') {
    return node.callee.name;
  }
  if (node.callee.type === 'MemberExpression') {
    return memberExpressionName(node.callee);
  }
  return null;
}

/** Extract a dotted name from a MemberExpression (e.g. "process.env"). */
function memberExpressionName(node: MemberExpression): string | null {
  const prop = node.property.type === 'Identifier'
    ? node.property.name
    : node.property.type === 'StringLiteral'
      ? node.property.value
      : null;
  if (!prop) return null;

  if (node.object.type === 'Identifier') {
    return `${node.object.name}.${prop}`;
  }
  return null;
}

/** Extract parameter name from a function param node. */
function paramName(node: Node): string {
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'AssignmentPattern' && node.left.type === 'Identifier') {
    return node.left.name;
  }
  if (node.type === 'RestElement' && node.argument.type === 'Identifier') {
    return `...${node.argument.name}`;
  }
  return '<destructured>';
}

// ── JSExtractor (LanguageExtractor implementation) ──────────────────────

const JS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

export const jsExtractor: LanguageExtractor = {
  language: 'javascript',
  extensions: JS_EXTENSIONS,
  extract: parseAndExtract,
};
