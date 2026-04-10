/**
 * Behavioral Analyzer — Phase 1 AST-based security analysis.
 *
 * Pipeline (per Cisco skill-scanner architecture, adapted for TypeScript):
 *
 *   Source File
 *     ↓
 *   AST Parser (@babel/parser)
 *     ↓
 *   Function Extraction + Security Indicators
 *     ↓
 *   Dataflow Tracker (source → sink)
 *     ↓
 *   Cross-file Context Aggregation
 *     ↓
 *   Finding Generation
 *
 * Only processes .ts, .tsx, .js, .jsx, .mjs, .cjs files.
 * Non-JS files are skipped (the StaticAnalyzer handles those with regex).
 */

import { BaseAnalyzer, type AnalysisContext } from '../base.js';
import type { Finding, AnalyzerName, ThreatCategory, Severity } from '../../models.js';
import { findingId } from '../../models.js';
import type { ScanPolicy } from '../../scan-policy.js';
import { parseAndExtract, type ASTExtraction } from './ast-parser.js';
import { analyzeDataflows, type DataflowPath } from './dataflow.js';
import { aggregateContext, type FileAnalysis, type SecurityProfile } from './context.js';

// ── BehavioralAnalyzer ───────────────────────────────────────────────────

const JS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

export class BehavioralAnalyzer extends BaseAnalyzer {
  readonly name: AnalyzerName = 'behavioral';
  readonly phase: 1 = 1;

  isEnabled(policy: ScanPolicy): boolean {
    return policy.analyzers.behavioral;
  }

  async analyze(ctx: AnalysisContext): Promise<Finding[]> {
    const jsFiles = ctx.files.filter((f) => JS_EXTENSIONS.has(f.extension));
    if (jsFiles.length === 0) return [];

    // Step 1: Parse all JS/TS files and extract security info
    const fileAnalyses: FileAnalysis[] = [];
    for (const file of jsFiles) {
      const extraction = parseAndExtract(file.content, file.relativePath);
      if (!extraction) continue;

      // Step 2: Run dataflow analysis per file
      const flows = analyzeDataflows(extraction, file.content);

      fileAnalyses.push({
        file: file.relativePath,
        extraction,
        flows,
      });
    }

    // Step 3: Cross-file context aggregation
    const profile = aggregateContext(fileAnalyses);

    // Step 4: Generate findings from all collected data
    const findings: Finding[] = [];

    // 4a: Findings from per-file dataflow paths
    for (const fa of fileAnalyses) {
      for (const flow of fa.flows) {
        findings.push(dataflowToFinding(fa.file, flow));
      }
    }

    // 4b: Findings from cross-file flows
    for (const cf of profile.crossFileFlows) {
      findings.push({
        id: findingId('CROSS_FILE_FLOW', cf.sinkFile, 0),
        rule_id: 'CROSS_FILE_FLOW',
        category: 'exfiltration',
        severity: 'medium',
        title: 'Cross-file Data Flow',
        description: cf.description,
        location: { file: cf.sinkFile, line: 0 },
        analyzer: 'behavioral',
        confidence: 0.6,
        metadata: {
          source_file: cf.sourceFile,
          export_name: cf.exportName,
        },
      });
    }

    // 4c: Findings from dangerous import + capability combinations
    findings.push(...capabilityFindings(profile, fileAnalyses));

    // Filter out disabled rules
    return findings.filter(
      (f) => !ctx.policy.rules.disabled_rules.includes(f.rule_id),
    );
  }
}

// ── Finding generators ───────────────────────────────────────────────────

/** Convert a dataflow path to a Finding. */
function dataflowToFinding(file: string, flow: DataflowPath): Finding {
  const { category, severity, ruleId } = classifyFlow(flow);

  return {
    id: findingId(ruleId, file, flow.sink.line),
    rule_id: ruleId,
    category,
    severity,
    title: flowTitle(flow),
    description: flow.description,
    location: {
      file,
      line: flow.sink.line,
      column: flow.sink.column,
      snippet: flow.sink.snippet,
    },
    remediation: flowRemediation(flow),
    analyzer: 'behavioral',
    confidence: 0.8,
    metadata: {
      source_kind: flow.source.kind,
      source_line: flow.source.line,
      sink_kind: flow.sink.kind,
      path: flow.path,
    },
  };
}

