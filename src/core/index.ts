/**
 * Core analysis engine — barrel export.
 */

// Models
export {
  type Severity,
  type ThreatCategory,
  type AnalyzerName,
  type Finding,
  type FindingLocation,
  type ScanMetadata,
  type ExtendedScanResult,
  SEVERITY_WEIGHT,
  findingId,
  severityToRiskLevel,
  aggregateRiskLevel,
  riskTagToCategory,
  findingsToLegacy,
  sortFindings,
  generateSummary,
} from './models.js';

// Base analyzer
export {
  BaseAnalyzer,
  type AnalysisContext,
} from './analyzers/base.js';

// Concrete analyzers
export { StaticAnalyzer } from './analyzers/static/index.js';
export { BehavioralAnalyzer } from './analyzers/behavioral/index.js';
export { LLMAnalyzer } from './analyzers/llm/index.js';

// Scan policy
export {
  type ScanPolicy,
  type AnalyzerFlags,
  type RuleScoping,
  type SeverityOverride,
  POLICY_PRESETS,
  defaultPolicy,
  policyFromPreset,
  mergePolicy,
} from './scan-policy.js';

// Rule registry
export {
  RuleRegistry,
  ruleRegistry,
  type RuleMetadata,
} from './rule-registry.js';

// Orchestrator
export {
  ScanOrchestrator,
  type OrchestratorOptions,
} from './scanner.js';

// Analyzer factory
export {
  createAnalyzers,
  type AnalyzerFactoryOptions,
} from './analyzer-factory.js';

// Deduplication
export { deduplicateFindings } from './deduplicator.js';

// Scan cache
export { ScanCache, type ScanCacheEntry } from './scan-cache.js';

// File classification
export {
  classifyFile,
  isASTAnalyzable,
  groupByCategory,
  type FileCategory,
} from './file-classifier.js';
