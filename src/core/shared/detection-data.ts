// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared detection data — single source of truth for both the static scan
 * engine and the dynamic guard (ActionOrchestrator).
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
  // ── Credentials ─────────────────────────────────────────────────────
  '.env', '.env.local', '.env.production',
  '.ssh/', 'id_rsa', 'id_ed25519', 'authorized_keys',
  '.aws/credentials', '.aws/config',
  '.npmrc', '.netrc',
  'credentials.json', 'serviceAccountKey.json',
  '.kube/config',

  // ── MCP server configuration (writes here can register a new server
  //    that bypasses the permitted_tools.mcp allowlist) ──────────────
  '.claude.json',
  '.claude/mcp',
  'Library/Application Support/Claude/claude_desktop_config.json',
  'AppData/Roaming/Claude/claude_desktop_config.json',
  '.config/Claude/claude_desktop_config.json',
  '.hermes/config.yaml',
  '.hermes/plugins/',
  '.openclaw/openclaw.json',
  '.openclaw/',
  // Pi core has no MCP; the third-party pi-mcp-adapter package supplies
  // it and stores its server map (mcp.json) under this same directory.
  // settings.json itself is sensitive because it controls which
  // extensions load and which skills are trusted.
  '.pi/settings.json',
  '.pi/agent/settings.json',
  '.pi/',
  '.opencode/opencode.json',
  '.config/opencode/opencode.json',
  // Both opencode roots are covered as broadly as `.pi/`, `.openclaw/`
  // and `.hermes/plugins/`: the project-local `.opencode/` AND the
  // user-level `~/.config/opencode/`. The latter is the auto-load
  // directory opencode globs at startup (plugins/opencode/setup.sh
  // installs Nio into `~/.config/opencode/plugins/` for exactly that
  // reason), so a write there is arbitrary code execution on the next
  // opencode launch — a code-execution persistence channel, not just a
  // config file.
  '.opencode/',
  '.config/opencode/',

  // ── Persistence channels (next-launch / scheduled triggers) ────────
  'Library/LaunchAgents/',
  'Library/LaunchDaemons/',
  'etc/cron.',
  'var/spool/cron/',
  '.config/systemd/user/',
  'etc/systemd/system/',
  '.bashrc', '.zshrc', '.profile', '.bash_profile', '.zprofile', '.zshenv',
] as const;

// ── XDG relocation of the `.config/…` entries ───────────────────────────

/**
 * `SENSITIVE_FILE_PATHS` is a list of static path *fragments*, matched as
 * substrings (`normalized.includes('/' + p) || normalized.endsWith(p)`),
 * not as resolved absolute paths. That works fine for `~`-relative
 * entries, but the `.config/…` entries are XDG-relative: a user who sets
 * `XDG_CONFIG_HOME=/data/cfg` has their opencode config — including
 * `plugins/`, which opencode globs and executes at startup — at
 * `/data/cfg/opencode/`, which no static fragment can match. They would
 * get zero protection on the very directory our own installer writes to.
 *
 * `mcp-registry.ts` and both `setup.sh` scripts already honour
 * `XDG_CONFIG_HOME`; this closes the same gap for path detection by
 * deriving an extra fragment for every `.config/…` entry, rooted at the
 * configured XDG dir. Derived at match time (not module load) so a
 * process that sets the variable later — and any test — sees it.
 *
 * The returned fragments have no leading slash, so they slot straight
 * into the existing substring matcher without changing its shape.
 *
 * Reads `process.env` directly and memoises on the raw string. It takes
 * no env argument on purpose: nothing ever passed one, and a memo keyed
 * on the string alone would silently serve one env object's answer to
 * another's. Tests drive it the way the runtime does — by setting
 * `process.env.XDG_CONFIG_HOME`.
 */
const XDG_PREFIX = '.config/';

let xdgCacheKey: string | undefined;
let xdgCacheValue: string[] = [];

export function xdgRelocatedSensitivePaths(): string[] {
  const raw = process.env.XDG_CONFIG_HOME ?? '';
  if (xdgCacheKey === raw) return xdgCacheValue;

  let derived: string[] = [];
  if (raw) {
    let root = raw.replace(/\\/g, '/');
    // Same `~` expansion the matchers apply to the candidate path.
    if (root.startsWith('~/')) root = '/HOME' + root.slice(1);
    // Only an ABSOLUTE root can yield a meaningful fragment. The XDG
    // spec requires one, so a relative value is a misconfiguration —
    // and honouring it would be actively harmful: `XDG_CONFIG_HOME=cfg`
    // derives the fragment `cfg/opencode/`, which the substring matcher
    // then hits on any unrelated `/some/project/cfg/opencode/...`.
    // Derive nothing; the static list still applies.
    const absolute = root.startsWith('/') || /^[A-Za-z]:\//.test(root);
    if (absolute) {
      root = root.replace(/\/+$/, '').replace(/^\/+/, '');
      if (root) {
        derived = SENSITIVE_FILE_PATHS
          .filter((p) => p.startsWith(XDG_PREFIX))
          .map((p) => `${root}/${p.slice(XDG_PREFIX.length)}`);
      }
    }
  }

  xdgCacheKey = raw;
  xdgCacheValue = derived;
  return derived;
}

/**
 * The single sensitive-path predicate. Checks the static list, the
 * XDG-relocated `.config/…` twins, and any operator-supplied extra
 * fragments, all with the same substring semantics.
 *
 * `filePath` must already be normalised by the caller (backslashes
 * folded to `/`, a leading `~/` rewritten to `/HOME/`) — every call site
 * does that before it has a fragment list to test against.
 */
export function matchesSensitiveFilePath(
  normalizedPath: string,
  extraPaths?: readonly string[],
): boolean {
  const hit = (p: string) =>
    normalizedPath.includes(`/${p}`) || normalizedPath.endsWith(p);
  if (SENSITIVE_FILE_PATHS.some(hit)) return true;
  if (xdgRelocatedSensitivePaths().some(hit)) return true;
  if (extraPaths?.some(hit)) return true;
  return false;
}

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
