// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Extract inline source code from a shell command that embeds an
 * interpreter body (e.g. `python3 -c "..."`, `node -e "..."`, heredoc
 * forms). The extracted body can then be fed through the same static +
 * behavioural analysers that run on real file content, so a command
 * like `python3 - <<'PY' ... shutil.rmtree(...) ... PY` gets Phase 4
 * coverage rather than escaping through a Phase 2 regex gap.
 *
 * Deliberately regex-based and imperfect: misses produce the same
 * "no Phase 3/4 for this command" behaviour we have today (never a
 * false positive on plain `node index.js foo`).
 */

export type InlineCodeLanguage =
  | 'python'
  | 'javascript'
  | 'shell'
  | 'ruby'
  | 'perl'
  | 'php';

export interface InlineCode {
  language: InlineCodeLanguage;
  /** Extracted source body, without quoting / heredoc wrapping. */
  content: string;
  /** Virtual path with a meaningful extension for downstream dispatch. */
  virtualPath: string;
}

// ── Per-language patterns ──────────────────────────────────────────────

interface Interpreter {
  language: InlineCodeLanguage;
  virtualPath: string;
  /** Names recognised at the start of a command segment (before -c/-e). */
  binaries: readonly string[];
  /** Flag token marking inline code, e.g. `-c`, `-e`, `--eval`. */
  flags: readonly string[];
}

const INTERPRETERS: readonly Interpreter[] = [
  {
    language: 'python',
    virtualPath: 'inline.py',
    binaries: ['python', 'python2', 'python3'],
    flags: ['-c'],
  },
  {
    language: 'javascript',
    virtualPath: 'inline.js',
    binaries: ['node', 'nodejs'],
    flags: ['-e', '--eval', '-p', '--print'],
  },
  {
    language: 'shell',
    virtualPath: 'inline.sh',
    binaries: ['bash', 'sh', 'zsh', 'dash'],
    flags: ['-c'],
  },
  {
    language: 'ruby',
    virtualPath: 'inline.rb',
    binaries: ['ruby'],
    flags: ['-e'],
  },
  {
    language: 'perl',
    virtualPath: 'inline.pl',
    binaries: ['perl'],
    flags: ['-e', '-E'],
  },
  {
    language: 'php',
    virtualPath: 'inline.php',
    binaries: ['php'],
    flags: ['-r'],
  },
];

// Matches shell command separators that legitimately introduce a new
// simple command. Used as a gate when scanning for interpreter
// invocations mid-command (e.g. `foo && python3 -c "..."`) so we
// don't match quoted literals inside another command's arguments.
const SEPARATOR_RE = /(?:^|[|;&]|&&|\|\|)\s*/;

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Try to extract an inline code body from a shell command.
 *
 * Returns null when no recognised interpreter + flag / heredoc shape is
 * present. On match, returns the body (unquoted) plus a language tag
 * and a virtual path (`inline.py`, `inline.js`, ...) suitable for
 * downstream dispatch that looks up analysers by extension.
 */
export function extractInlineCode(command: string): InlineCode | null {
  if (!command || command.length === 0) return null;

  // Try heredoc form first (it's multi-line, regex-greediness-sensitive,
  // and also the shape that exposed the Phase 3/4 gap in the wild:
  //   python3 - <<'PY' ... PY
  const heredoc = tryExtractHeredoc(command);
  if (heredoc) return heredoc;

  // Then try `<interpreter> <flag> '<body>'` forms.
  for (const interp of INTERPRETERS) {
    const match = tryExtractFlagForm(command, interp);
    if (match) return match;
  }

  return null;
}

// ── Heredoc extraction ────────────────────────────────────────────────

/**
 * Match `<interp> - <<DELIM ... DELIM` and `<interp> - <<-DELIM ... DELIM`,
 * with DELIM optionally quoted (`'PY'` / `"PY"`). The stdin dash (`-`)
 * after the interpreter tells it to read stdin, which the heredoc
 * supplies. Also matches without the dash (`python3 <<PY ... PY`) —
 * rarer but still semantically stdin.
 */
