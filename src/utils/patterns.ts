// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Sensitive data patterns for detection.
 *
 * Pattern definitions now live in `src/core/shared/detection-data.ts` (single
 * source of truth).  This module re-exports them and provides the utility
 * functions used by action detectors and other consumers.
 */

import { SECRET_PATTERNS } from '../core/shared/detection-data.js';

// Re-export under both names for backward compatibility
export { SECRET_PATTERNS } from '../core/shared/detection-data.js';
export { SECRET_PATTERNS as SENSITIVE_PATTERNS } from '../core/shared/detection-data.js';

/**
 * Check if content contains sensitive data
 */
export function containsSensitiveData(content: string): {
  found: boolean;
  types: string[];
  matches: { type: string; match: string; truncated: string }[];
} {
  const matches: { type: string; match: string; truncated: string }[] = [];
  const types: Set<string> = new Set();

  for (const [type, pattern] of Object.entries(SECRET_PATTERNS)) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      types.add(type);
      matches.push({
        type,
        match: match[0],
        truncated: match[0].slice(0, 20) + (match[0].length > 20 ? '...' : ''),
      });

      // Prevent infinite loop for zero-length matches
      if (match.index === pattern.lastIndex) {
        pattern.lastIndex++;
      }
    }
  }

  return {
    found: types.size > 0,
    types: Array.from(types),
    matches,
  };
}

/**
 * Mask sensitive data in content
 */
export function maskSensitiveData(content: string): string {
  let masked = content;

  for (const pattern of Object.values(SECRET_PATTERNS)) {
    pattern.lastIndex = 0;
    masked = masked.replace(pattern, (match) => {
      if (match.length <= 8) {
        return '*'.repeat(match.length);
      }
      return match.slice(0, 4) + '*'.repeat(match.length - 8) + match.slice(-4);
    });
  }

  return masked;
}

/**
 * Extract domain from URL
 */
export function extractDomain(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return null;
  }
}

/**
 * Check if domain matches a pattern (supports wildcards)
 */
export function domainMatchesPattern(domain: string, pattern: string): boolean {
  if (pattern === '*') return true;

  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    return domain === suffix || domain.endsWith('.' + suffix);
  }

  return domain === pattern;
}

/**
 * Check if domain is in allowlist
 */
export function isDomainAllowed(
  domain: string,
  allowlist: string[]
): boolean {
  return allowlist.some((pattern) => domainMatchesPattern(domain, pattern));
}
