// Copyright 2026 core0-io
// SPDX-License-Identifier: Apache-2.0

/**
 * Stage 2 — per-fragment detectors.
 *
 * Each detector takes a flat command fragment (already unwrapped by Stage
 * 1) and emits zero or more `RoutedMcpCall`. Subsequent commits will add
 * D2-D16; this commit only contains D1 (mcporter, migrated from the
 * previous mcp-shell-detect module).
 */

import type { RoutedMcpCall, UnwrappedFragment } from './types.js';
import type { MCPRegistry, MCPServerEntry } from '../mcp-registry.js';

const MCPORTER_RE = /\bmcporter\b/g;
const SHELL_SEP_RE = /[;&|\n]/;
const SERVER_TOOL_RE = /^([a-zA-Z][\w-]*)\.([a-zA-Z][\w-]*)/;

/**
 * D1 — mcporter CLI invocations. Matches `mcporter [call] <server>.<tool>`,
 * `npx mcporter ...`, `bunx mcporter ...`, absolute paths to mcporter, etc.
 * Skips the optional `call` verb and any flags (`-x`, `--flag`, `--flag=v`,
 * `--`).
 */
export function detectMcporter(fragment: UnwrappedFragment): RoutedMcpCall[] {
  const command = fragment.command;
  if (!command || !command.includes('mcporter')) return [];

  const results: RoutedMcpCall[] = [];
  MCPORTER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MCPORTER_RE.exec(command)) !== null) {
    const startAfter = match.index + match[0].length;
    const rest = command.slice(startAfter);
    const sep = rest.match(SHELL_SEP_RE);
    const segment = sep ? rest.slice(0, sep.index) : rest;
    const hit = parseMcporterSegment(segment);
    if (hit) {
      results.push({
        server: hit.server,
        tool: hit.tool,
        via: 'mcporter',
        evidence: 'mcporter ' + segment.trim(),
        flags: fragment.flags,
      });
    }
  }
  return results;
}

interface McporterTarget { server: string; tool: string; }

function parseMcporterSegment(segment: string): McporterTarget | null {
  const tokens = segment.trim().split(/\s+/).filter((t) => t.length > 0);
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];

    if (tok === '--') {
      return i + 1 < tokens.length ? parseMcporterTarget(tokens[i + 1]) : null;
    }

    if (tok === 'call') { i++; continue; }

    if (tok.startsWith('-')) {
      if (tok.includes('=')) { i++; continue; }
      // Flag without `=`: consume the next non-flag token as its value.
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith('-') && tokens[i + 1] !== '--') {
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    return parseMcporterTarget(tok);
  }
  return null;
}

function parseMcporterTarget(raw: string): McporterTarget | null {
  let t = raw;
  if (t.startsWith("'") || t.startsWith('"')) t = t.slice(1);
  if (t.endsWith("'") || t.endsWith('"')) t = t.slice(0, -1);
  const paren = t.indexOf('(');
  if (paren >= 0) t = t.slice(0, paren);
  const m = t.match(SERVER_TOOL_RE);
  return m ? { server: m[1], tool: m[2] } : null;
}

// ---------------------------------------------------------------------------
// Helpers — URL / JSON parsing
// ---------------------------------------------------------------------------

const HTTP_URL_RE = /\bhttps?:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+/g;
const WS_URL_RE = /\bwss?:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+/g;

/** Extract every URL literal from a fragment (http(s) and ws(s)). */
function extractUrls(text: string): string[] {
  const urls: string[] = [];
  HTTP_URL_RE.lastIndex = 0;
  WS_URL_RE.lastIndex = 0;
  for (const m of text.matchAll(HTTP_URL_RE)) urls.push(m[0]);
  for (const m of text.matchAll(WS_URL_RE)) urls.push(m[0]);
  return urls;
}

