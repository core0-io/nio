import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deduplicateFindings } from '../core/deduplicator.js';
import type { Finding } from '../core/models.js';

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'test-id',
    rule_id: 'SHELL_EXEC',
    category: 'execution',
    severity: 'high',
    title: 'Test',
    description: 'Test',
    location: { file: 'test.ts', line: 10 },
    analyser: 'static',
    confidence: 1.0,
    ...overrides,
  };
}

describe('Deduplicator', () => {
  it('should return empty for empty input', () => {
    assert.deepEqual(deduplicateFindings([]), []);
  });

  it('should return single finding unchanged', () => {
    const findings = [makeFinding()];
    assert.equal(deduplicateFindings(findings).length, 1);
  });

  it('should deduplicate exact same rule+file+line', () => {
    const findings = [
      makeFinding({ location: { file: 'a.ts', line: 10 } }),
      makeFinding({ location: { file: 'a.ts', line: 10 } }),
    ];
    assert.equal(deduplicateFindings(findings).length, 1);
  });

  it('should deduplicate near-duplicate lines (within tolerance)', () => {
    const findings = [
      makeFinding({ location: { file: 'a.ts', line: 10 } }),
      makeFinding({ location: { file: 'a.ts', line: 12 } }),
    ];
    assert.equal(deduplicateFindings(findings, 3).length, 1);
  });

  it('should keep findings beyond tolerance', () => {
    const findings = [
      makeFinding({ location: { file: 'a.ts', line: 10 } }),
      makeFinding({ location: { file: 'a.ts', line: 20 } }),
    ];
    assert.equal(deduplicateFindings(findings, 3).length, 2);
  });

  it('should keep higher severity when deduplicating', () => {
    const findings = [
      makeFinding({ severity: 'medium', location: { file: 'a.ts', line: 10 } }),
      makeFinding({ severity: 'critical', location: { file: 'a.ts', line: 11 } }),
    ];
    const result = deduplicateFindings(findings, 3);
    assert.equal(result.length, 1);
    assert.equal(result[0].severity, 'critical');
  });

  it('should not merge findings from different files', () => {
    const findings = [
      makeFinding({ location: { file: 'a.ts', line: 10 } }),
      makeFinding({ location: { file: 'b.ts', line: 10 } }),
    ];
    assert.equal(deduplicateFindings(findings).length, 2);
  });

  it('should not merge findings with different rule_ids', () => {
    const findings = [
      makeFinding({ rule_id: 'SHELL_EXEC', location: { file: 'a.ts', line: 10 } }),
      makeFinding({ rule_id: 'OBFUSCATION', location: { file: 'a.ts', line: 10 } }),
    ];
    assert.equal(deduplicateFindings(findings).length, 2);
  });

  it('should use confidence as tiebreaker for same severity', () => {
    const findings = [
      makeFinding({ severity: 'high', confidence: 0.5, location: { file: 'a.ts', line: 10 } }),
      makeFinding({ severity: 'high', confidence: 0.9, location: { file: 'a.ts', line: 11 } }),
    ];
    const result = deduplicateFindings(findings, 3);
    assert.equal(result.length, 1);
    assert.equal(result[0].confidence, 0.9);
  });
});
