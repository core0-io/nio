/**
 * Unit tests for guard.file_scan_rules user-supplied extension patterns.
 *
 * Each of the 7 modules (shell_exec, remote_loader, secrets, obfuscation,
 * prompt_injection, exfiltration, trojan) accepts extra regex patterns that
 * are merged into every rule's pattern list at registry lookup time. These
 * tests verify the user-extension path end-to-end for every module except
 * shell_exec (already covered in rule-registry.test.ts).
 *
 * Approach: inject a uniquely-named marker regex into the module, scan a
 * fixture containing the marker via StaticAnalyser, and assert a finding
 * with one of the module's rule_ids appears. Negative cases verify the
 * marker is the cause (no marker in content → no user-attributable match
 * above the built-in baseline).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StaticAnalyser } from '../core/analysers/static/index.js';
import { defaultPolicy } from '../core/scan-policy.js';
import type { FileInfo } from '../scanner/file-walker.js';
import type { Finding } from '../core/models.js';

// Rule IDs grouped by module (mirrors src/scanner/rules/index.ts RULE_MODULES).
const MODULE_RULE_IDS = {
  shell_exec:       ['SHELL_EXEC', 'AUTO_UPDATE'],
  remote_loader:    ['REMOTE_LOADER'],
  secrets:          ['READ_ENV_SECRETS', 'PRIVATE_KEY_PATTERN', 'READ_SSH_KEYS', 'READ_KEYCHAIN'],
  obfuscation:      ['OBFUSCATION'],
  prompt_injection: ['PROMPT_INJECTION'],
  exfiltration:     ['NET_EXFIL_UNRESTRICTED', 'WEBHOOK_EXFIL'],
  trojan:           ['TROJAN_DISTRIBUTION', 'SUSPICIOUS_PASTE_URL', 'SUSPICIOUS_IP', 'SOCIAL_ENGINEERING'],
} as const;

function makeFile(relativePath: string, content: string): FileInfo {
  const ext = '.' + relativePath.split('.').pop()!;
  return {
    path: `/scan-root/${relativePath}`,
    relativePath,
    content,
    extension: ext,
  };
}

async function scan(
  files: FileInfo[],
  extraPatterns: Partial<Record<string, string[]>>,
): Promise<Finding[]> {
  const analyser = new StaticAnalyser();
  const policy = { ...defaultPolicy(), extra_patterns: extraPatterns };
  return analyser.analyze({ rootDir: '/scan-root', files, policy });
}

function hasModuleFinding(findings: Finding[], module: keyof typeof MODULE_RULE_IDS, snippet: string): boolean {
  const ids = MODULE_RULE_IDS[module] as readonly string[];
  return findings.some(
    (f) => ids.includes(f.rule_id) && (f.location.snippet?.includes(snippet) ?? false),
  );
}

// ── file_scan_rules.remote_loader ───────────────────────────────────────
describe('file_scan_rules.remote_loader', () => {
  const MARKER = 'MYCORP_REMOTE_LOAD_9901';

  it('flags custom marker injected via user config (positive)', async () => {
    const files = [makeFile('loader.ts', `const x = "${MARKER}"; // harmless literal`)];
    const findings = await scan(files, { remote_loader: [MARKER] });
    assert.ok(hasModuleFinding(findings, 'remote_loader', MARKER),
      `expected REMOTE_LOADER finding for marker ${MARKER}`);
  });

  it('does not fire when marker is absent from content (negative)', async () => {
    const files = [makeFile('loader.ts', 'const x = "no such marker here";')];
    const findings = await scan(files, { remote_loader: [MARKER] });
    assert.ok(!hasModuleFinding(findings, 'remote_loader', MARKER));
  });
});

// ── file_scan_rules.secrets ─────────────────────────────────────────────
describe('file_scan_rules.secrets', () => {
  const MARKER = 'MYCORP_SECRET_TOKEN_9902';

  it('flags custom marker injected into secrets module (positive)', async () => {
    const files = [makeFile('leak.ts', `const t = "${MARKER}";`)];
    const findings = await scan(files, { secrets: [MARKER] });
    const ids = MODULE_RULE_IDS.secrets as readonly string[];
    assert.ok(findings.some(
      (f) => ids.includes(f.rule_id) && (f.location.snippet?.includes(MARKER) ?? false),
    ));
  });

  it('does not fire when marker is absent (negative)', async () => {
    const files = [makeFile('leak.ts', 'const t = "benign value";')];
    const findings = await scan(files, { secrets: [MARKER] });
    assert.ok(!hasModuleFinding(findings, 'secrets', MARKER));
  });
});

// ── file_scan_rules.obfuscation ─────────────────────────────────────────
describe('file_scan_rules.obfuscation', () => {
  const MARKER = 'MYCORP_OBF_TAG_9903';

  it('flags custom marker injected into obfuscation module (positive)', async () => {
    const files = [makeFile('obf.ts', `/* benign code */ ${MARKER}`)];
    const findings = await scan(files, { obfuscation: [MARKER] });
    assert.ok(hasModuleFinding(findings, 'obfuscation', MARKER));
  });

  it('does not fire when marker is absent (negative)', async () => {
    const files = [makeFile('obf.ts', '/* benign code */')];
    const findings = await scan(files, { obfuscation: [MARKER] });
    assert.ok(!hasModuleFinding(findings, 'obfuscation', MARKER));
  });
});

// ── file_scan_rules.prompt_injection ────────────────────────────────────
describe('file_scan_rules.prompt_injection', () => {
  const MARKER = 'MYCORP_PROMPT_OVERRIDE_9904';

  it('flags custom marker injected into prompt_injection module (positive)', async () => {
    const files = [makeFile('skill.ts', `// ${MARKER} — should trip our custom rule`)];
    const findings = await scan(files, { prompt_injection: [MARKER] });
    assert.ok(hasModuleFinding(findings, 'prompt_injection', MARKER));
  });

  it('does not fire when marker is absent (negative)', async () => {
    const files = [makeFile('skill.ts', '// ordinary comment')];
    const findings = await scan(files, { prompt_injection: [MARKER] });
    assert.ok(!hasModuleFinding(findings, 'prompt_injection', MARKER));
  });
});

