import { spawn } from 'child_process';
import * as crypto from 'crypto';
import type {
  ScanPayload,
  ScanResult,
  ScanEvidence,
  RiskLevel,
  RiskTag,
  ScanRule,
} from '../types/scanner.js';
import type { SkillIdentity } from '../types/skill.js';
import { walkDirectory, isDirectory, pathExists } from './file-walker.js';
import { ALL_RULES } from './rules/index.js';

// Core engine imports
import { ScanOrchestrator } from '../core/scanner.js';
import { RuleRegistry } from '../core/rule-registry.js';
import { defaultPolicy, mergePolicy } from '../core/scan-policy.js';
import { loadConfig } from '../adapters/common.js';

/**
 * Scanner options
 */
export interface ScannerOptions {
  /** Use cisco-ai-defense/skill-scanner if available */
  useExternalScanner?: boolean;
  /** Enable deep analysis */
  deep?: boolean;
  /** Custom rules to add */
  additionalRules?: ScanRule[];
  /** Extra regex pattern strings injected into existing rule modules from config */
  extraPatterns?: Partial<Record<string, string[]>>;
}

/**
 * Skill Scanner - Module A
 * Scans skill code for security risks
 */
export class SkillScanner {
  private options: ScannerOptions;
  private externalScannerAvailable: boolean | null = null;

  // Core engine components
  private orchestrator: ScanOrchestrator;
  private registry: RuleRegistry;

  constructor(options: ScannerOptions = {}) {
    this.options = {
      useExternalScanner: true,
      deep: false,
      ...options,
    };

    // Set up the core analysis engine
    this.registry = new RuleRegistry();

    // Register additional rules if provided
    if (this.options.additionalRules) {
      for (const rule of this.options.additionalRules) {
        this.registry.register(rule);
      }
    }

    // Build scan policy from options
    const policy = mergePolicy(defaultPolicy(), {
      extra_patterns: this.options.extraPatterns ?? {},
      // Enable behavioural analysis when deep mode is on
      analysers: {
        static: true,
        behavioural: !!this.options.deep,
        llm: false, // LLM gated on API key, handled by LLMAnalyser.isEnabled()
      },
    });

    // Load LLM config from config.yaml
    const config = loadConfig();
    const llmCfg = config.llm;

    this.orchestrator = new ScanOrchestrator({
      policy,
      registry: this.registry,
      llmApiKey: llmCfg?.api_key || undefined,
      llmModel: llmCfg?.model || undefined,
      llmMaxInputTokens: llmCfg?.max_input_tokens || undefined,
    });
  }

  /**
   * Check if cisco-ai-defense/skill-scanner is installed
   */
  private async checkExternalScanner(): Promise<boolean> {
    if (this.externalScannerAvailable !== null) {
      return this.externalScannerAvailable;
    }

    return new Promise((resolve) => {
      const proc = spawn('skill-scanner', ['--version'], {
        shell: true,
        stdio: 'pipe',
      });

      proc.on('error', () => {
        this.externalScannerAvailable = false;
        resolve(false);
      });

      proc.on('close', (code) => {
        this.externalScannerAvailable = code === 0;
        resolve(code === 0);
      });
    });
  }

