// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared types for the Behavioural Analyser — language-agnostic interfaces
 * that all language extractors produce and the dataflow tracker consumes.
 */

// ── Taint Sources & Sinks ──────────────────────────────────────────────

/** A security-relevant source (data origin). */
export interface TaintSource {
  kind: 'env' | 'fs_read' | 'credential_file' | 'user_input' | 'network_response';
  name: string;
  line: number;
  column: number;
  snippet?: string;
}

/** A security-relevant sink (where data is consumed). */
export interface TaintSink {
  kind: 'exec' | 'eval' | 'fetch' | 'network_send' | 'file_write' | 'spawn';
  name: string;
  line: number;
  column: number;
  snippet?: string;
}

// ── Extraction Result ──────────────────────────────────────────────────

/** An import extracted from the file. */
export interface ImportInfo {
  source: string;
  imported: string[];
  line: number;
}

/** A function definition extracted from the file. */
export interface FunctionInfo {
  name: string;
  params: string[];
  line: number;
  exported: boolean;
}

/** Complete extraction result for a single file — produced by every language extractor. */
export interface ASTExtraction {
  imports: ImportInfo[];
  functions: FunctionInfo[];
  sources: TaintSource[];
  sinks: TaintSink[];
  suspiciousStrings: Array<{ value: string; line: number }>;
}

// ── Language Extractor Interface ────────────────────────────────────────

/** Supported language identifiers. */
export type Language = 'javascript' | 'python' | 'shell' | 'ruby' | 'php' | 'go';

/**
 * A language extractor parses source code and extracts security-relevant
 * information into a common ASTExtraction shape.
 */
export interface LanguageExtractor {
  /** Which language this extractor handles. */
  readonly language: Language;
  /** File extensions this extractor supports (including the dot). */
  readonly extensions: ReadonlySet<string>;
  /**
   * Parse source code and extract security info.
   * Returns null if parsing fails.
   */
  extract(source: string, filePath: string): ASTExtraction | null;
}
