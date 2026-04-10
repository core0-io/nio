import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RuleRegistry, ruleRegistry } from '../core/rule-registry.js';
import { ALL_RULES } from '../scanner/rules/index.js';

describe('RuleRegistry', () => {
  describe('singleton', () => {
    it('should contain all 15 built-in rules', () => {
      assert.equal(ruleRegistry.size, 15);
    });

    it('should have metadata for every rule', () => {
      for (const rule of ALL_RULES) {
        const meta = ruleRegistry.getMeta(rule.id);
        assert.ok(meta, `Metadata should exist for ${rule.id}`);
        assert.ok(meta.title, `${rule.id} should have a title`);
        assert.ok(meta.category, `${rule.id} should have a category`);
        assert.ok(meta.severity, `${rule.id} should have a severity`);
        assert.ok(meta.description, `${rule.id} should have a description`);
      }
    });
  });

  describe('getRule', () => {
    it('should return a rule by ID', () => {
      const rule = ruleRegistry.getRule('SHELL_EXEC');
      assert.ok(rule);
      assert.equal(rule.id, 'SHELL_EXEC');
      assert.ok(rule.patterns.length > 0);
    });

    it('should return undefined for unknown ID', () => {
      assert.equal(ruleRegistry.getRule('NONEXISTENT'), undefined);
    });
  });

  describe('getMeta', () => {
    it('should have remediation guidance for key rules', () => {
      const keyRules = ['SHELL_EXEC', 'REMOTE_LOADER', 'PROMPT_INJECTION', 'PRIVATE_KEY_PATTERN'];
      for (const id of keyRules) {
        const meta = ruleRegistry.getMeta(id);
        assert.ok(meta, `${id} should have metadata`);
        assert.ok(meta.remediation, `${id} should have remediation guidance`);
      }
    });

    it('should have correct categories', () => {
      assert.equal(ruleRegistry.getMeta('SHELL_EXEC')?.category, 'execution');
      assert.equal(ruleRegistry.getMeta('WEBHOOK_EXFIL')?.category, 'exfiltration');
      assert.equal(ruleRegistry.getMeta('PROMPT_INJECTION')?.category, 'injection');
      assert.equal(ruleRegistry.getMeta('READ_ENV_SECRETS')?.category, 'secrets');
    });
  });

  describe('getRulesForExtension', () => {
    it('should return rules for .ts files', () => {
      const rules = ruleRegistry.getRulesForExtension('.ts');
      assert.ok(rules.length > 0);
      assert.ok(rules.some((r) => r.id === 'SHELL_EXEC'));
    });

    it('should return universal rules for any extension', () => {
      const rules = ruleRegistry.getRulesForExtension('.sol');
      assert.ok(rules.length > 0);
      // Universal rules (file_patterns: ['*'])
      assert.ok(rules.some((r) => r.file_patterns.includes('*')));
    });

    it('should inject extra patterns when provided', () => {
      const rules = ruleRegistry.getRulesForExtension('.ts', {
        shell_exec: ['custom_pattern_\\d+'],
      });
      const shellExec = rules.find((r) => r.id === 'SHELL_EXEC');
      assert.ok(shellExec);
      // Should have more patterns than the original
      const originalRule = ruleRegistry.getRule('SHELL_EXEC')!;
      assert.ok(shellExec.patterns.length > originalRule.patterns.length);
    });

    it('should skip invalid extra patterns silently', () => {
      const rules = ruleRegistry.getRulesForExtension('.ts', {
        shell_exec: ['[invalid-regex'],
      });
      const shellExec = rules.find((r) => r.id === 'SHELL_EXEC');
      assert.ok(shellExec);
      // Should have same number of patterns as original (invalid one skipped)
      const originalRule = ruleRegistry.getRule('SHELL_EXEC')!;
      assert.equal(shellExec.patterns.length, originalRule.patterns.length);
    });
  });

  describe('register', () => {
    it('should support adding custom rules', () => {
      const registry = new RuleRegistry();
      const initialSize = registry.size;

      registry.register({
        id: 'CUSTOM_RULE' as any,
        description: 'Custom test rule',
        severity: 'medium',
        file_patterns: ['*.ts'],
        patterns: [/custom_pattern/],
      });

      assert.equal(registry.size, initialSize + 1);
      assert.ok(registry.getRule('CUSTOM_RULE'));
      assert.ok(registry.getMeta('CUSTOM_RULE'));
    });
  });
});
