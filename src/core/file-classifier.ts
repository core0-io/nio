/**
 * File type classification.
 *
 * Categorizes files by extension and (optionally) content-based heuristics.
 * Used by the orchestrator to route files to the appropriate analysers.
 */

import type { FileInfo } from '../scanner/file-walker.js';

export type FileCategory =
  | 'code_js'      // .js, .jsx, .mjs, .cjs, .ts, .tsx
  | 'code_python'  // .py
  | 'code_shell'   // .sh, .bash
  | 'config'       // .json, .yaml, .yml, .toml
  | 'markdown'     // .md
  | 'solidity'     // .sol
  | 'other';

const EXTENSION_MAP: Record<string, FileCategory> = {
  '.js': 'code_js',
  '.jsx': 'code_js',
  '.mjs': 'code_js',
  '.cjs': 'code_js',
  '.ts': 'code_js',
  '.tsx': 'code_js',
  '.py': 'code_python',
  '.sh': 'code_shell',
  '.bash': 'code_shell',
  '.json': 'config',
  '.yaml': 'config',
  '.yml': 'config',
  '.toml': 'config',
  '.md': 'markdown',
  '.sol': 'solidity',
};

/** Classify a file by its extension. */
export function classifyFile(file: FileInfo): FileCategory {
  return EXTENSION_MAP[file.extension] ?? 'other';
}

/** Check if a file is analysable by the behavioural (AST) analyser. */
export function isASTAnalysable(file: FileInfo): boolean {
  return classifyFile(file) === 'code_js';
}

/** Group files by category. */
export function groupByCategory(files: FileInfo[]): Map<FileCategory, FileInfo[]> {
  const groups = new Map<FileCategory, FileInfo[]>();
  for (const f of files) {
    const cat = classifyFile(f);
    const group = groups.get(cat) ?? [];
    group.push(f);
    groups.set(cat, group);
  }
  return groups;
}
