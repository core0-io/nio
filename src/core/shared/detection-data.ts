/**
 * Shared detection data — single source of truth for both the static scan
 * engine and the dynamic guard (RuntimeAnalyser).
 *
 * Consolidates constants that were previously duplicated across:
 *   - src/action/detectors/network.ts     (WEBHOOK_DOMAINS, HIGH_RISK_TLDS)
 *   - src/scanner/rules/exfiltration.ts   (WEBHOOK_EXFIL regex patterns)
 *   - src/adapters/common.ts              (SENSITIVE_PATHS)
 *   - src/action/detectors/secret-leak.ts (SECRET_PRIORITY)
 *   - src/utils/patterns.ts               (SENSITIVE_PATTERNS)
 */

// ── Webhook / Exfiltration Domains ──────────────────────────────────────

/** Known webhook and exfiltration service domains. */
export const WEBHOOK_EXFIL_DOMAINS = [
  'discord.com',
  'discordapp.com',
  'api.telegram.org',
  'hooks.slack.com',
  'webhook.site',
  'requestbin.com',
  'pipedream.com',
  'ngrok.io',
  'ngrok-free.app',
  'beeceptor.com',
  'mockbin.org',
  'workers.dev',
  'vercel.app',
  'netlify.app',
  'deno.dev',
  'burpcollaborator.net',
  'interact.sh',
  'oast.pro',
] as const;

// ── High-Risk TLDs ─────────────────────────────────────────────────────

/** TLDs frequently associated with malicious activity. */
export const HIGH_RISK_TLDS = [
  '.xyz',
  '.top',
  '.tk',
  '.ml',
  '.ga',
  '.cf',
  '.gq',
  '.work',
  '.click',
  '.link',
] as const;

// ── Sensitive File Paths ────────────────────────────────────────────────

/** File path fragments that indicate sensitive data. */
export const SENSITIVE_FILE_PATHS = [
  '.env', '.env.local', '.env.production',
  '.ssh/', 'id_rsa', 'id_ed25519',
  '.aws/credentials', '.aws/config',
  '.npmrc', '.netrc',
  'credentials.json', 'serviceAccountKey.json',
  '.kube/config',
] as const;

// ── Secret Pattern Regexes ──────────────────────────────────────────────

/**
 * Sensitive data patterns for detecting secrets in content.
 * Each pattern uses the global flag; callers must reset `lastIndex` before use.
 */
export const SECRET_PATTERNS = {
  /** Hex-encoded private key (64 hex characters with 0x prefix) */
  PRIVATE_KEY: /0x[a-fA-F0-9]{64}/g,
  /** API key/secret patterns */
  API_SECRET: /(api[_\-]?secret|secret[_\-]?key|api[_\-]?key)\s*[:=]\s*['"]?[A-Za-z0-9\-_]{20,}['"]?/gi,
  /** SSH private key */
  SSH_KEY: /-----BEGIN (OPENSSH|RSA|DSA|EC|PGP) PRIVATE KEY-----/g,
  /** JWT/Bearer token */
  BEARER_TOKEN: /Bearer\s+[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]*/g,
  /** AWS access key ID */
  AWS_KEY: /(AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}/g,
  /** AWS secret access key */
  AWS_SECRET: /aws[_\-]?secret[_\-]?access[_\-]?key\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi,
  /** GitHub token */
  GITHUB_TOKEN: /gh[pousr]_[A-Za-z0-9_]{36,}/g,
  /** Generic password in config */
  PASSWORD_CONFIG: /(password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
  /** Database connection string */
  DB_CONNECTION: /(mongodb|postgres|mysql|redis):\/\/[^\s'"]+/gi,
} as const;

// ── Secret Priority ─────────────────────────────────────────────────────

/** Priority of secret types (higher = more critical). Used for risk scoring. */
export const SECRET_PRIORITY: Record<string, number> = {
  PRIVATE_KEY: 100,
  SSH_KEY: 90,
  AWS_SECRET: 80,
  AWS_KEY: 70,
  GITHUB_TOKEN: 70,
  BEARER_TOKEN: 60,
  API_SECRET: 50,
  DB_CONNECTION: 50,
  PASSWORD_CONFIG: 40,
};
