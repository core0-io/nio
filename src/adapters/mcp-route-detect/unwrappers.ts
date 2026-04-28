// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Stage 1 — recursive command unwrappers (U1-U16).
 *
 * Given a Bash command, recursively extract every nested / obfuscated /
 * encoded sub-command into a flat list of fragments. Each fragment is
 * later fed independently through the Stage 2 detectors.
 *
 * Composition: if a command nests several wrappers (e.g. heredoc inside
 * base64 inside `bash -c`), each unwrapper layer produces inner
 * fragments and the driver recurses on them. Depth is capped at
 * `MAX_UNWRAP_DEPTH` to bound recursion bombs.
 *
 * Pass-through flags (`remote`, `background`, `compiled`) propagate from
 * outer wrappers to inner fragments so detectors downstream can attribute
 * the channel.
 */

import type { UnwrappedFragment } from './types.js';

/** Maximum unwrap depth — guard against recursion bombs. */
export const MAX_UNWRAP_DEPTH = 8;

interface UnwrapFlags {
  remote?: boolean;
  background?: boolean;
  compiled?: boolean;
}

interface UnwrapResult {
  fragments: string[];
  /** Mark fragments as inline interpreter code (for D7). */
  inline?: boolean;
  /** Pass-through flags merged into outputs. */
  flags?: UnwrapFlags;
}

type UnwrapperFn = (command: string) => UnwrapResult | null;

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

const UNWRAPPERS: { name: string; fn: UnwrapperFn }[] = [];

function register(name: string, fn: UnwrapperFn): void {
  UNWRAPPERS.push({ name, fn });
}

/**
 * Recursively unwrap a Bash command into a flat list of fragments. The
 * original command is always included with any flags contributed by
 * matching unwrappers (e.g. `nohup X &` gets `background=true` on the
 * top-level fragment too). Inner fragments are produced for every
 * unwrapper that matched; recursion goes up to `MAX_UNWRAP_DEPTH` deep.
 */
