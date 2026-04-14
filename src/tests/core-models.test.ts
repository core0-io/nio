import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findingId,
  severityToRiskLevel,
  aggregateRiskLevel,
  riskTagToCategory,
  findingsToLegacy,
  sortFindings,
  generateSummary,
  SEVERITY_WEIGHT,
} from '../core/models.js';
import type { Finding } from '../core/models.js';

// ── Test helpers ─────────────────────────────────────────────────────────

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'test-id',
    rule_id: 'SHELL_EXEC',
    category: 'execution',
    severity: 'high',
    title: 'Test Finding',
    description: 'Test description',
    location: { file: 'test.ts', line: 1 },
    analyser: 'static',
    confidence: 1.0,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('Core Models', () => {
  describe('findingId', () => {
    it('should generate deterministic IDs', () => {
      const id1 = findingId('SHELL_EXEC', 'test.ts', 10);
      const id2 = findingId('SHELL_EXEC', 'test.ts', 10);
      assert.equal(id1, id2);
    });

    it('should generate different IDs for different inputs', () => {
      const id1 = findingId('SHELL_EXEC', 'test.ts', 10);
      const id2 = findingId('SHELL_EXEC', 'test.ts', 11);
      assert.notEqual(id1, id2);
    });

    it('should return 16-char hex string', () => {
      const id = findingId('SHELL_EXEC', 'test.ts', 1);
      assert.equal(id.length, 16);
      assert.match(id, /^[0-9a-f]{16}$/);
    });
  });

  describe('severityToRiskLevel', () => {
    it('should map info to low', () => {
      assert.equal(severityToRiskLevel('info'), 'low');
    });

    it('should map low to low', () => {
      assert.equal(severityToRiskLevel('low'), 'low');
    });

    it('should map medium to medium', () => {
      assert.equal(severityToRiskLevel('medium'), 'medium');
    });

    it('should map high to high', () => {
      assert.equal(severityToRiskLevel('high'), 'high');
    });

    it('should map critical to critical', () => {
      assert.equal(severityToRiskLevel('critical'), 'critical');
    });
  });

  describe('aggregateRiskLevel', () => {
    it('should return low for no findings', () => {
      assert.equal(aggregateRiskLevel([]), 'low');
    });

    it('should return the highest severity', () => {
      const findings = [
        makeFinding({ severity: 'low' }),
        makeFinding({ severity: 'high' }),
        makeFinding({ severity: 'medium' }),
      ];
      assert.equal(aggregateRiskLevel(findings), 'high');
    });

    it('should return critical when any finding is critical', () => {
      const findings = [
        makeFinding({ severity: 'low' }),
        makeFinding({ severity: 'critical' }),
      ];
      assert.equal(aggregateRiskLevel(findings), 'critical');
    });
  });

  describe('riskTagToCategory', () => {
    it('should map SHELL_EXEC to execution', () => {
      assert.equal(riskTagToCategory('SHELL_EXEC'), 'execution');
    });

    it('should map WEBHOOK_EXFIL to exfiltration', () => {
      assert.equal(riskTagToCategory('WEBHOOK_EXFIL'), 'exfiltration');
    });

    it('should map PROMPT_INJECTION to injection', () => {
      assert.equal(riskTagToCategory('PROMPT_INJECTION'), 'injection');
    });

    it('should map AUTO_UPDATE to supply_chain', () => {
      assert.equal(riskTagToCategory('AUTO_UPDATE'), 'supply_chain');
    });

    it('should map READ_ENV_SECRETS to secrets', () => {
      assert.equal(riskTagToCategory('READ_ENV_SECRETS'), 'secrets');
    });

    it('should map TROJAN_DISTRIBUTION to trojan', () => {
      assert.equal(riskTagToCategory('TROJAN_DISTRIBUTION'), 'trojan');
    });
  });

  describe('findingsToLegacy', () => {
    it('should convert findings to risk_tags and evidence', () => {
      const findings = [
        makeFinding({ rule_id: 'SHELL_EXEC', location: { file: 'a.ts', line: 1, snippet: 'exec()' } }),
        makeFinding({ rule_id: 'WEBHOOK_EXFIL', location: { file: 'b.ts', line: 5, snippet: 'discord.com' } }),
      ];
      const { risk_tags, evidence } = findingsToLegacy(findings);

      assert.deepEqual(risk_tags, ['SHELL_EXEC', 'WEBHOOK_EXFIL']);
      assert.equal(evidence.length, 2);
      assert.equal(evidence[0].tag, 'SHELL_EXEC');
      assert.equal(evidence[0].file, 'a.ts');
      assert.equal(evidence[0].line, 1);
    });

    it('should deduplicate tags', () => {
      const findings = [
        makeFinding({ rule_id: 'SHELL_EXEC' }),
        makeFinding({ rule_id: 'SHELL_EXEC' }),
      ];
      const { risk_tags } = findingsToLegacy(findings);
      assert.equal(risk_tags.length, 1);
    });

    it('should handle empty findings', () => {
      const { risk_tags, evidence } = findingsToLegacy([]);
      assert.equal(risk_tags.length, 0);
      assert.equal(evidence.length, 0);
    });
  });

  describe('sortFindings', () => {
    it('should sort critical first', () => {
      const findings = [
        makeFinding({ severity: 'low', location: { file: 'a.ts', line: 1 } }),
        makeFinding({ severity: 'critical', location: { file: 'b.ts', line: 1 } }),
        makeFinding({ severity: 'high', location: { file: 'c.ts', line: 1 } }),
      ];
      const sorted = sortFindings(findings);
      assert.equal(sorted[0].severity, 'critical');
      assert.equal(sorted[1].severity, 'high');
      assert.equal(sorted[2].severity, 'low');
    });

    it('should sort by file then line within same severity', () => {
      const findings = [
        makeFinding({ severity: 'high', location: { file: 'b.ts', line: 10 } }),
        makeFinding({ severity: 'high', location: { file: 'a.ts', line: 5 } }),
        makeFinding({ severity: 'high', location: { file: 'a.ts', line: 1 } }),
      ];
      const sorted = sortFindings(findings);
      assert.equal(sorted[0].location.file, 'a.ts');
      assert.equal(sorted[0].location.line, 1);
      assert.equal(sorted[1].location.file, 'a.ts');
      assert.equal(sorted[1].location.line, 5);
      assert.equal(sorted[2].location.file, 'b.ts');
    });

    it('should not mutate the original array', () => {
      const findings = [
        makeFinding({ severity: 'low' }),
        makeFinding({ severity: 'critical' }),
      ];
      const sorted = sortFindings(findings);
      assert.equal(findings[0].severity, 'low');
      assert.equal(sorted[0].severity, 'critical');
    });
  });

  describe('generateSummary', () => {
    it('should report no issues for empty findings', () => {
      assert.equal(generateSummary([]), 'No security issues detected');
    });

    it('should mention code execution capabilities', () => {
      const findings = [makeFinding({ category: 'execution' })];
      const summary = generateSummary(findings);
      assert.ok(summary.includes('code execution'));
    });

    it('should mention multiple categories', () => {
      const findings = [
        makeFinding({ category: 'execution' }),
        makeFinding({ category: 'exfiltration' }),
        makeFinding({ category: 'injection' }),
      ];
      const summary = generateSummary(findings);
      assert.ok(summary.includes('code execution'));
      assert.ok(summary.includes('exfiltration'));
      assert.ok(summary.includes('prompt injection'));
    });

    it('should include finding count', () => {
      const findings = [makeFinding(), makeFinding(), makeFinding()];
      const summary = generateSummary(findings);
      assert.ok(summary.includes('3 findings'));
    });
  });

  describe('SEVERITY_WEIGHT', () => {
    it('should have correct ordering', () => {
      assert.ok(SEVERITY_WEIGHT.info < SEVERITY_WEIGHT.low);
      assert.ok(SEVERITY_WEIGHT.low < SEVERITY_WEIGHT.medium);
      assert.ok(SEVERITY_WEIGHT.medium < SEVERITY_WEIGHT.high);
      assert.ok(SEVERITY_WEIGHT.high < SEVERITY_WEIGHT.critical);
    });
  });
});