function tryExtractHeredoc(command: string): InlineCode | null {
  for (const interp of INTERPRETERS) {
    const binaries = interp.binaries.map(escapeRegExp).join('|');
    // Group 1: delimiter quote (' or " or empty)
    // Group 2: delimiter word
    // Group 3: body (lazy, any char inc. newlines)
    const re = new RegExp(
      `(?:^|[|;&\\s]|&&|\\|\\|)\\s*(?:${binaries})\\b[^\\n]*?<<-?\\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\\1\\s*\\n([\\s\\S]*?)\\n\\s*\\2\\s*(?:$|\\n)`,
      'm',
    );
    const m = command.match(re);
    if (m && typeof m[3] === 'string') {
      return {
        language: interp.language,
        content: m[3],
        virtualPath: interp.virtualPath,
      };
    }
  }
  return null;
}

// ── `-c` / `-e` flag form ──────────────────────────────────────────────

/**
 * Scan the command for a segment that looks like `<interp> <flag> <body>`,
 * where <body> is either a single/double-quoted string or (as a
 * permissive fallback) an unquoted token sequence to end-of-line.
 *
 * Only counts matches that sit at a command-segment boundary (start of
 * string, or after `|`, `;`, `&`, `&&`, `||`, or whitespace that
 * follows one of those). This avoids misidentifying the substring
 * `python -c "foo"` inside an `echo` argument as a real invocation.
 */
function tryExtractFlagForm(command: string, interp: Interpreter): InlineCode | null {
  const binariesAlt = interp.binaries.map(escapeRegExp).join('|');
  const flagsAlt = interp.flags.map(escapeRegExp).join('|');
  const re = new RegExp(
    // boundary, then: binary, one or more whitespace (possibly with
    // interpreter args like `-u`), then the target flag, then the body.
    SEPARATOR_RE.source + `(?:${binariesAlt})\\b(?:\\s+-[A-Za-z]+)*\\s+(?:${flagsAlt})\\s+`,
    'g',
  );

  // We walk matches rather than taking the first, so multiple
  // interpreter invocations in a piped command could each be examined
  // (though for v1 we only return the first extractable body).
  for (const m of command.matchAll(re)) {
    const rest = command.slice(m.index! + m[0].length);
    const body = readBody(rest);
    if (body) {
      return {
        language: interp.language,
        content: body,
        virtualPath: interp.virtualPath,
      };
    }
  }
  return null;
}

/**
 * Read an inline-code body starting at position 0 of `rest`.
 *
 * Handles:
 *   - Single-quoted strings: `'...'` — no escape processing (sh rules).
 *   - Double-quoted strings: `"..."` — honours `\"`, `\\`, `\$` unescapes.
 *   - Unquoted run: everything up to the next shell separator.
 *
 * Returns null if the body is empty or can't be terminated.
 */
function readBody(rest: string): string | null {
  if (rest.length === 0) return null;
  const ch = rest[0]!;

  if (ch === "'") {
    const end = rest.indexOf("'", 1);
    if (end < 0) return null;
    const body = rest.slice(1, end);
    return body.length > 0 ? body : null;
  }

  if (ch === '"') {
    let out = '';
    let i = 1;
    while (i < rest.length) {
      const c = rest[i]!;
      if (c === '\\' && i + 1 < rest.length) {
        const next = rest[i + 1]!;
        // Minimal unescape: these are the characters double-quotes
        // treat specially in POSIX shell.
        if (next === '"' || next === '\\' || next === '$' || next === '`' || next === '\n') {
          out += next;
          i += 2;
          continue;
        }
        out += c;
        i += 1;
        continue;
      }
      if (c === '"') {
        return out.length > 0 ? out : null;
      }
      out += c;
      i += 1;
    }
    return null;
  }

  // Unquoted: grab until the next shell command separator.
  const stopMatch = rest.match(/[|;&\n]|&&|\|\|/);
  const body = (stopMatch ? rest.slice(0, stopMatch.index) : rest).trim();
  return body.length > 0 ? body : null;
}

// ── Helpers ───────────────────────────────────────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