/** Try to pull a JSON-RPC `params.name` (the MCP tool name) out of a body string. */
function extractToolFromJsonBody(body: string): string | undefined {
  if (!body) return undefined;
  // Greedy scan for {...} substrings; parse each. Cheap heuristic; intentionally
  // ignores escaped quotes since the goal is best-effort attribution.
  const open = body.indexOf('{');
  if (open === -1) return undefined;
  for (let depth = 1, i = open + 1; i < body.length; i++) {
    if (body[i] === '\\') { i++; continue; }
    if (body[i] === '{') depth++;
    else if (body[i] === '}') {
      depth--;
      if (depth === 0) {
        const slice = body.slice(open, i + 1);
        try {
          const obj = JSON.parse(slice) as Record<string, unknown>;
          const params = obj['params'] as Record<string, unknown> | undefined;
          if (params && typeof params['name'] === 'string') return params['name'] as string;
          if (typeof obj['name'] === 'string') return obj['name'] as string;
          if (typeof obj['tool'] === 'string') return obj['tool'] as string;
        } catch {
          // ignore
        }
        // Try to find a later top-level object
        const next = body.indexOf('{', i + 1);
        if (next === -1) return undefined;
        i = next;
        depth = 1;
        continue;
      }
    }
  }
  return undefined;
}

/** Take a token string ($'...' / "..." / unquoted) and unwrap surrounding quotes. */
function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/** Tokenize a command string honoring quoted segments. */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < command.length) {
    while (i < command.length && /[ \t\n]/.test(command[i])) i++;
    if (i >= command.length) break;
    const ch = command[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let buf = ch;
      while (j < command.length && command[j] !== ch) {
        if (command[j] === '\\' && ch === '"' && j + 1 < command.length) { buf += command[j] + command[j + 1]; j += 2; continue; }
        buf += command[j];
        j++;
      }
      if (j < command.length) buf += command[j];
      tokens.push(buf);
      i = j + 1;
    } else {
      let j = i;
      while (j < command.length && !/[ \t\n]/.test(command[j])) {
        if (command[j] === '"' || command[j] === "'") {
          const q = command[j];
          j++;
          while (j < command.length && command[j] !== q) {
            if (command[j] === '\\' && q === '"' && j + 1 < command.length) { j += 2; continue; }
            j++;
          }
          if (j < command.length) j++;
        } else j++;
      }
      tokens.push(command.slice(i, j));
      i = j;
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// D2 — curl / wget / aria2c / fetch / lwp-request
// ---------------------------------------------------------------------------

const CURL_CLASS_BIN = new Set([
  'curl', 'wget', 'aria2c', 'fetch', 'lwp-request',
]);

/** Walk curl-style argv and pull out (url, body, socket). */
function parseCurlArgs(tokens: string[]): { url?: string; body?: string; socket?: string } {
  let url: string | undefined;
  let body: string | undefined;
  let socket: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--unix-socket' || t === '--abstract-unix-socket') {
      const v = tokens[i + 1];
      if (v) socket = stripQuotes(v);
      i++;
      continue;
    }
    if (t.startsWith('--unix-socket=')) { socket = stripQuotes(t.slice('--unix-socket='.length)); continue; }
    if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary' || t === '--data-urlencode' || t === '--post-data' || t === '--post-file') {
      const v = tokens[i + 1];
      if (v) body = stripQuotes(v);
      i++;
      continue;
    }
    if (t.startsWith('--data=') || t.startsWith('--data-raw=') || t.startsWith('--data-binary=') || t.startsWith('--data-urlencode=')) {
      body = stripQuotes(t.slice(t.indexOf('=') + 1));
      continue;
    }
    if (t.startsWith('--post-data=')) { body = stripQuotes(t.slice('--post-data='.length)); continue; }
    if (t.startsWith('-')) continue;
    // Heuristic: first non-flag token that looks like a URL
    if (!url && /^https?:\/\//.test(t)) url = stripQuotes(t);
  }
  return { url, body, socket };
}

/** Infer the http(s) URL from a unix socket reference (curl emits a host that
 *  is irrelevant; we rely on socket path). */
function lookupSocketServer(registry: MCPRegistry, socket: string): MCPServerEntry | null {
  return registry.lookupBySocket(socket);
}