export function unwrapCommand(command: string): UnwrappedFragment[] {
  if (!command) return [];
  const out: UnwrappedFragment[] = [];
  const seen = new Set<string>();

  const recurse = (cmd: string, depth: number, parentFlags: UnwrapFlags, parentInline: boolean) => {
    // Pass 1: gather flags from all matching unwrappers and collect inner fragments.
    let myFlags: UnwrapFlags = { ...parentFlags };
    let myInline = parentInline;
    type Inner = { command: string; flags: UnwrapFlags; inline: boolean };
    const inners: Inner[] = [];

    if (depth < MAX_UNWRAP_DEPTH) {
      for (const { fn } of UNWRAPPERS) {
        const result = fn(cmd);
        if (!result) continue;
        if (result.flags) myFlags = { ...myFlags, ...result.flags };
        if (result.inline) myInline = true;
        const childFlags: UnwrapFlags = { ...myFlags };
        const childInline = myInline;
        for (const frag of result.fragments) {
          if (frag) inners.push({ command: frag, flags: childFlags, inline: childInline });
        }
      }
    }

    const key = `${depth}|${myInline ? 'I' : 'S'}|${cmd}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ command: cmd, flags: myFlags, inline: myInline });
    }

    for (const inner of inners) recurse(inner.command, depth + 1, inner.flags, inner.inline);
  };

  recurse(command, 0, {}, false);
  return out;
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

/** Parse a single- or double-quoted string starting at `pos`. */
function extractQuoted(s: string, pos: number): { value: string; end: number } | null {
  if (pos >= s.length) return null;
  const quote = s[pos];
  if (quote !== '"' && quote !== "'") return null;
  let i = pos + 1;
  let value = '';
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length && quote === '"') {
      value += s[i + 1];
      i += 2;
      continue;
    }
    if (ch === quote) return { value, end: i + 1 };
    value += ch;
    i++;
  }
  return null; // unclosed
}

/** Skip whitespace then read a `[ \t]+`-bounded token. Stops at shell metas. */
function extractToken(s: string, pos: number): { value: string; end: number } | null {
  let i = pos;
  while (i < s.length && /[ \t]/.test(s[i])) i++;
  if (i >= s.length) return null;
  const start = i;
  while (i < s.length && !/[\s;|&)]/.test(s[i])) i++;
  if (i === start) return null;
  return { value: s.slice(start, i), end: i };
}

/** Extract either a quoted string or a token starting at `pos`. */
function extractQuotedOrToken(s: string, pos: number): { value: string; end: number } | null {
  let i = pos;
  while (i < s.length && /[ \t]/.test(s[i])) i++;
  if (i >= s.length) return null;
  if (s[i] === '"' || s[i] === "'") return extractQuoted(s, i);
  return extractToken(s, i);
}

/**
 * Extract a balanced expression `<open> ... <close>` starting at `pos`.
 * Respects nested quotes and same-bracket nesting.
 */
function extractBalanced(s: string, pos: number, open: string, close: string): { value: string; end: number } | null {
  if (s[pos] !== open) return null;
  let depth = 1;
  let i = pos + 1;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) { i += 2; continue; }
    if (ch === '"' || ch === "'") {
      const q = extractQuoted(s, i);
      if (q) { i = q.end; continue; }
      i++; continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return { value: s.slice(pos + 1, i), end: i + 1 };
    }
    i++;
  }
  return null;
}

/** Find every non-overlapping match for a regex with `g` flag. */
function* allMatches(s: string, re: RegExp): Generator<RegExpExecArray> {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) yield m;
}

// ---------------------------------------------------------------------------
// U1 — shell -c "..."
// ---------------------------------------------------------------------------

const SHELL_C_RE = /\b(?:bash|sh|zsh|dash|ksh|fish|busybox(?:\s+sh)?)\s+(?:-[a-zA-Z]+\s+)*-c\s+/g;

register('u1-shell-c', (command: string) => {
  const fragments: string[] = [];
  for (const m of allMatches(command, SHELL_C_RE)) {
    const inner = extractQuotedOrToken(command, m.index + m[0].length);
    if (inner && inner.value) fragments.push(inner.value);
  }
  return fragments.length ? { fragments } : null;
});

// ---------------------------------------------------------------------------
// U2 — variable shell — $SHELL -c "...", ${SHELL} -c "..."
// ---------------------------------------------------------------------------

const VAR_SHELL_RE = /\$(?:\{(?:SHELL|BASH)\}|SHELL|BASH)\s+(?:-[a-zA-Z]+\s+)*-c\s+/g;

register('u2-var-shell', (command: string) => {
  const fragments: string[] = [];
  for (const m of allMatches(command, VAR_SHELL_RE)) {
    const inner = extractQuotedOrToken(command, m.index + m[0].length);
    if (inner && inner.value) fragments.push(inner.value);
  }
  return fragments.length ? { fragments } : null;
});

// ---------------------------------------------------------------------------
// U3 — eval "..."
// ---------------------------------------------------------------------------

const EVAL_RE = /\beval\s+/g;

register('u3-eval', (command: string) => {
  const fragments: string[] = [];
  for (const m of allMatches(command, EVAL_RE)) {
    const start = m.index + m[0].length;
    if (start >= command.length) continue;
    if (command[start] === '"' || command[start] === "'") {
      const q = extractQuoted(command, start);
      if (q && q.value) fragments.push(q.value);
    } else if (command.startsWith('$(', start)) {
      const b = extractBalanced(command, start + 1, '(', ')');
      if (b && b.value) fragments.push(b.value);
    }
  }
  return fragments.length ? { fragments } : null;
});

// ---------------------------------------------------------------------------
// U4 — heredoc / here-string
//
// Heredoc: `<<[-]MARKER\n...body...\nMARKER`. We detect the marker, locate
// the trailing line that contains only the marker, and slice the body.
// Here-string: `<<<value` or `<<<'value'` — extract value.
// ---------------------------------------------------------------------------

const HEREDOC_OPEN_RE = /<<-?\s*(?:'([A-Za-z_][\w]*)'|"([A-Za-z_][\w]*)"|([A-Za-z_][\w]*))/g;
const HERESTRING_RE = /<<<\s*/g;

register('u4-heredoc', (command: string) => {
  const fragments: string[] = [];
  for (const m of allMatches(command, HEREDOC_OPEN_RE)) {
    const marker = m[1] || m[2] || m[3];
    if (!marker) continue;
    // Find end-of-line, then look for `\n<marker>` or `\n<marker>$`.
    const after = m.index + m[0].length;
    const nl = command.indexOf('\n', after);
    if (nl === -1) continue;
    const closeRe = new RegExp('\\n' + marker.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '(?:\\n|$)');
    const closeMatch = closeRe.exec(command.slice(nl));
    if (!closeMatch) continue;
    const body = command.slice(nl + 1, nl + closeMatch.index);
    if (body) fragments.push(body);
  }
  for (const m of allMatches(command, HERESTRING_RE)) {
    const start = m.index + m[0].length;
    const inner = extractQuotedOrToken(command, start);
    if (inner && inner.value) fragments.push(inner.value);
  }
  return fragments.length ? { fragments } : null;
});

// ---------------------------------------------------------------------------
// U5 — process substitution `<(X)` and `>(X)`
// ---------------------------------------------------------------------------

register('u5-process-sub', (command: string) => {
  const fragments: string[] = [];
  for (let i = 0; i < command.length - 1; i++) {
    const a = command[i];
    const b = command[i + 1];
    if ((a === '<' || a === '>') && b === '(') {
      const inner = extractBalanced(command, i + 1, '(', ')');
      if (inner && inner.value) fragments.push(inner.value);
    }
  }
  return fragments.length ? { fragments } : null;
});

// ---------------------------------------------------------------------------
// U6 — command substitution `$(X)` and backticks
// ---------------------------------------------------------------------------

register('u6-cmd-sub', (command: string) => {
  const fragments: string[] = [];
  // $(X)
  for (let i = 0; i < command.length - 1; i++) {
    if (command[i] === '$' && command[i + 1] === '(') {
      const inner = extractBalanced(command, i + 1, '(', ')');
      if (inner && inner.value) fragments.push(inner.value);
    }
  }
  // backticks
  let i = 0;
  while (i < command.length) {
    if (command[i] === '`') {
      const end = command.indexOf('`', i + 1);
      if (end > i + 1) {
        fragments.push(command.slice(i + 1, end));
        i = end + 1;
        continue;
      }
    }
    i++;
  }
  return fragments.length ? { fragments } : null;
});

