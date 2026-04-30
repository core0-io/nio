# MCP Tool Routing

How Nio routes MCP tool calls — direct and indirect — through the
existing `available_tools.mcp` / `blocked_tools.mcp` allowlist at
Phase 0.

This document is the canonical reference for the routing model. For
the broader pipeline see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Overview

An agent can drive an MCP server two ways:

1. **Direct call** — the agent invokes the platform's MCP tool surface,
   e.g. `mcp__hass__HassTurnOff` (Claude Code) or `hass__HassTurnOff`
   (OpenClaw / Hermes — both use the `<server>__<tool>` separator).
   Phase 0 sees the tool name, parses `{server, tool}`, and checks the
   allowlist. Direct calls have always worked.

2. **Indirect call** — the agent invokes an *allowed* tool (most often
   `Bash`) and uses its content to talk to the MCP server: shelling out
   via `mcporter`, POSTing JSON-RPC over `curl`, piping into the server
   binary in stdio mode, running a packaged CLI, etc. From the platform's
   point of view the tool name is just `Bash`, so without further
   inspection the indirect call escapes the allowlist.

The indirect path is closed by adding **content detection at Phase 0**:
unwrap nested forms, run detectors against each fragment, map every hit
back to `{server, tool}` via the endpoint registry, and feed the
candidates into the same allowlist check the direct path uses. **The
policy layer is unchanged** — there is one allowlist; we just teach
Phase 0 to see more sources of evidence.

---

## Capture Model

```
┌──────────────────────────────────────────────────────────────────────┐
│  Phase 0: checkToolGate(toolName, toolInput, config, registry)       │
└────────────────────────────────────────┬─────────────────────────────┘
                                         │
                ┌────────────────────────┴──────────────────────┐
                ▼                                                ▼
       ┌─────────────────┐                             ┌──────────────────┐
       │ Direct call     │                             │ Indirect call    │
       │ parseMcpToolName│                             │ extractCommand   │
       │ → {server,tool} │                             │ → command string │
       └────────┬────────┘                             └─────────┬────────┘
                │                                                 │
                │                              ┌──────────────────▼─────┐
                │                              │ Stage 1: unwrapCommand │
                │                              │ U1-U16 (recursive)     │
                │                              └──────────────────┬─────┘
                │                                                 │
                │                              ┌──────────────────▼─────┐
                │                              │ Stage 2: runDetectors  │
                │                              │ D1-D16 (per-fragment)  │
                │                              └──────────────────┬─────┘
                │                                                 │
                │                              ┌──────────────────▼─────┐
                │                              │ Filter audit-only      │
                │                              │ (D12, D15, D16)        │
                │                              └──────────────────┬─────┘
                │                                                 │
                ▼                                                 ▼
            ┌────────────────────────────────────────────────────────┐
            │ Combined candidate list →                              │
            │   available_tools.mcp / blocked_tools.mcp              │
            └────────────────────────────────────────────────────────┘
```

`Stage 1: unwrap` recursively peels off shells, heredocs, evals,
encodings, package wrappers, and remote-shell prefixes until each
fragment is plain enough that a detector can match it. Pass-through
flags (`remote`, `background`, `compiled`) propagate from outer wrappers
to inner fragments so the audit log can name the channel.

`Stage 2: detect` runs every detector against every fragment. Each
detector is independent — they do not see one another's output. Hits
become `RoutedMcpCall { server, tool?, via, evidence, flags?, auditOnly? }`.

`Stage 3: gate` flattens hits to `{tool, server__tool}` candidates,
filters out audit-only hits, and runs the existing allowlist check.

---

## MCP Endpoint Registry

For Stage 2 to know that `http://localhost:5173/mcp` *is* an MCP server,
Phase 0 loads a registry on hook entry. Sources are auto-discovered from
the user's existing MCP configurations:

| Source | Path |
|---|---|
| Claude Code | `~/.claude.json` `mcpServers.*` |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS), `$XDG_CONFIG_HOME/Claude/`, `%APPDATA%\Claude\` |
| Hermes | `~/.hermes/config.yaml` `mcp_servers.*` |
| OpenClaw | `~/.openclaw/openclaw.json` `mcp.servers.*` |
| Manual override | `~/.nio/config.yaml` `guard.mcp_endpoints.*` |

Every registered server is indexed by every reachable handle:

```ts
type MCPServerEntry = {
  serverName: string
  urls:        string[]   // http(s)://, ws(s)://
  sockets:     string[]   // unix socket paths
  binaries:    string[]   // mcp-server-X, X-mcp
  cliPackages: string[]   // @scope/mcp-cli, npx package names
  source:      'claude' | 'claude_desktop' | 'hermes' | 'openclaw' | 'manual'
}
```

Lookups are exposed as `lookupByUrl()`, `lookupBySocket()`,
`lookupByBinary()`, `lookupByCliPackage()`. URLs are normalized
(host lower-cased, trailing slash stripped); origin matching captures
sub-paths of the registered URL. Binary and package lookups are
case-insensitive and basename-aware.

Caching: per-source mtime. The registry is cheap to call on every hook
entry; only changed sources re-parse.

---

## Stage 1 — Unwrappers (U1-U16)

Each unwrapper takes a command string and either returns inner fragments
or emits flags that decorate the current fragment. The driver recurses
on inner fragments up to `MAX_UNWRAP_DEPTH = 8`.

| # | Channel | Example trigger |
|---|---|---|
| U1 | shell `-c` | `bash/sh/zsh/dash/ksh/fish/busybox -c "..."` |
| U2 | variable shell | `$SHELL/$BASH/${SHELL} -c "..."` |
| U3 | eval | `eval "..."`, `eval $(...)` |
| U4 | heredoc / here-string | `<<EOF...EOF`, `<<<'...'` |
| U5 | process substitution | `<(...)`, `>(...)` |
| U6 | command substitution | `$(...)`, backticks |
| U7 | source / script exec | `source <(...)`, `. <(...)`, `bash <(...)` |
| U8 | interpreter inline | `python/python3/node/bun/deno/ruby/perl/php/lua/Rscript/tclsh/osascript/pwsh -c\|-e\|-r\|--eval` (sets `inline=true`) |
| U9 | encoded-pipe decoder | `<echo\|printf\|cat> '<b64>' \| base64 -d \| <interp>`, `xxd -r -p`, `openssl base64 -d` |
| U10 | string-concat / variable folding | `c=cu; c=$c"rl"; $c URL` (best-effort static fold) |
| U11 | indirect executor | `xargs <cmd>`, `find -exec <cmd>`, `parallel/watch/time/env <cmd>` |
| U12 | remote shell | `ssh user@host '...'`, `docker exec C ...`, `kubectl exec ... -- ...`, `podman exec ...` (sets `remote=true`) |
| U13 | editor escape | `vim/nvim/ed/ex -c '!...'`, `emacs --batch ...` |
| U14 | build/orchestration inline shell | `make -f /dev/stdin`, `ansible -m shell -a '...'` |
| U15 | background / scheduled | `nohup ... &`, trailing `&`, `disown`, `setsid`, `at <<<'...'`, `crontab -`, `systemd-run ...`, `launchctl bsexec ...` (sets `background=true`) |
| U16 | compile-and-run | `gcc/clang -x c -; ./a.out`, `go run -`, `rustc -; ./a` (sets `compiled=true`) |

Composition: layers stack freely. `bash -c "echo <b64> \| base64 -d \| sh"` is unwrapped through U1 → U9 → final fragment, and any detector that matches the final fragment is attributed correctly.

---

## Stage 2 — Detectors (D1-D16)

Each detector consumes one `UnwrappedFragment` and emits zero or more
`RoutedMcpCall`. D2-D11 require the registry to map handles to server
names; D1 (mcporter) parses the target out of the command directly.

| # | Channel | Match rule | `via` tag |
|---|---|---|---|
| D1 | mcporter CLI | `mcporter [call] <server>.<tool>` (incl. `npx mcporter`, absolute paths, after separators) | `mcporter` |
| D2 | curl-class | `curl/wget/aria2c/fetch/lwp-request` hitting registry URL or `--unix-socket` | `http_client` |
| D3 | HTTPie-class | `http/https/httpie/xh [METHOD]? URL` hitting registry URL | `httpie` |
| D4 | TCP / socket multiplex | `nc/netcat/ncat/socat/openssl s_client/websocat/grpcurl` host:port or `-U /sock` | `tcp_socket` |
| D5 | Bash builtin networking | `/dev/tcp/<host>/<port>`, `/dev/udp/...`, `exec N<>/dev/tcp/...` | `dev_tcp` |
| D6 | PowerShell HTTP | `Invoke-WebRequest`, `Invoke-RestMethod`, `System.Net.WebClient`, `HttpClient` URL | `pwsh_http` |
| D7 | Language-runtime HTTP | URL literals inside U8 inline code (urllib/requests/httpx, fetch/http.request, Net::HTTP/open-uri, LWP, file_get_contents/curl_exec/fsockopen, deno/bun fetch, net/http, reqwest) | `language_runtime` |
| D8 | Stdio JSON-RPC pipe | `<echo\|printf\|cat\|jq\|tee\|yes> ... \| <bin>` where bin matches a registry binary | `stdio_pipe` |
| D9 | Stdin redirect | `<bin> < file.json`, `<bin> <<EOF`, `<bin> <<<'json'` | `stdin_redirect` |
| D10 | FIFO / named pipe | `mkfifo PATH; <bin> < PATH &; ... > PATH` | `fifo` |
| D11 | Package runners | `npx/bunx/pnpm dlx\|exec/yarn dlx\|exec/pipx run/uv run/uvx/deno run/go run <pkg>` against registry CLI packages | `package_runner` |
| D12 | MCP server self-launch — **audit-only** | `<registry-binary> --transport http\|sse`, `--port`, `--listen`, `--bind`, `--host`, `--address` | `self_launch` |
| D13 | Remote-shell pass-through | Emergent from U12 — `flags.remote=true` on any inner D2-D11 hit | (carried by `flags`) |
| D14 | Background pass-through | Emergent from U15 — `flags.background=true` | (carried by `flags`) |
| D15 | Compile-and-run — **audit-only** | Fragment carries `flags.compiled=true` (from U16); compiled binary's runtime is opaque | `compiled` |
| D16 | Obfuscation fallback — **audit-only** | Registry URL or binary literal appears in fragment text without any other detector firing | `obfuscation_fallback` |

### Conservative Fallback

When a detector resolves a `server` but cannot resolve a `tool` (e.g.
the JSON-RPC body isn't statically parseable), Phase 0 treats the call
as a "whole-server invocation" — i.e. the candidate is `${server}__*`,
which fails any `available_tools.mcp` allowlist that doesn't whitelist
the server entire. This biases toward denial when in doubt.

### Audit-Only Detectors

D12, D15, and D16 emit `RoutedMcpCall { auditOnly: true }`. Phase 0
filters these out before the allowlist check — they inform the audit
log but never deny:

- **D12** because dev workflows commonly start a local MCP server.
- **D15** because compile-and-run is a normal build pattern; the
  compiled binary's *runtime* HTTP behaviour is properly an OS-sandbox
  concern.
- **D16** because the fallback is heuristic and prone to false
  positives; flagging is informational.

---

## Sensitive-Path Write Protection

The detector pipeline can be sidestepped if the agent registers a new
MCP server (changing the registry under our feet) or installs a
persistence hook that runs at next launch. To close those holes,
`SENSITIVE_FILE_PATHS` rejects writes to the relevant paths
unconditionally:

**MCP configuration:**
- `.claude.json`, `.claude/mcp*`
- `Library/Application Support/Claude/claude_desktop_config.json`
- `AppData/Roaming/Claude/claude_desktop_config.json`
- `.config/Claude/claude_desktop_config.json`
- `.hermes/config.yaml`, `.hermes/plugins/`
- `.openclaw/openclaw.json`, `.openclaw/`

**Persistence channels:**
- `Library/LaunchAgents/`, `Library/LaunchDaemons/`
- `etc/cron.*`, `var/spool/cron/`
- `.config/systemd/user/`, `etc/systemd/system/`
- `.bashrc`, `.zshrc`, `.profile`, `.bash_profile`, `.zprofile`, `.zshenv`
- `authorized_keys`

`write_file` actions hitting any of these → critical reject, regardless
of content. This is purely additive hardening — no detector logic.

---

## Protection Boundary

The shell-pattern layer cannot be 100% — that's a mathematical limit,
not an implementation gap:

1. **Off-registry self-launch.** D12 attributes self-launch only when
   the binary is in the registry. Agent self-builds a private MCP
   binary (`./my-mcp --port 9999`); we don't know which server owns
   that port. Mitigation: audit unknown listen-on-port. Full prevention
   needs network-namespace isolation.
2. **Compile-and-run.** Network calls inside a freshly compiled binary
   are invisible to static analysis (D15 only audits). Mitigation: OS
   sandbox (`sandbox-exec`, seccomp, Bubblewrap).
3. **Off-registry remote MCPs.** SaaS MCP server not declared anywhere
   is unrecognizable. Mitigation: declare via
   `guard.mcp_endpoints` — or block all unknown remote MCPs.
4. **Brand-new protocols.** QUIC, custom binary protocols, future HTTP
   client tooling — out of pattern coverage. Mitigation: detector list
   is maintained; OS sandbox as backstop.
5. **DNS rebinding / indirect addressing.** Agent manipulates local DNS
   so a registry hostname resolves elsewhere (rare but theoretical).
   Mitigation: `/etc/hosts` writes are blocked; resolution-layer escape
   is beyond shell-pattern detection.

For genuinely high-assurance deployments, pair Nio with OS isolation:

- **macOS:** `sandbox-exec -p '(version 1)(deny default)(allow file-read* (subpath "/path/..."))(deny network*)' <agent>`
- **Linux:** seccomp / Bubblewrap / firejail / `unshare --net`
- **Containers:** `--network none` + only whitelisted unix sockets exposed

Nio's detection layer is positioned as **"catches every common misuse
and known bypass"**, not a replacement for OS sandboxing. The two
together get you closest to hard isolation.