export function detectCurlClass(fragment: UnwrappedFragment, registry: MCPRegistry): RoutedMcpCall[] {
  if (fragment.inline) return [];
  const command = fragment.command;
  if (!command) return [];

  const results: RoutedMcpCall[] = [];
  const tokens = tokenize(command);

  // Walk the token stream, finding each invocation of a curl-class binary
  for (let i = 0; i < tokens.length; i++) {
    const tok = stripQuotes(tokens[i]);
    if (!CURL_CLASS_BIN.has(tok.split('/').pop() || tok)) continue;

    // Take this and following tokens up to a shell separator. We approximate
    // separators using bare tokens of ; | && || & — but tokenize already
    // discarded those as part of unquoted tokens. So re-find by scanning the
    // raw command from the position of this token.
    const pos = command.indexOf(tok, i === 0 ? 0 : 0);
    void pos;
    // For simplicity here, take all subsequent tokens until end-of-array.
    const argv = tokens.slice(i + 1);

    const { url, body, socket } = parseCurlArgs(argv);
    let entry: MCPServerEntry | null = null;
    if (url) entry = registry.lookupByUrl(url);
    if (!entry && socket) entry = lookupSocketServer(registry, socket);
    if (!entry) continue;

    const tool = body ? extractToolFromJsonBody(body) : undefined;
    results.push({
      server: entry.serverName,
      tool,
      via: 'http_client',
      evidence: tok + (url ? ' ' + url : '') + (socket ? ' --unix-socket ' + socket : ''),
      flags: fragment.flags,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// D3 — HTTPie-class (http / https / httpie / xh)
// ---------------------------------------------------------------------------

const HTTPIE_BIN = new Set(['http', 'https', 'httpie', 'xh']);
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

export function detectHttpie(fragment: UnwrappedFragment, registry: MCPRegistry): RoutedMcpCall[] {
  if (fragment.inline) return [];
  const command = fragment.command;
  const tokens = tokenize(command);
  const results: RoutedMcpCall[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = stripQuotes(tokens[i]);
    if (!HTTPIE_BIN.has(tok)) continue;
    let url: string | undefined;
    let body: string | undefined;
    for (let j = i + 1; j < tokens.length; j++) {
      const arg = stripQuotes(tokens[j]);
      if (HTTP_METHODS.has(arg.toUpperCase())) continue;
      if (arg.startsWith('-')) continue;
      if (/^https?:\/\//.test(arg)) { url = arg; }
      else if (/=/.test(arg) && !arg.startsWith('http')) {
        // HTTPie body field shorthand: name=value, name:=jsonValue
        const sep = arg.indexOf(':=');
        if (sep > 0) {
          const k = arg.slice(0, sep);
          const v = arg.slice(sep + 2);
          if (k === 'name' || k === 'tool') body = (body || '') + `{"name":${v}}`;
        }
      }
    }
    if (!url) continue;
    const entry = registry.lookupByUrl(url);
    if (!entry) continue;
    results.push({
      server: entry.serverName,
      tool: body ? extractToolFromJsonBody(body) : undefined,
      via: 'httpie',
      evidence: tok + ' ' + url,
      flags: fragment.flags,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// D4 — TCP / socket multiplexers (nc / netcat / ncat / socat / openssl s_client / websocat / grpcurl)
// ---------------------------------------------------------------------------

const TCP_BIN = new Set(['nc', 'netcat', 'ncat', 'socat', 'websocat', 'grpcurl']);
const HOST_PORT_RE = /^(?!--)([A-Za-z0-9.-]+):(\d+)$/;

export function detectTcpSocket(fragment: UnwrappedFragment, registry: MCPRegistry): RoutedMcpCall[] {
  if (fragment.inline) return [];
  const command = fragment.command;
  const tokens = tokenize(command);
  const results: RoutedMcpCall[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = stripQuotes(tokens[i]);
    const base = tok.split('/').pop() || tok;
    const isOpenssl = base === 'openssl' && tokens[i + 1] === 's_client';
    if (!TCP_BIN.has(base) && !isOpenssl) continue;

    let host: string | undefined;
    let port: string | undefined;
    let socket: string | undefined;
    let url: string | undefined;
    const argv = tokens.slice(isOpenssl ? i + 2 : i + 1);

    for (let j = 0; j < argv.length; j++) {
      const a = stripQuotes(argv[j]);
      if (a === '-U' || a === '--unix-socket') { socket = stripQuotes(argv[j + 1] || ''); j++; continue; }
      if (a.startsWith('-U=') || a.startsWith('--unix-socket=')) { socket = stripQuotes(a.split('=')[1]); continue; }
      if (a === '-connect') { const hp = (argv[j + 1] || ''); j++; const m = hp.match(HOST_PORT_RE); if (m) { host = m[1]; port = m[2]; } continue; }
      if (a.startsWith('-connect=')) { const m = a.slice('-connect='.length).match(HOST_PORT_RE); if (m) { host = m[1]; port = m[2]; } continue; }
      if (a.startsWith('-')) continue;
      // socat target: TCP:host:port or UNIX-CONNECT:/path
      const tcpPrefixed = /^(?:TCP|TCP4|TCP6|TCP-CONNECT|TCP4-CONNECT|SSL):([^:]+):(\d+)/i.exec(a);
      if (tcpPrefixed) { host = tcpPrefixed[1]; port = tcpPrefixed[2]; continue; }
      const unixPrefixed = /^(?:UNIX|UNIX-CONNECT|UNIX-SENDTO|UNIX-CLIENT):(\S+)/i.exec(a);
      if (unixPrefixed) { socket = unixPrefixed[1]; continue; }
      // websocat / grpcurl URL
      if (/^(?:wss?:\/\/|https?:\/\/)/.test(a)) { url = a; continue; }
      // bare host port
      if (/^[A-Za-z0-9.-]+$/.test(a) && !host) host = a;
      else if (/^\d+$/.test(a) && host && !port) port = a;
    }

    let entry: MCPServerEntry | null = null;
    if (url) entry = registry.lookupByUrl(url);
    else if (socket) entry = registry.lookupBySocket(socket);
    else if (host && port) entry = registry.lookupByUrl(`http://${host}:${port}/`);
    if (!entry) continue;

    results.push({
      server: entry.serverName,
      via: 'tcp_socket',
      evidence: tok + (host ? ` ${host}:${port ?? ''}` : socket ? ` -U ${socket}` : url ? ` ${url}` : ''),
      flags: fragment.flags,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// D5 — Bash builtin networking (/dev/tcp / /dev/udp / FD redirection)
// ---------------------------------------------------------------------------

const DEV_TCP_RE = /\/dev\/(?:tcp|udp)\/([A-Za-z0-9.-]+)\/(\d+)/g;

export function detectDevTcp(fragment: UnwrappedFragment, registry: MCPRegistry): RoutedMcpCall[] {
  if (fragment.inline) return [];
  const results: RoutedMcpCall[] = [];
  for (const m of fragment.command.matchAll(DEV_TCP_RE)) {
    const host = m[1];
    const port = m[2];
    const entry = registry.lookupByUrl(`http://${host}:${port}/`);
    if (!entry) continue;
    results.push({
      server: entry.serverName,
      via: 'dev_tcp',
      evidence: m[0],
      flags: fragment.flags,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// D6 — PowerShell HTTP — runs over inline PowerShell code
// ---------------------------------------------------------------------------

const PWSH_HTTP_RE = /\b(?:Invoke-WebRequest|Invoke-RestMethod|System\.Net\.WebClient|System\.Net\.Http\.HttpClient)\b/;

export function detectPwshHttp(fragment: UnwrappedFragment, registry: MCPRegistry): RoutedMcpCall[] {
  // PowerShell code may reach detectors via U8 (inline=true) or as raw shell tokens.
  if (!PWSH_HTTP_RE.test(fragment.command)) return [];
  const results: RoutedMcpCall[] = [];
  for (const url of extractUrls(fragment.command)) {
    const entry = registry.lookupByUrl(url);
    if (!entry) continue;
    results.push({
      server: entry.serverName,
      via: 'pwsh_http',
      evidence: url,
      flags: fragment.flags,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// D7 — Language-runtime HTTP (URL literals inside inline code)
// ---------------------------------------------------------------------------

export function detectLanguageRuntime(fragment: UnwrappedFragment, registry: MCPRegistry): RoutedMcpCall[] {
  if (!fragment.inline) return [];
  const results: RoutedMcpCall[] = [];
  for (const url of extractUrls(fragment.command)) {
    const entry = registry.lookupByUrl(url);
    if (!entry) continue;
    results.push({
      server: entry.serverName,
      via: 'language_runtime',
      evidence: url,
      flags: fragment.flags,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// D8 — Stdio JSON-RPC injection: `<echo|printf|cat|jq|tee|yes> ... | <bin>`
// ---------------------------------------------------------------------------

const STDIO_FEEDERS = new Set(['echo', 'printf', 'cat', 'jq', 'tee', 'yes']);

/** Split a command into shell pipeline stages, naive but quote-aware. */
function splitPipeline(command: string): string[] {
  const parts: string[] = [];
  let buf = '';
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (ch === '\\' && i + 1 < command.length) { buf += ch + command[i + 1]; i += 2; continue; }
    if (ch === '"' || ch === "'") {
      const q = (() => {
        let j = i + 1;
        while (j < command.length && command[j] !== ch) {
          if (command[j] === '\\' && ch === '"' && j + 1 < command.length) { j += 2; continue; }
          j++;
        }
        return j < command.length ? j + 1 : command.length;
      })();
      buf += command.slice(i, q);
      i = q;
      continue;
    }
    if (ch === '|' && command[i + 1] !== '|') { parts.push(buf); buf = ''; i++; continue; }
    buf += ch;
    i++;
  }
  if (buf.trim()) parts.push(buf);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Pull the body string from `echo ARGS` / `printf 'fmt' args` / `cat <file>` */
function extractFeederBody(stage: string): string | undefined {
  const tokens = tokenize(stage);
  if (tokens.length === 0) return undefined;
  const cmd = stripQuotes(tokens[0]);
  if (!STDIO_FEEDERS.has(cmd)) return undefined;
  // Concatenate non-flag args (best effort) to scan for JSON-RPC.
  const body = tokens.slice(1)
    .filter((t) => !t.startsWith('-'))
    .map((t) => stripQuotes(t))
    .join(' ');
  return body;
}

export function detectStdioPipe(fragment: UnwrappedFragment, registry: MCPRegistry): RoutedMcpCall[] {
  if (fragment.inline) return [];
  const stages = splitPipeline(fragment.command);
  if (stages.length < 2) return [];
  const last = stages[stages.length - 1];
  const lastTokens = tokenize(last);
  if (lastTokens.length === 0) return [];
  const binTok = stripQuotes(lastTokens[0]);
  const entry = registry.lookupByBinary(binTok);
  if (!entry) return [];

  // Walk earlier stages to find a feeder body for tool extraction
  let body = '';
  for (const stage of stages.slice(0, -1)) {
    const fb = extractFeederBody(stage);
    if (fb) body += ' ' + fb;
  }
  const tool = body ? extractToolFromJsonBody(body) : undefined;

  return [{
    server: entry.serverName,
    tool,
    via: 'stdio_pipe',
    evidence: fragment.command,
    flags: fragment.flags,
  }];
}

// ---------------------------------------------------------------------------
// D9 — Stdin redirect: `<bin> < file.json`, `<bin> <<EOF`, `<bin> <<<'json'`
// ---------------------------------------------------------------------------

const STDIN_REDIR_RE = /(?:^|[\s;|&])([A-Za-z][\w./-]*)\s*(?:<<<\s*('[^']*'|"[^"]*"|\S+)|<<-?\s*['"]?([A-Za-z_]\w*)['"]?|<\s*(\S+))/g;

export function detectStdinRedirect(fragment: UnwrappedFragment, registry: MCPRegistry): RoutedMcpCall[] {
  if (fragment.inline) return [];
  const command = fragment.command;
  const results: RoutedMcpCall[] = [];
  STDIN_REDIR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STDIN_REDIR_RE.exec(command)) !== null) {
    const bin = m[1];
    const entry = registry.lookupByBinary(bin);
    if (!entry) continue;
    let body: string | undefined;
    const here = m[2];
    if (here) body = stripQuotes(here);
    else if (m[3]) {
      // Heredoc body — find marker
      const marker = m[3];
      const after = command.slice(m.index + m[0].length);
      const closeRe = new RegExp('\\n' + marker.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '(?:\\n|$)');
      const cm = closeRe.exec('\n' + after);
      if (cm) body = after.slice(0, cm.index);
    } else if (m[4]) {
      // `< file.json` — file content not available statically
      body = undefined;
    }
    const tool = body ? extractToolFromJsonBody(body) : undefined;
    results.push({
      server: entry.serverName,
      tool,
      via: 'stdin_redirect',
      evidence: m[0].trim(),
      flags: fragment.flags,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// D10 — FIFO / named pipe: `mkfifo /tmp/p; <bin> < /tmp/p &; echo ... > /tmp/p`
// Best-effort cross-command pairing within a single fragment.
// ---------------------------------------------------------------------------

const MKFIFO_RE = /\bmkfifo\s+([^\s;|&]+)/g;
const FIFO_READER_RE = /\b([A-Za-z][\w./-]*)\s+<\s*([^\s;|&]+)/g;

export function detectFifo(fragment: UnwrappedFragment, registry: MCPRegistry): RoutedMcpCall[] {
  if (fragment.inline) return [];
  const command = fragment.command;
  const fifos = new Set<string>();
  for (const m of command.matchAll(MKFIFO_RE)) fifos.add(m[1]);
  if (fifos.size === 0) return [];

  const results: RoutedMcpCall[] = [];
  FIFO_READER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FIFO_READER_RE.exec(command)) !== null) {
    const bin = m[1];
    const path = m[2];
    if (!fifos.has(path)) continue;
    const entry = registry.lookupByBinary(bin);
    if (!entry) continue;
    results.push({
      server: entry.serverName,
      via: 'fifo',
      evidence: m[0],
      flags: fragment.flags,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// D11 — Package runners (npx/bunx/pnpm dlx/yarn dlx/pipx run/uv run/uvx/
//                       deno run/go run <pkg>)
// ---------------------------------------------------------------------------

interface RunnerSpec { runner: string; subcommand?: string; }
const PACKAGE_RUNNER_SPECS: RunnerSpec[] = [
  { runner: 'npx' },
  { runner: 'bunx' },
  { runner: 'pnpm', subcommand: 'dlx' },
  { runner: 'pnpm', subcommand: 'exec' },
  { runner: 'yarn', subcommand: 'dlx' },
  { runner: 'yarn', subcommand: 'exec' },
  { runner: 'pipx', subcommand: 'run' },
  { runner: 'uv', subcommand: 'run' },
  { runner: 'uvx' },
  { runner: 'deno', subcommand: 'run' },
  { runner: 'go', subcommand: 'run' },
];

export function detectPackageRunner(fragment: UnwrappedFragment, registry: MCPRegistry): RoutedMcpCall[] {
  if (fragment.inline) return [];
  const tokens = tokenize(fragment.command);
  const results: RoutedMcpCall[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = stripQuotes(tokens[i]);
    const spec = PACKAGE_RUNNER_SPECS.find((s) => s.runner === (tok.split('/').pop() || tok));
    if (!spec) continue;
    let j = i + 1;
    if (spec.subcommand) {
      while (j < tokens.length && stripQuotes(tokens[j]).startsWith('-')) j++;
      if (j >= tokens.length || stripQuotes(tokens[j]) !== spec.subcommand) continue;
      j++;
    }
    // Skip flags (e.g. `-y`, `--package=x`, `-p some`)
    while (j < tokens.length) {
      const t = stripQuotes(tokens[j]);
      if (!t.startsWith('-')) break;
      j++;
    }
    if (j >= tokens.length) continue;
    const pkg = stripQuotes(tokens[j]);
    const entry = registry.lookupByCliPackage(pkg);
    if (!entry) continue;

    // Best-effort tool name from following positional args (e.g. `mcporter call hass.HassTurnOff`)
    let tool: string | undefined;
    for (let k = j + 1; k < tokens.length; k++) {
      const t = stripQuotes(tokens[k]);
      if (t.startsWith('-')) continue;
      if (t === 'call') continue;
      const m = SERVER_TOOL_RE.exec(t);
      if (m) { tool = m[2]; break; }
      // Plain tool name fallback
      if (/^[A-Za-z][\w-]*$/.test(t)) { tool = t; break; }
    }

    results.push({
      server: entry.serverName,
      tool,
      via: 'package_runner',
      evidence: tok + (spec.subcommand ? ' ' + spec.subcommand : '') + ' ' + pkg,
      flags: fragment.flags,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/**
 * Run every detector against a fragment. Each fragment is independent;
 * detectors do not see each other's output.
 */
export function runDetectors(
  fragment: UnwrappedFragment,
  registry: MCPRegistry | null = null,
): RoutedMcpCall[] {
  const out: RoutedMcpCall[] = [];
  out.push(...detectMcporter(fragment));
  if (registry) {
    out.push(...detectCurlClass(fragment, registry));
    out.push(...detectHttpie(fragment, registry));
    out.push(...detectTcpSocket(fragment, registry));
    out.push(...detectDevTcp(fragment, registry));
    out.push(...detectPwshHttp(fragment, registry));
    out.push(...detectLanguageRuntime(fragment, registry));
    out.push(...detectStdioPipe(fragment, registry));
    out.push(...detectStdinRedirect(fragment, registry));
    out.push(...detectFifo(fragment, registry));
    out.push(...detectPackageRunner(fragment, registry));
  }
  return out;
}
