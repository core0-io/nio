/**
 * Dataflow Tracker — forward taint analysis for source→sink detection.
 *
 * This is a lightweight, line-level taint tracker (not a full CFG-based
 * fixpoint solver).  It works by:
 *
 *   1. Marking variables that receive data from known sources as "tainted"
 *   2. Propagating taint through assignments (x = taintedVar)
 *   3. Flagging when a tainted variable reaches a known sink
 *
 * This catches the most common attack patterns:
 *   - process.env.SECRET → fetch(url, { body: secret })
 *   - fs.readFileSync("~/.ssh/id_rsa") → axios.post(url, data)
 *   - require("child_process").exec(userInput)
 */

import type { TaintSource, TaintSink, ASTExtraction, Language } from './types.js';

// ── Types ────────────────────────────────────────────────────────────────

/** A detected source→sink flow. */
export interface DataflowPath {
  /** The taint source. */
  source: TaintSource;
  /** The sink where tainted data arrives. */
  sink: TaintSink;
  /** Variable names along the flow path. */
  path: string[];
  /** Brief description of the flow. */
  description: string;
}

// ── Taint tracker ────────────────────────────────────────────────────────

/**
 * Analyze an AST extraction for source→sink dataflows.
 *
 * Uses a simple heuristic: if any source variable name appears as a
 * substring in the line containing a sink call, we flag a flow.
 * This is intentionally over-approximate (some false positives are
 * acceptable for security scanning).
 */
export function analyzeDataflows(
  extraction: ASTExtraction,
  fileContent: string,
  language: Language = 'javascript',
): DataflowPath[] {
  const flows: DataflowPath[] = [];
  const lines = fileContent.split('\n');

  // Phase 1: Build taint set from sources
  const taintedVars = new Map<string, TaintSource>();

  for (const source of extraction.sources) {
    // Extract the variable name from the source line
    const line = lines[source.line - 1] ?? '';
    const varNames = extractAssignmentTargets(line, language);

    for (const v of varNames) {
      taintedVars.set(v, source);
    }

    // Also taint the source expression itself (e.g. "process.env")
    const parts = source.name.split('.');
    if (parts.length > 0) {
      taintedVars.set(parts[parts.length - 1], source);
    }
  }

  // Phase 2: Propagate taint through assignments
  // Simple one-pass propagation — catches direct assignments
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const targets = extractAssignmentTargets(line, language);

    for (const target of targets) {
      // Check if any tainted variable appears in the RHS
      for (const [tainted, source] of taintedVars) {
        if (target !== tainted && lineContainsVariable(line, tainted)) {
          taintedVars.set(target, source);
        }
      }
    }
  }

  // Phase 3: Check if any tainted variable reaches a sink
  for (const sink of extraction.sinks) {
    const sinkLine = lines[sink.line - 1] ?? '';

    for (const [varName, source] of taintedVars) {
      if (lineContainsVariable(sinkLine, varName)) {
        flows.push({
          source,
          sink,
          path: [source.name, varName, sink.name],
          description: describeFlow(source, sink, varName),
        });
      }
    }
  }

  // Phase 4: Check for direct dangerous patterns (no variable tracking needed)
  // e.g. fetch().then(eval), exec(require(...))
  flows.push(...detectDirectFlows(extraction, lines));

  return deduplicateFlows(flows);
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Extract variable names on the LHS of assignments in a line.
 * Language-aware: JS uses const/let/var declarations, Python uses bare assignment.
 */
