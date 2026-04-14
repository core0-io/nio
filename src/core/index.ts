/**
 * Core analysis engine — barrel export.
 */

// Models
export {
  type Severity,
  type ThreatCategory,
  type AnalyserName,
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

// Base analyser
export {
  BaseAnalyser,
  type AnalysisContext,
} from './analysers/base.js';

// Concrete analysers
export { StaticAnalyser } from './analysers/static/index.js';
export { BehaviouralAnalyser } from './analysers/behavioural/index.js';
export { LLMAnalyser } from './analysers/llm/index.js';

// Scan policy
export {
  type ScanPolicy,
  type AnalyserFlags,
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

// Analyser factory
export {
  createAnalysers,
  type AnalyserFactoryOptions,
} from './analyser-factory.js';

// Deduplication
export { deduplicateFindings } from './deduplicator.js';

// Scan cache
export { ScanCache, type ScanCacheEntry } from './scan-cache.js';

// File classification
export {
  classifyFile,
  isASTAnalysable,
  groupByCategory,
  type FileCategory,
} from './file-classifier.js';