  /**
   * Run external skill-scanner CLI
   */
  private async runExternalScanner(dirPath: string): Promise<ScanResult | null> {
    return new Promise((resolve) => {
      const args = ['scan', dirPath, '--format', 'json'];

      if (this.options.deep) {
        args.push('--use-behavioural');
      }

      const proc = spawn('skill-scanner', args, {
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('error', () => {
        resolve(null);
      });

      proc.on('close', (code) => {
        if (code !== 0 && code !== 1) {
          // code 1 means findings detected
          console.warn('External scanner failed:', stderr);
          resolve(null);
          return;
        }

        try {
          const result = this.parseExternalResult(stdout);
          resolve(result);
        } catch (err) {
          console.warn('Failed to parse external scanner result:', err);
          resolve(null);
        }
      });
    });
  }

  /**
   * Parse external skill-scanner JSON output
   */
  private parseExternalResult(jsonOutput: string): ScanResult {
    // Try to extract JSON from output (may contain non-JSON text)
    const jsonMatch = jsonOutput.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in output');
    }

    const data = JSON.parse(jsonMatch[0]);

    // Map external findings to our format
    const evidence: ScanEvidence[] = [];
    const riskTags: Set<RiskTag> = new Set();

    if (data.findings && Array.isArray(data.findings)) {
      for (const finding of data.findings) {
        // Map finding type to our risk tags
        const tag = this.mapExternalFindingToTag(finding.type || finding.category);
        if (tag) {
          riskTags.add(tag);
          evidence.push({
            tag,
            file: finding.file || finding.location?.file || 'unknown',
            line: finding.line || finding.location?.line || 0,
            match: finding.match || finding.description || '',
            context: finding.context,
          });
        }
      }
    }

    // Determine risk level
    const riskLevel = this.calculateRiskLevel(Array.from(riskTags));

    return {
      risk_level: riskLevel,
      risk_tags: Array.from(riskTags),
      evidence,
      summary: data.summary || `Found ${evidence.length} security findings`,
      metadata: {
        files_scanned: data.files_scanned || 0,
        scan_duration_ms: data.duration_ms || 0,
        scan_time: new Date().toISOString(),
      },
    };
  }

  /**
   * Map external finding type to our risk tags
   */
  private mapExternalFindingToTag(externalType: string): RiskTag | null {
    const mapping: Record<string, RiskTag> = {
      'command-injection': 'SHELL_EXEC',
      'code-execution': 'SHELL_EXEC',
      'remote-code-loading': 'REMOTE_LOADER',
      'dynamic-import': 'REMOTE_LOADER',
      'env-access': 'READ_ENV_SECRETS',
      'secret-access': 'READ_ENV_SECRETS',
      'ssh-key-access': 'READ_SSH_KEYS',
      'credential-access': 'READ_KEYCHAIN',
      'data-exfiltration': 'NET_EXFIL_UNRESTRICTED',
      'webhook-exfil': 'WEBHOOK_EXFIL',
      'obfuscation': 'OBFUSCATION',
      'prompt-injection': 'PROMPT_INJECTION',
      'private-key': 'PRIVATE_KEY_PATTERN',
    };

    return mapping[externalType?.toLowerCase()] || null;
  }

  /**
   * Calculate risk level from tags (legacy helper — delegates to core model)
   */
  private calculateRiskLevel(tags: RiskTag[]): RiskLevel {
    const allRules = [...ALL_RULES, ...(this.options.additionalRules || [])];

    for (const tag of tags) {
      const rule = allRules.find((r) => r.id === tag);
      if (rule?.severity === 'critical') return 'critical';
    }

    for (const tag of tags) {
      const rule = allRules.find((r) => r.id === tag);
      if (rule?.severity === 'high') return 'high';
    }

    for (const tag of tags) {
      const rule = allRules.find((r) => r.id === tag);
      if (rule?.severity === 'medium') return 'medium';
    }

    return 'low';
  }

  /**
   * Run built-in scanner — delegates to ScanOrchestrator
   */
  private async runBuiltinScanner(dirPath: string): Promise<ScanResult> {
    const files = await walkDirectory(dirPath);
    const result = await this.orchestrator.run(dirPath, files);

    // Return as base ScanResult for backward compatibility
    return {
      risk_level: result.risk_level,
      risk_tags: result.risk_tags,
      evidence: result.evidence,
      summary: result.summary,
      metadata: {
        files_scanned: result.metadata.files_scanned,
        scan_duration_ms: result.metadata.scan_duration_ms,
        scan_time: result.metadata.scan_time,
      },
    };
  }

  /**
   * Calculate artifact hash for a directory
   */
  async calculateArtifactHash(dirPath: string): Promise<string> {
    const files = await walkDirectory(dirPath);
    const hash = crypto.createHash('sha256');

    // Sort files for consistent hashing
    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    for (const file of files) {
      hash.update(file.relativePath);
      hash.update(file.content);
    }

    return `sha256:${hash.digest('hex')}`;
  }

  /**
   * Main scan method
   */
  async scan(payload: ScanPayload): Promise<ScanResult> {
    const { skill, payload: scanPayload, options } = payload;

    // Validate payload
    if (scanPayload.type !== 'dir') {
      // For now, only support directory scanning
      // TODO: Support zip and repo_url
      throw new Error(`Unsupported payload type: ${scanPayload.type}. Only 'dir' is supported.`);
    }

    const dirPath = scanPayload.ref.replace('file://', '');

    // Check if directory exists
    if (!(await pathExists(dirPath))) {
      throw new Error(`Directory not found: ${dirPath}`);
    }

    if (!(await isDirectory(dirPath))) {
      throw new Error(`Path is not a directory: ${dirPath}`);
    }

    // Try external scanner first if enabled
    if (this.options.useExternalScanner) {
      const externalAvailable = await this.checkExternalScanner();

      if (externalAvailable) {
        const externalResult = await this.runExternalScanner(dirPath);
        if (externalResult) {
          return externalResult;
        }
      }
    }

    // Fall back to built-in scanner
    return this.runBuiltinScanner(dirPath);
  }

  /**
   * Quick scan - scan and return basic info
   */
  async quickScan(dirPath: string): Promise<{
    risk_level: RiskLevel;
    risk_tags: RiskTag[];
    summary: string;
  }> {
    const hash = await this.calculateArtifactHash(dirPath);
    const skill: SkillIdentity = {
      id: 'unknown',
      source: dirPath,
      version_ref: 'unknown',
      artifact_hash: hash,
    };

    const result = await this.scan({
      skill,
      payload: { type: 'dir', ref: dirPath },
    });

    return {
      risk_level: result.risk_level,
      risk_tags: result.risk_tags,
      summary: result.summary,
    };
  }
}

// Export singleton instance
export const scanner = new SkillScanner();