function extractAssignmentTargets(line: string, language: Language): string[] {
  const targets: string[] = [];
  const trimmed = line.trim();

  switch (language) {
    case 'python': {
      // x = ..., x: type = ... (not ==, not <=, not >=, not !=)
      const m = trimmed.match(/^(\w+)\s*(?::\s*\w[^=]*)?\s*=[^=]/);
      if (m && !['if', 'while', 'for', 'return', 'elif', 'else', 'def', 'class', 'import', 'from'].includes(m[1])) {
        targets.push(m[1]);
      }
      break;
    }
    case 'shell': {
      // VAR=value, VAR=$(cmd), export VAR=value, local VAR=value
      const m = trimmed.match(/^(?:export\s+|local\s+|declare\s+(?:-\w\s+)*)?(\w+)=/);
      if (m) targets.push(m[1]);
      break;
    }
    case 'ruby': {
      // x = ..., @x = ..., @@x = ..., $x = ...
      const m = trimmed.match(/^(?:[$@]{0,2})(\w+)\s*=[^=]/);
      if (m && !['if', 'unless', 'while', 'until', 'for', 'return', 'def', 'class', 'module'].includes(m[1])) {
        targets.push(m[1]);
      }
      break;
    }
    case 'php': {
      // $var = ...
      const m = trimmed.match(/\$(\w+)\s*=[^=]/);
      if (m) targets.push(m[1]);
      break;
    }
    case 'go': {
      // x := ..., x = ..., x, err := ...
      const shortDecl = trimmed.match(/^(\w+)(?:\s*,\s*\w+)*\s*:=/);
      if (shortDecl) targets.push(shortDecl[1]);
      const assign = trimmed.match(/^(\w+)\s*=[^=]/);
      if (assign && !['if', 'for', 'return', 'switch', 'case', 'func', 'type', 'var'].includes(assign[1])) {
        targets.push(assign[1]);
      }
      // var x = ...
      const varDecl = trimmed.match(/\bvar\s+(\w+)\s*(?:\w+\s*)?=/);
      if (varDecl) targets.push(varDecl[1]);
      break;
    }
    default: {
      // JS/TS: const x =, let x =, var x =
      const declMatch = trimmed.match(/(?:const|let|var)\s+(\w+)\s*=/);
      if (declMatch) targets.push(declMatch[1]);
      // x = ... (bare assignment, not == or ===)
      const assignMatch = trimmed.match(/^(\w+)\s*=[^=]/);
      if (assignMatch && !['const', 'let', 'var', 'if', 'while', 'for', 'return'].includes(assignMatch[1])) {
        targets.push(assignMatch[1]);
      }
      break;
    }
  }

  return targets;
}

/** Check if a line contains a variable name as a word boundary. */
function lineContainsVariable(line: string, varName: string): boolean {
  // Use word boundary check to avoid false positives
  const re = new RegExp(`\\b${escapeRegex(varName)}\\b`);
  return re.test(line);
}

/** Escape special regex characters. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Describe a source→sink flow in human-readable form. */
function describeFlow(source: TaintSource, sink: TaintSink, via: string): string {
  const sourceDesc: Record<TaintSource['kind'], string> = {
    env: 'environment variable',
    fs_read: 'file read',
    credential_file: 'credential file',
    user_input: 'user input',
    network_response: 'network response',
  };

  const sinkDesc: Record<TaintSink['kind'], string> = {
    exec: 'command execution',
    eval: 'code evaluation',
    fetch: 'network request',
    network_send: 'network send',
    file_write: 'file write',
    spawn: 'process spawn',
  };

  return `Data from ${sourceDesc[source.kind]} (${source.name}) flows via '${via}' to ${sinkDesc[sink.kind]} (${sink.name})`;
}

/**
 * Detect direct dangerous patterns that don't need variable tracking:
 *   - fetch().then(eval)
 *   - fetch().then(code => new Function(code))
 *   - exec(require(...))
 */
function detectDirectFlows(extraction: ASTExtraction, lines: string[]): DataflowPath[] {
  const flows: DataflowPath[] = [];

  // Check for fetch().then(eval) or fetch().then(res => eval(res)) patterns
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // fetch/axios followed by eval/Function on same or adjacent lines
    if (/\bfetch\s*\(/.test(line)) {
      // Look ahead a few lines for eval/Function
      const window = lines.slice(i, i + 5).join('\n');
      if (/\b(?:eval|Function)\s*\(/.test(window)) {
        flows.push({
          source: {
            kind: 'network_response',
            name: 'fetch()',
            line: i + 1,
            column: 0,
          },
          sink: {
            kind: 'eval',
            name: 'eval/Function',
            line: i + 1,
            column: 0,
          },
          path: ['fetch()', 'response', 'eval()'],
          description: 'Network response from fetch() flows to code evaluation (eval/Function)',
        });
      }
    }
  }

  return flows;
}

/** Remove duplicate flows (same source line + same sink line). */
function deduplicateFlows(flows: DataflowPath[]): DataflowPath[] {
  const seen = new Set<string>();
  return flows.filter((f) => {
    const key = `${f.source.line}:${f.sink.line}:${f.source.kind}:${f.sink.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
