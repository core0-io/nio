import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultPolicy,
  policyFromPreset,
  mergePolicy,
  POLICY_PRESETS,
} from '../core/scan-policy.js';

describe('ScanPolicy', () => {
  describe('defaultPolicy', () => {
    it('should return balanced preset', () => {
      const policy = defaultPolicy();
      assert.equal(policy.analyzers.static, true);
      assert.equal(policy.analyzers.behavioral, true);
      assert.equal(policy.analyzers.llm, false);
      assert.equal(policy.min_severity, 'low');
    });
  });

  describe('policyFromPreset', () => {
    it('should load strict preset', () => {
      const policy = policyFromPreset('strict');
      assert.equal(policy.analyzers.llm, true);
      assert.equal(policy.min_severity, 'info');
    });

    it('should load permissive preset', () => {
      const policy = policyFromPreset('permissive');
      assert.equal(policy.analyzers.behavioral, false);
      assert.equal(policy.analyzers.llm, false);
      assert.equal(policy.min_severity, 'medium');
    });

    it('should fallback to balanced for unknown preset', () => {
      const policy = policyFromPreset('unknown');
      assert.deepEqual(policy.analyzers, defaultPolicy().analyzers);
    });
  });

  describe('mergePolicy', () => {
    it('should override analyzers', () => {
      const merged = mergePolicy(defaultPolicy(), {
        analyzers: { static: true, behavioral: false, llm: true },
      });
      assert.equal(merged.analyzers.behavioral, false);
      assert.equal(merged.analyzers.llm, true);
    });

    it('should override min_severity', () => {
      const merged = mergePolicy(defaultPolicy(), {
        min_severity: 'critical',
      });
      assert.equal(merged.min_severity, 'critical');
    });

    it('should merge disabled_rules', () => {
      const base = mergePolicy(defaultPolicy(), {
        rules: { disabled_rules: ['RULE_A'], severity_overrides: [] },
      });
      const merged = mergePolicy(base, {
        rules: { disabled_rules: ['RULE_B'], severity_overrides: [] },
      });
      assert.ok(merged.rules.disabled_rules.includes('RULE_A'));
      assert.ok(merged.rules.disabled_rules.includes('RULE_B'));
    });

    it('should merge extra_patterns', () => {
      const merged = mergePolicy(defaultPolicy(), {
        extra_patterns: { shell_exec: ['custom_pattern'] },
      });
      assert.ok(merged.extra_patterns.shell_exec);
      assert.equal(merged.extra_patterns.shell_exec![0], 'custom_pattern');
    });

    it('should keep base values for undefined overrides', () => {
      const merged = mergePolicy(defaultPolicy(), {});
      assert.deepEqual(merged, defaultPolicy());
    });
  });

  describe('POLICY_PRESETS', () => {
    it('should have 3 presets', () => {
      assert.equal(Object.keys(POLICY_PRESETS).length, 3);
      assert.ok('strict' in POLICY_PRESETS);
      assert.ok('balanced' in POLICY_PRESETS);
      assert.ok('permissive' in POLICY_PRESETS);
    });
  });
});
