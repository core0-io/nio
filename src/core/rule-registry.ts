// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Central rule catalog.
 *
 * Wraps the existing `ALL_RULES` array and enriches each rule with metadata
 * (category, remediation guidance).  Also supports dynamic registration of
 * rules loaded from YAML packs or user config at startup.
 */

import type { ScanRule, RiskTag, RiskLevel } from '../types/scanner.js';
import type { ThreatCategory, Severity } from './models.js';
import { riskTagToCategory } from './models.js';
import { ALL_RULES, RULE_TO_MODULE } from '../scanner/rules/index.js';
import { compileUserRegexList } from './shared/regex.js';

// ── Rule metadata ────────────────────────────────────────────────────────

export interface RuleMetadata {
  /** Rule identifier. */
  id: string;
  /** Human-readable title. */
  title: string;
  /** Longer description. */
  description: string;
  /** Threat category. */
  category: ThreatCategory;
  /** Default severity. */
  severity: Severity;
  /** Suggested remediation. */
  remediation?: string;
  /** Which module contributed this rule (e.g. "shell_exec"). */
  module?: string;
}

// ── Metadata for built-in rules ──────────────────────────────────────────

const BUILTIN_META: Record<string, Partial<RuleMetadata>> = {
  SHELL_EXEC: {
    title: 'Command Execution',
    remediation: 'Remove or sandbox shell execution. Use an allowlisted set of commands.',
  },
  AUTO_UPDATE: {
    title: 'Auto-Update / Download-and-Execute',
    remediation: 'Remove auto-update mechanisms. Use signed package updates instead.',
  },
  REMOTE_LOADER: {
    title: 'Remote Code Loading',
    remediation: 'Use static imports. Pin dependencies by hash or version.',
  },
  READ_ENV_SECRETS: {
    title: 'Environment Secret Access',
    remediation: 'Declare required env vars in the manifest instead of reading them directly.',
  },
  READ_SSH_KEYS: {
    title: 'SSH Key Access',
    remediation: 'Remove direct SSH key reads. Use an SSH agent or deployment keys.',
  },
  READ_KEYCHAIN: {
    title: 'Keychain / Credential Store Access',
    remediation: 'Do not access OS credential stores directly.',
  },
  PRIVATE_KEY_PATTERN: {
    title: 'Hard-coded Private Key',
    remediation: 'Remove hard-coded keys. Use a secret manager.',
  },
  NET_EXFIL_UNRESTRICTED: {
    title: 'Unrestricted Network Exfiltration',
    remediation: 'Restrict outbound requests to declared domains.',
  },
  WEBHOOK_EXFIL: {
    title: 'Webhook Exfiltration',
    remediation: 'Remove undeclared webhook URLs.',
  },
  OBFUSCATION: {
    title: 'Code Obfuscation',
    remediation: 'Replace obfuscated code with readable equivalents.',
  },
  PROMPT_INJECTION: {
    title: 'Prompt Injection',
    remediation: 'Remove prompt override language from skill instructions.',
  },
  TROJAN_DISTRIBUTION: {
    title: 'Trojan Distribution Pattern',
    remediation: 'Remove binary download-and-execute patterns.',
  },
  SUSPICIOUS_PASTE_URL: {
    title: 'Suspicious Paste URL',
    remediation: 'Replace paste-bin URLs with versioned, auditable sources.',
  },
  SUSPICIOUS_IP: {
    title: 'Hard-coded IP Address',
    remediation: 'Use DNS names or configuration for external hosts.',
  },
  SOCIAL_ENGINEERING: {
    title: 'Social Engineering Language',
    remediation: 'Remove urgency / pressure language directing users to run commands.',
  },
  DESTRUCTIVE_FS: {
    title: 'Destructive Filesystem Operation',
    remediation:
      'Avoid recursive deletes on agent-chosen paths. Prefer removing specific ' +
      'named files; require explicit human approval for directory trees.',
  },
};

// ── Rule Registry ────────────────────────────────────────────────────────

export class RuleRegistry {
  private rules = new Map<string, ScanRule>();
  private meta = new Map<string, RuleMetadata>();

  constructor() {
    // Register all built-in rules
    for (const rule of ALL_RULES) {
      this.register(rule);
    }
  }

  /** Register a single rule, building metadata from the rule + overrides. */
  register(rule: ScanRule): void {
    this.rules.set(rule.id, rule);

    const override = BUILTIN_META[rule.id];
    this.meta.set(rule.id, {
      id: rule.id,
      title: override?.title ?? rule.description,
      description: rule.description,
      category: riskTagToCategory(rule.id),
      severity: rule.severity as Severity,
      remediation: override?.remediation,
      module: RULE_TO_MODULE[rule.id],
    });
  }

  /** Get the raw scan rule by ID. */
  getRule(id: string): ScanRule | undefined {
    return this.rules.get(id);
  }

  /** Get enriched metadata for a rule. */
  getMeta(id: string): RuleMetadata | undefined {
    return this.meta.get(id);
  }

  /** All registered rules. */
  allRules(): ScanRule[] {
    return Array.from(this.rules.values());
  }

  /** All metadata entries. */
  allMeta(): RuleMetadata[] {
    return Array.from(this.meta.values());
  }

  /** Number of registered rules. */
  get size(): number {
    return this.rules.size;
  }

  /**
   * Return rules applicable to a given file extension, with optional
   * extra patterns injected from config.
   */
  getRulesForExtension(
    extension: string,
    extraPatterns?: Partial<Record<string, string[]>>,
  ): ScanRule[] {
    const matching = this.allRules().filter((rule) =>
      rule.file_patterns.some((pattern) => {
        if (pattern === '*') return true;
        if (pattern.startsWith('*.')) return extension === pattern.slice(1);
        return false;
      }),
    );

    if (!extraPatterns || Object.keys(extraPatterns).length === 0) {
      return matching;
    }

    // Inject extra patterns from config
    return matching.map((rule) => {
      const moduleKey = RULE_TO_MODULE[rule.id];
      if (!moduleKey) return rule;
      const strs = extraPatterns[moduleKey];
      if (!strs || strs.length === 0) return rule;

      const compiled = compileUserRegexList(strs);
      if (compiled.length === 0) return rule;
      return { ...rule, patterns: [...rule.patterns, ...compiled] };
    });
  }
}

/** Shared singleton instance. */
export const ruleRegistry = new RuleRegistry();