// ---------------------------------------------------------------------------
// U7 — `source <(X)`, `. <(X)`, `bash <(X)` — covered by U5; this unwrapper
// also handles `source file` / `. file` / `bash file` (no extraction
// possible from a path, so it is a no-op for static analysis).
// ---------------------------------------------------------------------------

register('u7-source', (_command: string) => null);

// ---------------------------------------------------------------------------
// U8 — interpreter inline (`python -c "..."`, `node -e "..."`, …)
// ---------------------------------------------------------------------------

const INTERPRETER_INLINE_RE =
  /\b(?:python|python3|python2|node|nodejs|deno|bun|ruby|perl|php|lua|Rscript|tclsh|osascript|pwsh|powershell)\s+(?:[A-Za-z0-9-]+\s+)*-(?:c|e|r|-eval|-command)\s+/g;

register('u8-interp-inline', (command: string) => {
  const fragments: string[] = [];
  for (const m of allMatches(command, INTERPRETER_INLINE_RE)) {
    const inner = extractQuotedOrToken(command, m.index + m[0].length);
    if (inner && inner.value) fragments.push(inner.value);
  }
  // `deno eval "..."` (subcommand form, not -c)
  for (const m of allMatches(command, /\bdeno\s+eval\s+/g)) {
    const inner = extractQuotedOrToken(command, m.index + m[0].length);
    if (inner && inner.value) fragments.push(inner.value);
  }
  return fragments.length ? { fragments, inline: true } : null;
});

// ---------------------------------------------------------------------------
// U9 — encoded-pipe decoder: `<echo|printf> '<b64>' | base64 -d | <interp>`
// ---------------------------------------------------------------------------

const BASE64_PIPE_RE =
  /\b(?:echo|printf|cat)\s+(?:-[a-zA-Z]\s+)*('[A-Za-z0-9+/=\s]+'|"[A-Za-z0-9+/=\s]+"|[A-Za-z0-9+/=]+)\s*\|\s*(?:base64\s+(?:-d|--decode|-D)|openssl\s+base64\s+-d|xxd\s+-r\s+-p)/g;

register('u9-encoded-pipe', (command: string) => {
  const fragments: string[] = [];
  for (const m of allMatches(command, BASE64_PIPE_RE)) {
    let payload = m[1];
    if (payload.startsWith('"') || payload.startsWith("'")) payload = payload.slice(1, -1);
    payload = payload.replace(/\s+/g, '');
    try {
      const decoded = Buffer.from(payload, 'base64').toString('utf-8');
      if (decoded) fragments.push(decoded);
    } catch {
      // ignore
    }
  }
  return fragments.length ? { fragments } : null;
});

// ---------------------------------------------------------------------------
// U10 — string concat / variable indirection (best-effort)
// Detects: `c=cu; c=$c"rl"; $c URL` → resolves $c to "curl"
// Only handles simple a=$a"x" / a="x"$a chains; complex patterns are an
// acknowledged residual gap.
// ---------------------------------------------------------------------------

