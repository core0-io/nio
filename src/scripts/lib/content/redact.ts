// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

export interface RedactResult {
  text: string;
  hits: number;
}

const REDACTED = '[REDACTED]';
const SECRET_KEY_RE = /(api[_-]?key|secret|token|password|passwd|authorization|bearer|private[_-]?key|mnemonic|seed|credential)/i;
const BUILTIN_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /sk-proj-[A-Za-z0-9_-]{16,}/g,
  /sk-(?!ant-|proj-)[A-Za-z0-9_-]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /gh[pousr]_[A-Za-z0-9]{36,}/g,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /Authorization:\s*(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi,
];

export function redactSecrets(text: string, extraPatterns: RegExp[] = []): RedactResult {
  let result = text;
  let hits = 0;
  // Content properties may contain JSON; preserve structured-key protection.
  if (/^\s*[\[{]/.test(text)) {
    try {
      const value: unknown = JSON.parse(text);
      const pending: unknown[] = [value];
      while (pending.length > 0) {
        const item = pending.pop();
        if (!item || typeof item !== 'object') continue;
        for (const [key, child] of Object.entries(item)) {
          if (!Array.isArray(item) && SECRET_KEY_RE.test(key)) {
            Reflect.set(item, key, REDACTED);
            hits += 1;
          } else if (child && typeof child === 'object') pending.push(child);
        }
      }
      if (hits > 0) result = JSON.stringify(value);
    } catch {
      if (hits > 0) return { text: '', hits };
      // Non-JSON prose is scanned by recognizable credential patterns below.
    }
  }

  for (const pattern of [...BUILTIN_PATTERNS, ...extraPatterns]) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, () => {
      hits += 1;
      return REDACTED;
    });
  }

  return { text: result, hits };
}
