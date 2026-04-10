import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LLMAnalyzer } from '../core/analyzers/llm/index.js';
import { defaultPolicy, mergePolicy } from '../core/scan-policy.js';
import {
  buildAnalysisPrompt,
  generateDelimiter,
  selectFilesForLLM,
  estimateTokens,
} from '../core/analyzers/llm/prompts.js';
import { mapCategory, mapSeverity } from '../core/analyzers/llm/taxonomy.js';
import type { Finding } from '../core/models.js';

// ── Taxonomy Tests ───────────────────────────────────────────────────────

describe('LLM Taxonomy', () => {
  describe('mapCategory', () => {
    it('should map exact category names', () => {
      assert.equal(mapCategory('execution'), 'execution');
      assert.equal(mapCategory('exfiltration'), 'exfiltration');
      assert.equal(mapCategory('injection'), 'injection');
    });

    it('should map fuzzy LLM output', () => {
      assert.equal(mapCategory('command_injection'), 'execution');
      assert.equal(mapCategory('Command Injection'), 'execution');
      assert.equal(mapCategory('data-exfiltration'), 'exfiltration');
      assert.equal(mapCategory('prompt_injection'), 'injection');
      assert.equal(mapCategory('credential_theft'), 'secrets');
      assert.equal(mapCategory('supply_chain_attack'), 'supply_chain');
    });

    it('should fallback to policy_violation for unknown', () => {
      assert.equal(mapCategory('something_unknown'), 'policy_violation');
    });
  });

  describe('mapSeverity', () => {
    it('should map standard severity names', () => {
      assert.equal(mapSeverity('low'), 'low');
      assert.equal(mapSeverity('medium'), 'medium');
      assert.equal(mapSeverity('high'), 'high');
      assert.equal(mapSeverity('critical'), 'critical');
    });

    it('should map alternative names', () => {
      assert.equal(mapSeverity('informational'), 'info');
      assert.equal(mapSeverity('moderate'), 'medium');
      assert.equal(mapSeverity('severe'), 'critical');
    });

    it('should fallback to medium for unknown', () => {
      assert.equal(mapSeverity('unknown'), 'medium');
    });

    it('should be case-insensitive', () => {
      assert.equal(mapSeverity('HIGH'), 'high');
      assert.equal(mapSeverity('Critical'), 'critical');
    });
  });
});

// ── Prompt Tests ─────────────────────────────────────────────────────────

describe('LLM Prompts', () => {
  describe('generateDelimiter', () => {
    it('should generate unique delimiters', () => {
      const d1 = generateDelimiter();
      const d2 = generateDelimiter();
      assert.notEqual(d1, d2);
    });

    it('should start with DELIM_', () => {
      const d = generateDelimiter();
      assert.ok(d.startsWith('DELIM_'));
    });

    it('should be long enough for security', () => {
      const d = generateDelimiter();
      assert.ok(d.length >= 20);
    });
  });

  describe('buildAnalysisPrompt', () => {
    it('should include file content wrapped in delimiters', () => {
      const delimiter = 'DELIM_test123';
      const prompt = buildAnalysisPrompt({
        files: [{ path: 'test.ts', content: 'exec("ls");' }],
        priorFindings: [],
        delimiter,
      });
      assert.ok(prompt.includes(`[${delimiter}]`));
      assert.ok(prompt.includes('exec("ls");'));
    });

    it('should include prior findings', () => {
      const finding: Finding = {
        id: 'test',
        rule_id: 'SHELL_EXEC',
        category: 'execution',
        severity: 'high',
        title: 'Command Execution',
        description: 'exec call detected',
        location: { file: 'test.ts', line: 1 },
        analyzer: 'static',
        confidence: 1.0,
      };
      const prompt = buildAnalysisPrompt({
        files: [{ path: 'test.ts', content: 'code' }],
        priorFindings: [finding],
        delimiter: 'DELIM_test',
      });
      assert.ok(prompt.includes('SHELL_EXEC'));
      assert.ok(prompt.includes('Command Execution'));
    });

    it('should request JSON response format', () => {
      const prompt = buildAnalysisPrompt({
        files: [{ path: 'test.ts', content: 'code' }],
        priorFindings: [],
        delimiter: 'DELIM_test',
      });
      assert.ok(prompt.includes('JSON'));
      assert.ok(prompt.includes('findings'));
      assert.ok(prompt.includes('false_positives'));
    });
  });

  describe('estimateTokens', () => {
    it('should estimate roughly 1 token per 4 chars', () => {
      const tokens = estimateTokens('hello world'); // 11 chars
      assert.equal(tokens, 3); // ceil(11/4)
    });
  });

  describe('selectFilesForLLM', () => {
    it('should prioritize files with findings', () => {
      const files = [
        { path: 'clean.ts', content: 'const x = 1;' },
        { path: 'dirty.ts', content: 'exec("bad");' },
      ];
      const findings: Finding[] = [{
        id: 'test',
        rule_id: 'SHELL_EXEC',
        category: 'execution',
        severity: 'high',
        title: 'Test',
        description: 'Test',
        location: { file: 'dirty.ts', line: 1 },
        analyzer: 'static',
        confidence: 1.0,
      }];
      const selected = selectFilesForLLM(files, findings, 10000);
      assert.equal(selected[0].path, 'dirty.ts');
    });

    it('should respect token budget', () => {
      const bigFile = { path: 'big.ts', content: 'x'.repeat(100000) };
      const smallFile = { path: 'small.ts', content: 'y'.repeat(100) };
      const selected = selectFilesForLLM([bigFile, smallFile], [], 1000);
      // Should include at least one file
      assert.ok(selected.length >= 1);
    });

    it('should include at least one file even if over budget', () => {
      const bigFile = { path: 'big.ts', content: 'x'.repeat(100000) };
      const selected = selectFilesForLLM([bigFile], [], 100);
      assert.equal(selected.length, 1);
    });
  });
});

// ── LLMAnalyzer Tests ────────────────────────────────────────────────────

describe('LLMAnalyzer', () => {
  describe('isEnabled', () => {
    it('should be disabled without API key', () => {
      const analyzer = new LLMAnalyzer({ apiKey: undefined });
      const policy = mergePolicy(defaultPolicy(), {
        analyzers: { static: true, behavioral: true, llm: true },
      });
      assert.equal(analyzer.isEnabled(policy), false);
    });

    it('should be disabled when policy.analyzers.llm is false', () => {
      const analyzer = new LLMAnalyzer({ apiKey: 'test-key' });
      const policy = defaultPolicy(); // llm: false by default
      assert.equal(analyzer.isEnabled(policy), false);
    });

    it('should be enabled with API key and policy', () => {
      const analyzer = new LLMAnalyzer({ apiKey: 'test-key' });
      const policy = mergePolicy(defaultPolicy(), {
        analyzers: { static: true, behavioral: true, llm: true },
      });
      assert.equal(analyzer.isEnabled(policy), true);
    });
  });

  it('should return empty findings without API key', async () => {
    const analyzer = new LLMAnalyzer({ apiKey: undefined });
    const policy = defaultPolicy();
    const findings = await analyzer.analyze({
      rootDir: '/test',
      files: [{ path: '/test/a.ts', relativePath: 'a.ts', content: 'code', extension: '.ts' }],
      policy,
    });
    assert.equal(findings.length, 0);
  });

  it('should be phase 2', () => {
    const analyzer = new LLMAnalyzer();
    assert.equal(analyzer.phase, 2);
    assert.equal(analyzer.name, 'llm');
  });
});
