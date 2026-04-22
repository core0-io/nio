// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-file Context Aggregation.
 *
 * Correlates AST extractions across multiple files to detect attack
 * patterns that span file boundaries.  For example:
 *   - File A exports a function that reads credentials
 *   - File B imports that function and sends data to a network endpoint
 *
 * Also aggregates security indicators across the whole skill to build
 * a holistic threat picture.
 */

import type { ASTExtraction, ImportInfo } from './types.js';
import type { DataflowPath } from './dataflow.js';

// ── Types ────────────────────────────────────────────────────────────────

/** Per-file analysis result. */
export interface FileAnalysis {
  file: string;
  extraction: ASTExtraction;
  flows: DataflowPath[];
}

/** A cross-file correlation finding. */
export interface CrossFileFlow {
  /** File that exports the dangerous capability. */
  sourceFile: string;
  /** File that consumes the dangerous export. */
  sinkFile: string;
  /** What is exported (function/variable name). */
  exportName: string;
  /** Description of the cross-file flow. */
  description: string;
}

/** Aggregated security indicators across the whole skill. */
export interface SecurityProfile {
  /** Files that import dangerous modules. */
  dangerousImports: Array<{ file: string; module: string; line: number }>;
  /** Total source→sink flows detected. */
  totalFlows: number;
  /** Cross-file flows detected. */
  crossFileFlows: CrossFileFlow[];
  /** Suspicious external URLs found across all files. */
  suspiciousUrls: Array<{ url: string; file: string; line: number }>;
  /** Summary of capabilities: which dangerous things can this skill do? */
  capabilities: Set<string>;
}

// ── Dangerous module set ─────────────────────────────────────────────────

const DANGEROUS_MODULES = new Set([
  'child_process', 'node:child_process',
  'fs', 'node:fs', 'fs/promises', 'node:fs/promises',
  'net', 'node:net',
  'http', 'node:http',
  'https', 'node:https',
  'dgram', 'node:dgram',
  'cluster', 'node:cluster',
  'worker_threads', 'node:worker_threads',
]);

const CAPABILITY_MODULES: Record<string, string> = {
  'child_process': 'command_execution',
  'node:child_process': 'command_execution',
  'fs': 'filesystem_access',
  'node:fs': 'filesystem_access',
  'fs/promises': 'filesystem_access',
  'node:fs/promises': 'filesystem_access',
  'net': 'network_access',
  'node:net': 'network_access',
  'http': 'network_access',
  'node:http': 'network_access',
  'https': 'network_access',
  'node:https': 'network_access',
};

// ── Aggregation ──────────────────────────────────────────────────────────

/**
 * Aggregate file-level analyses into a cross-file security profile.
 */
export function aggregateContext(files: FileAnalysis[]): SecurityProfile {
  const profile: SecurityProfile = {
    dangerousImports: [],
    totalFlows: 0,
    crossFileFlows: [],
    suspiciousUrls: [],
    capabilities: new Set(),
  };

  // Build export map: file → exported function names with their characteristics
  const exportMap = new Map<string, Set<string>>();
  // Track which files have sinks
  const filesWithSinks = new Set<string>();
  // Track which files have sources
  const filesWithSources = new Set<string>();

  for (const fa of files) {
    const { file, extraction, flows } = fa;

    // Track dangerous imports
    for (const imp of extraction.imports) {
      if (DANGEROUS_MODULES.has(imp.source)) {
        profile.dangerousImports.push({ file, module: imp.source, line: imp.line });
        const cap = CAPABILITY_MODULES[imp.source];
        if (cap) profile.capabilities.add(cap);
      }
    }

    // Track suspicious URLs
    for (const s of extraction.suspiciousStrings) {
      if (s.value.startsWith('http')) {
        profile.suspiciousUrls.push({ url: s.value, file, line: s.line });
      }
    }

    // Track total flows
    profile.totalFlows += flows.length;

    // Track exports
    const exported = new Set<string>();
    for (const fn of extraction.functions) {
      if (fn.exported) exported.add(fn.name);
    }
    exportMap.set(file, exported);

    // Track sink/source presence
    if (extraction.sinks.length > 0) filesWithSinks.add(file);
    if (extraction.sources.length > 0) filesWithSources.add(file);

    // Track capabilities from sinks
    for (const sink of extraction.sinks) {
      if (sink.kind === 'exec' || sink.kind === 'spawn') {
        profile.capabilities.add('command_execution');
      }
      if (sink.kind === 'fetch' || sink.kind === 'network_send') {
        profile.capabilities.add('network_access');
      }
      if (sink.kind === 'file_write') {
        profile.capabilities.add('filesystem_write');
      }
      if (sink.kind === 'eval') {
        profile.capabilities.add('code_evaluation');
      }
    }
  }

  // Detect cross-file flows:
  // If file A exports functions with sources, and file B imports from A
  // and has sinks, that's a potential cross-file flow.
  for (const fa of files) {
    for (const imp of fa.extraction.imports) {
      // Resolve relative imports to file paths
      const importedFile = resolveImportToFile(imp, fa.file, files);
      if (!importedFile) continue;

      const importedExports = exportMap.get(importedFile);
      if (!importedExports) continue;

      // Check if the imported file has sources and this file has sinks
      if (filesWithSources.has(importedFile) && filesWithSinks.has(fa.file)) {
        for (const name of imp.imported) {
          if (name === '*' || importedExports.has(name)) {
            profile.crossFileFlows.push({
              sourceFile: importedFile,
              sinkFile: fa.file,
              exportName: name,
              description: `${fa.file} imports '${name}' from ${importedFile}; ` +
                `source file has data sources and importing file has sinks`,
            });
          }
        }
      }
    }
  }

  return profile;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Try to resolve a relative import to one of the analysed files.
 * This is a best-effort heuristic — it handles ./foo, ../foo, and
 * extension resolution (.ts, .js, /index.ts).
 */
function resolveImportToFile(
  imp: ImportInfo,
  importingFile: string,
  files: FileAnalysis[],
): string | null {
  if (!imp.source.startsWith('.')) return null; // skip node_modules

  const dir = importingFile.replace(/\/[^/]+$/, '');
  const base = normalizePath(`${dir}/${imp.source}`);

  // Try exact match, then with extensions
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}/index.ts`,
    `${base}/index.js`,
  ];

  for (const candidate of candidates) {
    if (files.some((f) => f.file === candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Normalize a path with .. and . segments. */
function normalizePath(p: string): string {
  const parts = p.split('/');
  const result: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      result.pop();
    } else if (part !== '.') {
      result.push(part);
    }
  }
  return result.join('/');
}
