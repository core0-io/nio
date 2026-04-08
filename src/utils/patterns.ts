/**
 * Sensitive data patterns for detection
 */

/**
 * Sensitive data patterns
 */
export const SENSITIVE_PATTERNS = {
  /**
   * Hex-encoded private key (64 hex characters with 0x prefix)
   */
  PRIVATE_KEY: /0x[a-fA-F0-9]{64}/g,

  /**
   * API key/secret patterns
   */
  API_SECRET: /(api[_\-]?secret|secret[_\-]?key|api[_\-]?key)\s*[:=]\s*['"]?[A-Za-z0-9\-_]{20,}['"]?/gi,

  /**
   * SSH private key
   */
  SSH_KEY: /-----BEGIN (OPENSSH|RSA|DSA|EC|PGP) PRIVATE KEY-----/g,

  /**
   * JWT/Bearer token
   */
  BEARER_TOKEN: /Bearer\s+[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]*/g,

  /**
   * AWS credentials
   */
  AWS_KEY: /(AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}/g,
  AWS_SECRET: /aws[_\-]?secret[_\-]?access[_\-]?key\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi,

  /**
   * GitHub token
   */
  GITHUB_TOKEN: /gh[pousr]_[A-Za-z0-9_]{36,}/g,

  /**
   * Generic password in config
   */
  PASSWORD_CONFIG: /(password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}['"]/gi,

  /**
   * Database connection string
   */
  DB_CONNECTION: /(mongodb|postgres|mysql|redis):\/\/[^\s'"]+/gi,
};

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

  for (const [type, pattern] of Object.entries(SENSITIVE_PATTERNS)) {
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

  for (const pattern of Object.values(SENSITIVE_PATTERNS)) {
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