// ── file_scan_rules.exfiltration ────────────────────────────────────────
describe('file_scan_rules.exfiltration', () => {
  const MARKER = 'mycorp-exfil-9905.example';

  it('flags custom marker injected into exfiltration module (positive)', async () => {
    const files = [makeFile('net.ts', `fetch("https://${MARKER}/drop");`)];
    const findings = await scan(files, { exfiltration: [MARKER.replace(/\./g, '\\.')] });
    assert.ok(hasModuleFinding(findings, 'exfiltration', MARKER));
  });

  it('does not fire when marker is absent (negative)', async () => {
    const files = [makeFile('net.ts', 'fetch("https://safe.example.com/hi");')];
    const findings = await scan(files, { exfiltration: [MARKER.replace(/\./g, '\\.')] });
    assert.ok(!hasModuleFinding(findings, 'exfiltration', MARKER));
  });
});

// ── file_scan_rules.trojan ──────────────────────────────────────────────
describe('file_scan_rules.trojan', () => {
  const MARKER = 'MYCORP_TROJAN_TAG_9906';

  it('flags custom marker injected into trojan module (positive)', async () => {
    // Use .ts so file_patterns:['*'] trojan rules pick up the injected pattern.
    // (.md content is scanned only inside fenced code blocks.)
    const files = [makeFile('payload.ts', `const marker = "${MARKER}";`)];
    const findings = await scan(files, { trojan: [MARKER] });
    assert.ok(hasModuleFinding(findings, 'trojan', MARKER));
  });

  it('does not fire when marker is absent (negative)', async () => {
    const files = [makeFile('payload.ts', 'const marker = "nothing here";')];
    const findings = await scan(files, { trojan: [MARKER] });
    assert.ok(!hasModuleFinding(findings, 'trojan', MARKER));
  });
});

// ── Invalid-pattern tolerance (cross-cutting) ───────────────────────────
describe('file_scan_rules — invalid user pattern handling', () => {
  it('silently skips invalid regex without disabling valid siblings', async () => {
    const MARKER = 'MYCORP_MIXED_9907';
    const files = [makeFile('mix.ts', `const x = "${MARKER}";`)];
    const findings = await scan(files, {
      remote_loader: ['(unclosed', MARKER, '[invalid'],
    });
    assert.ok(hasModuleFinding(findings, 'remote_loader', MARKER),
      'valid pattern should still fire when siblings are invalid');
  });
});