/** Classify a dataflow into category + severity based on source/sink types. */
function classifyFlow(flow: DataflowPath): {
  category: ThreatCategory;
  severity: Severity;
  ruleId: string;
} {
  const { source, sink } = flow;

  // Secret/credential to network = exfiltration (critical)
  if (
    (source.kind === 'env' || source.kind === 'credential_file' || source.kind === 'fs_read') &&
    (sink.kind === 'fetch' || sink.kind === 'network_send')
  ) {
    return { category: 'exfiltration', severity: 'critical', ruleId: 'DATAFLOW_EXFIL' };
  }

  // Network response to eval/exec = remote code execution (critical)
  if (
    source.kind === 'network_response' &&
    (sink.kind === 'eval' || sink.kind === 'exec' || sink.kind === 'spawn')
  ) {
    return { category: 'remote_loading', severity: 'critical', ruleId: 'DATAFLOW_RCE' };
  }

  // User input to exec = command injection (high)
  if (
    source.kind === 'user_input' &&
    (sink.kind === 'exec' || sink.kind === 'spawn')
  ) {
    return { category: 'execution', severity: 'high', ruleId: 'DATAFLOW_CMD_INJECT' };
  }

  // Any source to eval = code injection (high)
  if (sink.kind === 'eval') {
    return { category: 'execution', severity: 'high', ruleId: 'DATAFLOW_EVAL' };
  }

  // Default: medium risk, execution category
  return { category: 'execution', severity: 'medium', ruleId: 'DATAFLOW_GENERIC' };
}

function flowTitle(flow: DataflowPath): string {
  const titles: Record<string, string> = {
    DATAFLOW_EXFIL: 'Potential Data Exfiltration',
    DATAFLOW_RCE: 'Remote Code Execution Risk',
    DATAFLOW_CMD_INJECT: 'Command Injection Risk',
    DATAFLOW_EVAL: 'Unsafe Code Evaluation',
    DATAFLOW_GENERIC: 'Suspicious Dataflow',
  };
  const ruleId = classifyFlow(flow).ruleId;
  return titles[ruleId] ?? 'Suspicious Dataflow';
}

function flowRemediation(flow: DataflowPath): string {
  if (flow.sink.kind === 'eval') {
    return 'Avoid eval() and new Function(). Use structured data formats (JSON) instead.';
  }
  if (flow.sink.kind === 'exec' || flow.sink.kind === 'spawn') {
    return 'Validate and sanitize input before passing to command execution.';
  }
  if (flow.sink.kind === 'fetch' || flow.sink.kind === 'network_send') {
    return 'Ensure sensitive data is not sent to untrusted endpoints. Use domain allowlists.';
  }
  return 'Review this dataflow for potential security implications.';
}

/**
 * Generate findings from capability analysis:
 *   - skill has both exec and network = potential C2
 *   - skill reads credentials and has network = potential exfil
 */
function capabilityFindings(
  profile: SecurityProfile,
  fileAnalyses: FileAnalysis[],
): Finding[] {
  const findings: Finding[] = [];

  const caps = profile.capabilities;

  // Has both command execution and network access = potential C2
  if (caps.has('command_execution') && caps.has('network_access')) {
    const execFile = profile.dangerousImports.find(
      (d) => d.module.includes('child_process'),
    );
    if (execFile) {
      findings.push({
        id: findingId('CAPABILITY_C2', execFile.file, execFile.line),
        rule_id: 'CAPABILITY_C2',
        category: 'execution',
        severity: 'high',
        title: 'Command Execution + Network Access',
        description:
          'Skill has both command execution (child_process) and network access capabilities, ' +
          'which could enable command-and-control patterns.',
        location: { file: execFile.file, line: execFile.line },
        remediation:
          'Review whether both capabilities are necessary. ' +
          'Consider restricting network access or command execution.',
        analyzer: 'behavioral',
        confidence: 0.5,
        metadata: { capabilities: Array.from(caps) },
      });
    }
  }

  // Has code evaluation capability
  if (caps.has('code_evaluation')) {
    // Find the file with eval sinks
    for (const fa of fileAnalyses) {
      const evalSink = fa.extraction.sinks.find((s) => s.kind === 'eval');
      if (evalSink) {
        findings.push({
          id: findingId('CAPABILITY_EVAL', fa.file, evalSink.line),
          rule_id: 'CAPABILITY_EVAL',
          category: 'execution',
          severity: 'high',
          title: 'Dynamic Code Evaluation',
          description:
            `File uses ${evalSink.name}() which enables dynamic code execution. ` +
            'This can be exploited for code injection attacks.',
          location: {
            file: fa.file,
            line: evalSink.line,
            column: evalSink.column,
            snippet: evalSink.snippet,
          },
          remediation: 'Replace eval/Function with safer alternatives (JSON.parse, structured APIs).',
          analyzer: 'behavioral',
          confidence: 0.9,
        });
      }
    }
  }

  return findings;
}