const VAR_ASSIGN_RE = /\b([A-Za-z_][A-Za-z0-9_]*)=([^\s;|&]+)/g;
const VAR_USE_RE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g;

/** Best-effort static resolution of an assignment rhs (var refs + adjacent quoted/unquoted). */
function evaluateRhs(rhs: string, env: Map<string, string>): string {
  let out = '';
  let i = 0;
  while (i < rhs.length) {
    const ch = rhs[i];
    if (ch === '"' || ch === "'") {
      const q = extractQuoted(rhs, i);
      if (!q) { out += ch; i++; continue; }
      out += q.value;
      i = q.end;
    } else if (ch === '$') {
      let j = i + 1;
      const braced = rhs[j] === '{';
      if (braced) j++;
      const start = j;
      while (j < rhs.length && /[A-Za-z0-9_]/.test(rhs[j])) j++;
      const name = rhs.slice(start, j);
      if (braced && rhs[j] === '}') j++;
      out += env.get(name) ?? '';
      i = j;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

register('u10-var-fold', (command: string) => {
  if (!command.includes('=') || !command.includes('$')) return null;
  const env = new Map<string, string>();
  let dirty = false;
  for (const m of allMatches(command, VAR_ASSIGN_RE)) {
    const name = m[1];
    const value = evaluateRhs(m[2], env);
    if (env.get(name) !== value) dirty = true;
    env.set(name, value);
  }
  if (!dirty) return null;
  // Substitute $var in the original command (use-side; preserve unknowns).
  const folded = command.replace(VAR_USE_RE, (whole, n) => env.get(n) ?? whole);
  if (folded === command) return null;
  return { fragments: [folded] };
});

// ---------------------------------------------------------------------------
// U11 — indirect executor: xargs / find -exec / parallel / watch / time / env
// ---------------------------------------------------------------------------

const FIND_EXEC_RE = /\bfind\s+\S[^\n]*?-exec\s+/g;
const XARGS_RE = /\bxargs\s+(?:-[a-zA-Z]+(?:\s+\S+)?\s+)*/g;
const SIMPLE_PREFIX_RE = /\b(?:parallel|watch|time|env)\s+/g;

register('u11-indirect', (command: string) => {
  const fragments: string[] = [];

  for (const m of allMatches(command, FIND_EXEC_RE)) {
    const after = command.slice(m.index + m[0].length);
    // Run until `\;` or `+`
    const stop = after.search(/\\;|\s\+/);
    const cmd = stop > 0 ? after.slice(0, stop) : after;
    if (cmd.trim()) fragments.push(cmd.trim());
  }

  for (const m of allMatches(command, XARGS_RE)) {
    const after = command.slice(m.index + m[0].length);
    const stop = after.search(/[;|&\n]/);
    const cmd = stop > 0 ? after.slice(0, stop) : after;
    if (cmd.trim()) fragments.push(cmd.trim());
  }

  for (const m of allMatches(command, SIMPLE_PREFIX_RE)) {
    const after = command.slice(m.index + m[0].length);
    const stop = after.search(/[;|&\n]/);
    const cmd = stop > 0 ? after.slice(0, stop) : after;
    if (cmd.trim()) fragments.push(cmd.trim());
  }

  return fragments.length ? { fragments } : null;
});

// ---------------------------------------------------------------------------
// U12 — remote shell pass-through (ssh, docker exec, kubectl exec, podman exec)
// ---------------------------------------------------------------------------

const SSH_RE = /\bssh\s+(?:-[a-zA-Z]+\s*\S*\s+)*\S+\s+/g;
const CONTAINER_EXEC_RE = /\b(?:docker|podman)\s+exec\s+(?:-[a-zA-Z]+\s*\S*\s+)*\S+\s+/g;
const KUBECTL_EXEC_RE = /\bkubectl\s+exec\s+\S+\s+(?:-[a-zA-Z]+\s+)*--\s+/g;

register('u12-remote-shell', (command: string) => {
  const fragments: string[] = [];
  const tryExtract = (re: RegExp) => {
    for (const m of allMatches(command, re)) {
      const start = m.index + m[0].length;
      const inner = extractQuotedOrToken(command, start);
      if (inner && inner.value) fragments.push(inner.value);
    }
  };
  tryExtract(SSH_RE);
  tryExtract(CONTAINER_EXEC_RE);
  tryExtract(KUBECTL_EXEC_RE);
  return fragments.length ? { fragments, flags: { remote: true } } : null;
});

// ---------------------------------------------------------------------------
// U13 — editor escape: `vim -c '!X'`, `nvim -c '!X'`, `ed/ex -c '!X'`
// ---------------------------------------------------------------------------

const EDITOR_RE = /\b(?:vim|nvim|ed|ex)\s+(?:[A-Za-z0-9-]+\s+)*-c\s+/g;

register('u13-editor', (command: string) => {
  const fragments: string[] = [];
  for (const m of allMatches(command, EDITOR_RE)) {
    const inner = extractQuotedOrToken(command, m.index + m[0].length);
    if (!inner || !inner.value) continue;
    // Strip leading `!` (vim shell escape)
    const v = inner.value.startsWith('!') ? inner.value.slice(1) : inner.value;
    if (v) fragments.push(v);
  }
  return fragments.length ? { fragments } : null;
});

// ---------------------------------------------------------------------------
// U14 — build/orchestration inline shell (best-effort)
// ---------------------------------------------------------------------------

const ANSIBLE_SHELL_RE = /\bansible(?:-playbook)?\s+(?:[^\n]*?)\s-a\s+/g;
const MAKE_STDIN_RE = /\bmake\s+(?:-[a-zA-Z]+\s+)*-f\s+(?:\/dev\/stdin|-)/g;

register('u14-build-inline', (command: string) => {
  const fragments: string[] = [];
  for (const m of allMatches(command, ANSIBLE_SHELL_RE)) {
    const inner = extractQuotedOrToken(command, m.index + m[0].length);
    if (inner && inner.value) fragments.push(inner.value);
  }
  for (const m of allMatches(command, MAKE_STDIN_RE)) {
    // `make -f /dev/stdin <<<'all:; X'` — the `X` is in the heredoc body
    // (already extracted by U4). No additional extraction here.
    const _ = m;
    void _;
  }
  return fragments.length ? { fragments } : null;
});

// ---------------------------------------------------------------------------
// U15 — background / scheduling pass-through
// ---------------------------------------------------------------------------

const BG_PREFIX_RE = /\b(?:nohup|setsid|systemd-run(?:\s+(?:-[a-zA-Z]+|--user))*)\s+/g;
const AT_BATCH_RE = /\b(?:at|batch)\s+/g;
const LAUNCHCTL_BSEXEC_RE = /\blaunchctl\s+bsexec\s+\S+\s+/g;

register('u15-background', (command: string) => {
  const fragments: string[] = [];

  // Identify backgrounded inner command
  for (const m of allMatches(command, BG_PREFIX_RE)) {
    const after = command.slice(m.index + m[0].length);
    const stop = after.search(/[;|&\n]/);
    const cmd = stop > 0 ? after.slice(0, stop) : after;
    if (cmd.trim()) fragments.push(cmd.trim());
  }

  for (const m of allMatches(command, LAUNCHCTL_BSEXEC_RE)) {
    const after = command.slice(m.index + m[0].length);
    const stop = after.search(/[;|&\n]/);
    const cmd = stop > 0 ? after.slice(0, stop) : after;
    if (cmd.trim()) fragments.push(cmd.trim());
  }

  // `at <<<'X'` / `batch <<<'X'` → here-string already produced by U4.
  // `at - <<EOF\nX\nEOF` likewise via U4's heredoc.
  // Just a no-op marker here; flag propagation is the value.
  for (const _ of allMatches(command, AT_BATCH_RE)) {
    void _;
  }

  // Trailing `&` / `disown` are flag-only (no extraction required).
  if (/[^&]&\s*$/.test(command) || /\bdisown\b/.test(command)) {
    return { fragments, flags: { background: true } };
  }

  return fragments.length ? { fragments, flags: { background: true } } : null;
});

// ---------------------------------------------------------------------------
// U16 — compile-and-run pass-through. The compiled binary's runtime
// behaviour is not statically inspectable; flag the fragment as
// `compiled=true` so downstream detectors emit audit-only.
// ---------------------------------------------------------------------------

const COMPILE_RE =
  /\b(?:gcc|clang|cc|g\+\+|c\+\+|go\s+run|rustc)\s+(?:-[a-zA-Z+]+(?:\s+\S+)?\s+)*(?:-x\s+\S+\s+)?(?:-o\s+\S+\s+)?-?(?:\s|$)/g;

register('u16-compile-run', (command: string) => {
  if (COMPILE_RE.test(command)) {
    COMPILE_RE.lastIndex = 0;
    return { fragments: [], flags: { compiled: true } };
  }
  return null;
});
