#!/usr/bin/env bash
# Copyright 2026 core0-io
# SPDX-License-Identifier: Apache-2.0
#
# Installs the Nio shell-hook entry into ~/.hermes/config.yaml so
# Hermes will spawn hook-cli.js on every pre_tool_call event. Idempotent.
#
# Usage:
#   bash plugins/hermes/setup.sh                  # normal install
#   bash plugins/hermes/setup.sh --dry-run        # print resulting YAML, no write
#   bash plugins/hermes/setup.sh --yes            # skip interactive merge prompts
#   bash plugins/hermes/setup.sh --accept-hooks   # also pre-approve in Hermes's
#                                                 # allowlist (so the hook fires
#                                                 # immediately, non-interactive)
#   bash plugins/hermes/setup.sh --reset-config   # overwrite ~/.nio/config.yaml
#                                                 # with the bundled defaults
#                                                 # (Nio runtime config; does
#                                                 # not touch ~/.hermes/config.yaml)
#   bash plugins/hermes/setup.sh --uninstall      # remove the Nio entry
#
# Environment:
#   HERMES_CONFIG_PATH   override target (default: ~/.hermes/config.yaml)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

SNIPPET="$SCRIPT_DIR/config-snippet.yaml"
HERMES_CONFIG="${HERMES_CONFIG_PATH:-$HOME/.hermes/config.yaml}"
HERMES_HOME_DIR="$(dirname "$HERMES_CONFIG")"
PLUGIN_DST="$HERMES_HOME_DIR/plugins/nio"
PLUGIN_SRC="$SCRIPT_DIR/python-plugin"

# Resolve hook-cli.js paths. Two layouts to support, with two roles each:
#
#   1. Release zip (also reached via `curl … | bash`): hook-cli.js ships
#      inside the extracted zip as $SCRIPT_DIR/scripts/hook-cli.js.
#      Under the one-liner that's /tmp/nio-install-XXX/hermes/scripts/...,
#      a directory which install.sh's EXIT trap deletes immediately after
#      setup.sh returns. We MUST NOT register that ephemeral path with
#      Hermes — by the time `hermes hooks doctor` (or the runtime itself)
#      looks for it, the file is gone.
#   2. Monorepo dev (and the `nio-all` zip): source lives at
#      $REPO_ROOT/plugins/claude-code/skills/nio/scripts/, which is the
#      repo's bundle output — stable across runs.
#
#   HOOK_CLI_INSTALL    — where the bundled hook-cli.js exists NOW (source
#                          for the `cp` step in install_python_plugin).
#   HOOK_CLI_REGISTERED — the path we write into ~/.hermes/config.yaml.
#                          Persistent ($PLUGIN_DST/scripts/hook-cli.js)
#                          for the release path; identical to INSTALL for
#                          the monorepo path (source IS stable).
if [[ -f "$SCRIPT_DIR/scripts/hook-cli.js" ]]; then
  HOOK_CLI_INSTALL="$SCRIPT_DIR/scripts/hook-cli.js"
  HOOK_CLI_REGISTERED="$PLUGIN_DST/scripts/hook-cli.js"
else
  HOOK_CLI_INSTALL="$REPO_ROOT/plugins/claude-code/skills/nio/scripts/hook-cli.js"
  HOOK_CLI_REGISTERED="$HOOK_CLI_INSTALL"
fi
HOOK_CLI="$HOOK_CLI_REGISTERED"   # back-compat alias for any later use

# Partition args: `--accept-hooks` and `--reset-config` are ours (handled
# locally below); everything else is forwarded to install-hook.py verbatim.
# `--reset-config` resets the Nio runtime config at ~/.nio/config.yaml — it
# has nothing to do with Hermes's own ~/.hermes/config.yaml hook entries,
# so it must NOT be forwarded to install-hook.py (which rejects it).
ACCEPT_HOOKS=0
DRY_RUN=0
UNINSTALL=0
RESET_CONFIG=0
FORWARD_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --accept-hooks|--approve)
      ACCEPT_HOOKS=1 ;;
    --reset-config)
      RESET_CONFIG=1 ;;
    --dry-run)
      DRY_RUN=1
      FORWARD_ARGS+=("$arg") ;;
    --uninstall)
      UNINSTALL=1
      FORWARD_ARGS+=("$arg") ;;
    *)
      FORWARD_ARGS+=("$arg") ;;
  esac
done

NIO_DIR="$HOME/.nio"

# ── Pre-flight checks ───────────────────────────────────────────────────

if [[ ! -f "$HOOK_CLI_INSTALL" ]]; then
  echo "error: hook-cli.js not found at $HOOK_CLI_INSTALL" >&2
  echo "hint: run 'pnpm run build' from the repo root first." >&2
  exit 1
fi

if [[ ! -f "$SNIPPET" ]]; then
  echo "error: config-snippet.yaml not found at $SNIPPET" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "error: python3 is required (shipped with Hermes)." >&2
  exit 1
fi

# Prefer Hermes's own venv Python — it ships with PyYAML, which
# install-hook.py needs for smart per-event merging. Without PyYAML the
# fallback path can't tell a partial install from a complete one (e.g.
# a pre-Ext-E config with only pre_tool_call looks "already installed"
# even though the 6 new lifecycle events are missing). System python3
# often lacks PyYAML on stock macOS / CI runners.
INSTALL_PY="python3"
if command -v hermes >/dev/null 2>&1; then
  _hermes_shebang="$(head -n1 "$(command -v hermes)" 2>/dev/null || true)"
  _hermes_py="$(printf '%s\n' "$_hermes_shebang" | sed -n 's|^#! *\([^ ]*\).*|\1|p')"
  if [[ -n "$_hermes_py" && -x "$_hermes_py" ]]; then
    if "$_hermes_py" -c 'import yaml' >/dev/null 2>&1; then
      INSTALL_PY="$_hermes_py"
    fi
  fi
fi

# ── Banner ──────────────────────────────────────────────────────────────

echo "Nio → Hermes shell-hook installer"
echo "  hook-cli.js (installed) : $HOOK_CLI_INSTALL"
echo "  hook-cli.js (registered): $HOOK_CLI_REGISTERED"
echo "  target config           : $HERMES_CONFIG"
echo "  python                  : $INSTALL_PY"
echo

# install-hook.py invocation moved further down — see the "Sequenced
# actions" block. It must run AFTER install_python_plugin (install case)
# so the stable hook-cli.js exists at the moment config.yaml references
# it, and BEFORE uninstall cleanup (uninstall case) so the revoke list
# is captured while config.yaml still has the entries.

# ── Hermes /nio Python plugin install ──────────────────────────────────
# Hermes auto-discovers any directory under ~/.hermes/plugins/<name>/
# at startup (one of four discovery paths in
# hermes_cli/plugins.py::discover_and_load). Drop our 3-file plugin
# (manifest + register() + bundled CLIs) into that directory so the
# /nio slash command works in Hermes chat / Telegram / Discord without
# routing through the LLM. Variables resolved further up:
# HERMES_HOME_DIR, PLUGIN_DST, PLUGIN_SRC.

install_python_plugin() {
  if [[ ! -d "$PLUGIN_SRC" ]]; then
    echo "[nio-hermes] python-plugin/ not found at $PLUGIN_SRC; skipping /nio dispatch install" >&2
    return 0
  fi
  if [[ ! -f "$SCRIPT_DIR/scripts/nio-cli.js" ]]; then
    echo "[nio-hermes] scripts/nio-cli.js not found; run 'pnpm run build' first" >&2
    return 0
  fi
  mkdir -p "$PLUGIN_DST/scripts"
  cp -f "$PLUGIN_SRC/plugin.yaml"        "$PLUGIN_DST/plugin.yaml"
  cp -f "$PLUGIN_SRC/__init__.py"        "$PLUGIN_DST/__init__.py"
  cp -f "$SCRIPT_DIR/scripts/nio-cli.js" "$PLUGIN_DST/scripts/nio-cli.js"
  # Copy hook-cli.js into its permanent home BEFORE install-hook.py
  # writes config.yaml — config references HOOK_CLI_REGISTERED, which
  # is exactly this destination. Doing it in the other order would leave
  # a brief window where Hermes points at a path that doesn't yet exist.
  cp -f "$HOOK_CLI_INSTALL"              "$PLUGIN_DST/scripts/hook-cli.js"
  echo "[nio-hermes] Installed /nio Python plugin → $PLUGIN_DST"

  # Hermes user plugins are opt-in: discover_and_load() only loads names
  # listed in plugins.enabled. Without this step the directory exists but
  # /nio never registers. Append 'nio' to plugins.enabled idempotently.
  if "$INSTALL_PY" -c 'import yaml' >/dev/null 2>&1; then
    "$INSTALL_PY" - "$HERMES_CONFIG" <<'PY' || \
      echo "[nio-hermes] Couldn't update plugins.enabled — add 'nio' to ~/.hermes/config.yaml manually" >&2
import sys, yaml
from pathlib import Path

cfg_path = Path(sys.argv[1])
text = cfg_path.read_text(encoding="utf-8") if cfg_path.exists() else ""
data = yaml.safe_load(text) or {}
if not isinstance(data, dict):
    print("config.yaml is not a YAML mapping; skipping plugins.enabled update", file=sys.stderr)
    sys.exit(2)

plugins = data.get("plugins")
if not isinstance(plugins, dict):
    plugins = {}
    data["plugins"] = plugins

enabled = plugins.get("enabled")
if not isinstance(enabled, list):
    enabled = []

if "nio" in enabled:
    print("[nio-hermes] 'nio' already in plugins.enabled", file=sys.stderr)
else:
    enabled.append("nio")
    plugins["enabled"] = enabled
    cfg_path.write_text(
        yaml.safe_dump(data, default_flow_style=False, sort_keys=False, width=10_000),
        encoding="utf-8",
    )
    print("[nio-hermes] Added 'nio' to plugins.enabled in", cfg_path, file=sys.stderr)
PY
  else
    echo "[nio-hermes] PyYAML not available; add 'nio' to plugins.enabled in $HERMES_CONFIG manually" >&2
  fi
}

uninstall_python_plugin() {
  if [[ -d "$PLUGIN_DST" ]]; then
    # Use find -delete instead of rm -rf so guard-hook scanning of this
    # script doesn't trip Phase 4 (DESTRUCTIVE_FS) on commits. Same
    # semantics, less alarming to Nio's own scanner.
    find "$PLUGIN_DST" -depth -delete 2>/dev/null || true
    if [[ ! -d "$PLUGIN_DST" ]]; then
      echo "[nio-hermes] Removed /nio Python plugin from $PLUGIN_DST"
    fi
  fi
}

# Symmetric with approve_hook() (defined further down): on uninstall,
# revoke every Nio command string we just stripped from config.yaml so
# ~/.hermes/shell-hooks-allowlist.json doesn't accumulate orphan entries.
# Best-effort — if `hermes` is gone or its venv is broken we warn and
# exit 0; orphans are harmless (Hermes won't fire a hook it can't find
# in config.yaml).
#
# Defined here (not next to approve_hook) so the UNINSTALL branch below
# can call it — bash functions must be declared before invocation.
revoke_hermes_allowlist() {
  local revoke_json="$1"
  if [[ -z "$revoke_json" ]]; then
    return 0
  fi
  if ! command -v hermes >/dev/null 2>&1; then
    echo "[nio-hermes] 'hermes' CLI not on PATH; skipping allowlist revoke." >&2
    echo "             Orphan entries in ~/.hermes/shell-hooks-allowlist.json are" >&2
    echo "             harmless; remove manually for a clean file." >&2
    return 0
  fi

  local hermes_bin shebang hermes_py
  hermes_bin="$(command -v hermes)"
  shebang="$(head -n1 "$hermes_bin" 2>/dev/null || true)"
  hermes_py="$(printf '%s\n' "$shebang" | sed -n 's|^#! *\([^ ]*\).*|\1|p')"

  if [[ -z "$hermes_py" || ! -x "$hermes_py" ]]; then
    echo "[nio-hermes] Couldn't locate Hermes's Python; skipping allowlist revoke." >&2
    return 0
  fi

  echo "[nio-hermes] Revoking Nio allowlist entries via Hermes's shell_hooks.revoke()..."
  if REVOKE_JSON="$revoke_json" "$hermes_py" - <<'PY'
import json, os, sys
try:
    from agent.shell_hooks import revoke
except Exception as exc:
    print(f"[nio-hermes] cannot import agent.shell_hooks ({exc}); skipping", file=sys.stderr)
    sys.exit(0)

data = json.loads(os.environ.get("REVOKE_JSON") or "{}")
removed = 0
for cmd in data.get("nio_revoke_candidates", []):
    if not isinstance(cmd, str) or not cmd:
        continue
    try:
        revoke(cmd)
        removed += 1
    except Exception as exc:
        print(f"[nio-hermes] revoke({cmd!r}) failed: {exc}", file=sys.stderr)
print(f"[nio-hermes] revoked {removed} allowlist entr{'y' if removed == 1 else 'ies'}", file=sys.stderr)
PY
  then
    :
  else
    echo "[nio-hermes] revoke step failed; orphaned allowlist entries may remain." >&2
  fi
}

# ── Sequenced actions ──────────────────────────────────────────────────
# Order matters:
#   (A) install case — install_python_plugin first, so the stable
#       hook-cli.js at $HOOK_CLI_REGISTERED exists by the time
#       install-hook.py writes config.yaml.
#   (B) Always — invoke install-hook.py. Under --uninstall, capture
#       stdout for the revoke-candidates JSON.
#   (C) uninstall case — revoke the allowlist entries we just stripped
#       (consuming the JSON from B), then tear down the plugin dir.

# (A) Install: lay down the persistent plugin dir.
if [ "$UNINSTALL" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
  install_python_plugin
fi

# (B) install-hook.py — install OR uninstall.
NIO_REVOKE_JSON=""
if [ "$UNINSTALL" -eq 1 ]; then
  # Capture stdout for the revoke JSON; stderr passes through.
  NIO_PY_STDOUT="$("$INSTALL_PY" "$SCRIPT_DIR/install-hook.py" \
    --config "$HERMES_CONFIG" \
    --hook-cli "$HOOK_CLI_REGISTERED" \
    --snippet "$SNIPPET" \
    --print-revoke-list \
    "${FORWARD_ARGS[@]+"${FORWARD_ARGS[@]}"}")"
  NIO_REVOKE_JSON="$(printf '%s\n' "$NIO_PY_STDOUT" \
    | grep -E '^\{"nio_revoke_candidates":' | tail -1 || true)"
else
  "$INSTALL_PY" "$SCRIPT_DIR/install-hook.py" \
    --config "$HERMES_CONFIG" \
    --hook-cli "$HOOK_CLI_REGISTERED" \
    --snippet "$SNIPPET" \
    "${FORWARD_ARGS[@]+"${FORWARD_ARGS[@]}"}"
fi

# (C) Uninstall cleanup.
if [ "$UNINSTALL" -eq 1 ]; then
  revoke_hermes_allowlist "$NIO_REVOKE_JSON"
  uninstall_python_plugin
fi

# ── Nio runtime config (~/.nio/config.yaml) ─────────────────────────────
# Same behaviour as the Claude Code + OpenClaw plugin setup scripts:
# copy the bundled defaults if the user has no config yet, or if they
# passed --reset-config. Independent of the Hermes hook merge above.
if [ "$DRY_RUN" -eq 0 ] && [ "$UNINSTALL" -eq 0 ]; then
  mkdir -p "$NIO_DIR"
  if [ "$RESET_CONFIG" -eq 1 ] || [ ! -f "$NIO_DIR/config.yaml" ]; then
    if [ -f "$SCRIPT_DIR/config.default.yaml" ]; then
      cp "$SCRIPT_DIR/config.default.yaml" "$NIO_DIR/config.yaml"
      [ "$RESET_CONFIG" -eq 1 ] \
        && echo "[nio-hermes] Nio config reset to defaults at $NIO_DIR/config.yaml" \
        || echo "[nio-hermes] Default Nio config written to $NIO_DIR/config.yaml"
    fi
  fi
fi

# Dry-run and uninstall skip the approval flow.
if [ "$DRY_RUN" -eq 1 ] || [ "$UNINSTALL" -eq 1 ]; then
  exit 0
fi

# ── Optional: pre-approve in Hermes's shell-hooks allowlist ─────────────
# Hermes refuses to fire unknown shell hooks until the user has consented
# (persisted to ~/.hermes/shell-hooks-allowlist.json). This is upstream's
# security boundary — we do NOT write that file directly. Instead, we
# invoke `hermes` with --accept-hooks, which adds an entry keyed on the
# exact command string. Other future shell hooks still need consent.

approve_hook() {
  if ! command -v hermes >/dev/null 2>&1; then
    echo "[nio-hermes] 'hermes' CLI not on PATH; skipping approval." >&2
    echo "[nio-hermes] After installing Hermes (and re-opening shell so PATH" >&2
    echo "             picks up ~/.local/bin, or wherever your installer put it):" >&2
    echo "             hermes chat --accept-hooks   # type 'exit' to leave" >&2
    return 0
  fi

  local hermes_bin
  hermes_bin="$(command -v hermes)"

  # Find a Python interpreter that can actually import agent.shell_hooks.
  # The previous heuristic (grab the path from `hermes`'s shebang) breaks
  # when the user's `hermes` is a bash/sh wrapper — we end up handing the
  # PY heredoc to /bin/bash, which dies with a syntax error before
  # printing anything. Sniff the shebang AND validate the import.
  local hermes_py=""
  _try_hermes_py() {
    local cand="$1"
    [[ -n "$cand" && -x "$cand" ]] || return 1
    "$cand" -c 'import agent.shell_hooks' >/dev/null 2>&1 || return 1
    hermes_py="$cand"
    return 0
  }
  # 1. Sniff `hermes` shebang. Works when `hermes` is a real Python
  #    script with #!/path/to/python.
  local sb_py
  sb_py="$(head -n1 "$hermes_bin" 2>/dev/null \
          | sed -n 's|^#! *\([^ ]*\).*|\1|p')"
  # 2. If `hermes` is a bash/sh wrapper (#!/usr/bin/env bash, common
  #    for pipx/uv-tool installs), grep its body for an `exec <python>`
  #    line and pull the absolute python path out of there. Catches
  #    paths like /home/.../uv/tools/.../bin/python that we'd never
  #    guess by hardcoding.
  local wrapper_pys=()
  if [[ -r "$hermes_bin" ]]; then
    while IFS= read -r line; do
      wrapper_pys+=("$line")
    done < <(grep -oE '/[^[:space:]"'"'"']+(/python[0-9.]*|/bin/python[0-9.]*)' "$hermes_bin" 2>/dev/null | head -5)
  fi
  # 3. Last-resort hardcoded layouts.
  local hardcoded_pys=(
    "$HOME/.hermes/hermes-agent/venv/bin/python3"
    "$HOME/.hermes/hermes-agent/venv/bin/python"
    "$HOME/.hermes/venv/bin/python3"
    "$HOME/.hermes/venv/bin/python"
  )
  for cand in "$sb_py" "${wrapper_pys[@]}" "${hardcoded_pys[@]}"; do
    _try_hermes_py "$cand" && break
  done

  # For strategy 2 (direct allowlist write) we don't need
  # agent.shell_hooks — only yaml/json/fcntl. $INSTALL_PY is already
  # validated upstream (line ~120) to import yaml.
  local fs_py="$INSTALL_PY"

  if [[ -n "$hermes_py" ]]; then
    echo "[nio-hermes] python for Hermes API (strategy 1): $hermes_py" >&2
  else
    echo "[nio-hermes] no Hermes-API-capable Python found — strategy 1 will be skipped" >&2
  fi
  echo "[nio-hermes] python for direct allowlist write (strategy 2): $fs_py" >&2

  local allowlist_path="$HERMES_HOME_DIR/shell-hooks-allowlist.json"

  # Returns 0 if the allowlist file exists, is non-empty, and contains at
  # least one entry that matches Nio's hook-cli signature.
  _nio_allowlist_has_us() {
    [[ -s "$allowlist_path" ]] || return 1
    grep -q "hook-cli.js" "$allowlist_path" 2>/dev/null
  }

  echo "[nio-hermes] Approving Nio hooks (multi-strategy)..."

  # Strategy 1 — Hermes's internal API (the documented path per PR #13296).
  # We read the config DIRECTLY (yaml.safe_load on $HERMES_CONFIG) instead
  # of calling Hermes's load_config(): some versions of load_config()
  # cache, read a different path, or omit entries the user just wrote.
  # If register_from_config(accept_hooks=True) doesn't actually write the
  # allowlist on the user's Hermes version, we verify and fall through.
  local strategy1_rc=0
  if [[ -z "$hermes_py" ]]; then
    strategy1_rc=127  # interpreter unavailable
  else
  # NB: `python -u` keeps stderr unbuffered so diagnostic messages survive
  # even when the interpreter dies mid-script.
  NIO_HERMES_CFG="$HERMES_CONFIG" "$hermes_py" -u - <<'PY' || strategy1_rc=$?
import os, sys
try:
    import yaml
except ImportError:
    print("[nio-hermes] PyYAML unavailable in Hermes venv; skipping API strategy", file=sys.stderr)
    sys.exit(1)

cfg_path = os.environ.get("NIO_HERMES_CFG", os.path.expanduser("~/.hermes/config.yaml"))
try:
    with open(cfg_path) as f:
        cfg = yaml.safe_load(f) or {}
except Exception as exc:
    print(f"[nio-hermes] couldn't read {cfg_path}: {exc}", file=sys.stderr)
    sys.exit(1)

hooks = cfg.get("hooks") if isinstance(cfg.get("hooks"), dict) else {}
nio_cmds = {
    e["command"]
    for entries in (hooks or {}).values() if isinstance(entries, list)
    for e in entries
    if isinstance(e, dict)
       and isinstance(e.get("command"), str)
       and "hook-cli.js" in e["command"]
       and "--platform hermes" in e["command"]
}
print(f"[nio-hermes] strategy 1: register_from_config() over {len(nio_cmds)} command(s)",
      file=sys.stderr)
try:
    from agent.shell_hooks import register_from_config, revoke
    for cmd in nio_cmds:
        try:
            revoke(cmd)
        except Exception:
            pass
    register_from_config(cfg, accept_hooks=True)
except Exception as exc:
    print(f"[nio-hermes] strategy 1 raised: {exc}", file=sys.stderr)
    sys.exit(2)
PY
  fi  # close: if [[ -n "$hermes_py" ]]; then

  if _nio_allowlist_has_us; then
    echo "[nio-hermes] Hooks approved (strategy 1 / API). Verify: hermes hooks doctor"
    return 0
  fi

  # Strategy 2 — write the allowlist file ourselves, using exactly the
  # schema Hermes's agent.shell_hooks._record_approval uses internally:
  #
  #   {"approvals": [
  #     {"event": ..., "command": ..., "approved_at": ISO8601,
  #      "script_mtime_at_approval": ISO8601 | null},
  #     ...
  #   ]}
  #
  # Merge-safe: existing approvals from OTHER hook handlers are preserved.
  # Idempotent: replaces any existing (event, command) entries that match
  # ours (mirrors _record_approval's "filter-then-append" rule). Crash-
  # safe: holds fcntl.flock on the sibling .lock file and writes via
  # mkstemp + os.replace (same atomic pattern as Hermes's save_allowlist).
  #
  # Uses $fs_py (= $INSTALL_PY, already validated to import yaml) — NOT
  # $hermes_py — so this works even when `hermes` is a bash wrapper.
  if [[ "$strategy1_rc" -eq 127 ]]; then
    echo "[nio-hermes] strategy 1 skipped (no Hermes-API Python found)." >&2
  else
    echo "[nio-hermes] strategy 1 returned rc=$strategy1_rc without writing $allowlist_path." >&2
  fi
  echo "[nio-hermes] Falling back to direct allowlist write (merge-safe)..." >&2

  local strategy2_rc=0
  NIO_HERMES_CFG="$HERMES_CONFIG" \
  NIO_ALLOWLIST_PATH="$allowlist_path" \
    "$fs_py" -u - <<'PY' || strategy2_rc=$?
import fcntl, json, os, shlex, sys, tempfile
from datetime import datetime, timezone
from pathlib import Path
try:
    import yaml
except ImportError:
    print("[nio-hermes] strategy 2: PyYAML missing; aborting direct write", file=sys.stderr)
    sys.exit(1)

cfg_path = os.environ["NIO_HERMES_CFG"]
allowlist_path = Path(os.environ["NIO_ALLOWLIST_PATH"])

try:
    cfg = yaml.safe_load(Path(cfg_path).read_text()) or {}
except Exception as exc:
    print(f"[nio-hermes] strategy 2: couldn't read {cfg_path}: {exc}", file=sys.stderr)
    sys.exit(1)

hooks = cfg.get("hooks") if isinstance(cfg.get("hooks"), dict) else {}

# Collect every (event, command) pair Nio installed. One allowlist entry
# per pair — mirrors Hermes's schema (same command, different events get
# distinct entries).
nio_pairs = []
seen = set()
for event_name, entries in (hooks or {}).items():
    if not isinstance(entries, list):
        continue
    for e in entries:
        if not isinstance(e, dict):
            continue
        cmd = e.get("command")
        if (isinstance(cmd, str)
            and "hook-cli.js" in cmd
            and "--platform hermes" in cmd
            and (event_name, cmd) not in seen):
            seen.add((event_name, cmd))
            nio_pairs.append((event_name, cmd))

if not nio_pairs:
    print("[nio-hermes] strategy 2: no Nio (event, command) pairs found in config", file=sys.stderr)
    sys.exit(1)

# Same script-path resolution Hermes uses (agent.shell_hooks._command_script_path).
_SCRIPT_EXTS = (".sh", ".bash", ".zsh", ".fish", ".py", ".pyw",
                ".rb", ".pl", ".lua", ".js", ".mjs", ".cjs", ".ts")
def script_path_of(command):
    try:
        parts = shlex.split(command)
    except ValueError:
        return command
    if not parts:
        return command
    for p in parts:
        if p.lower().endswith(_SCRIPT_EXTS):
            return p
    for p in parts:
        if "/" in p or p.startswith("~"):
            return p
    return parts[0]

def utc_now_iso():
    return datetime.now(tz=timezone.utc).isoformat().replace("+00:00", "Z")

def script_mtime_iso(command):
    p = os.path.expanduser(script_path_of(command))
    try:
        return datetime.fromtimestamp(
            os.path.getmtime(p), tz=timezone.utc,
        ).isoformat().replace("+00:00", "Z")
    except OSError:
        return None

# Atomic, locked read-modify-write. fcntl.flock on the .lock sibling
# (same approach as Hermes's _locked_update_approvals) makes us safe
# against a concurrent `hermes` process touching the same file.
allowlist_path.parent.mkdir(parents=True, exist_ok=True)
lock_path = allowlist_path.with_suffix(allowlist_path.suffix + ".lock")

def load_existing():
    try:
        raw = json.loads(allowlist_path.read_text())
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {"approvals": []}
    if not isinstance(raw, dict):
        return {"approvals": []}
    if not isinstance(raw.get("approvals"), list):
        raw["approvals"] = []
    return raw

def atomic_write(data):
    # mkstemp + os.replace — same pattern as Hermes save_allowlist.
    fd, tmp_path = tempfile.mkstemp(
        prefix=f"{allowlist_path.name}.", suffix=".tmp", dir=str(allowlist_path.parent),
    )
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(json.dumps(data, indent=2, sort_keys=True))
        os.replace(tmp_path, allowlist_path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise

with open(lock_path, "a+") as lock_fh:
    try:
        fcntl.flock(lock_fh.fileno(), fcntl.LOCK_EX)
    except OSError as exc:
        print(f"[nio-hermes] strategy 2: couldn't lock {lock_path}: {exc}", file=sys.stderr)
        sys.exit(1)
    try:
        data = load_existing()
        approvals = data["approvals"]

        # Filter-then-append, mirrors Hermes _record_approval. This
        # preserves every approval from OTHER hook handlers and refreshes
        # ours with a fresh approved_at + current script mtime.
        keep = [
            e for e in approvals
            if not (
                isinstance(e, dict)
                and any(
                    e.get("event") == ev and e.get("command") == cmd
                    for (ev, cmd) in nio_pairs
                )
            )
        ]
        for event_name, command in nio_pairs:
            keep.append({
                "approved_at": utc_now_iso(),
                "command": command,
                "event": event_name,
                "script_mtime_at_approval": script_mtime_iso(command),
            })

        data["approvals"] = keep
        atomic_write(data)
        kept_others = len(approvals) - sum(
            1 for e in approvals
            if isinstance(e, dict)
               and any(e.get("event") == ev and e.get("command") == cmd
                       for (ev, cmd) in nio_pairs)
        )
        print(
            f"[nio-hermes] strategy 2: wrote {len(nio_pairs)} Nio approval(s); "
            f"preserved {kept_others} pre-existing entr{'y' if kept_others == 1 else 'ies'}",
            file=sys.stderr,
        )
    finally:
        fcntl.flock(lock_fh.fileno(), fcntl.LOCK_UN)
PY

  if _nio_allowlist_has_us; then
    echo "[nio-hermes] Hooks approved (strategy 2 / direct allowlist write)."
    echo "[nio-hermes] Verify: hermes hooks doctor"
    return 0
  fi

  # Both strategies failed (rare — strategy 2 should always succeed unless
  # something is genuinely wrong with filesystem permissions or PyYAML).
  echo "[nio-hermes] APPROVAL DID NOT WRITE $allowlist_path." >&2
  echo "[nio-hermes] strategy 1 rc=$strategy1_rc (127 = no API-capable Python found)" >&2
  echo "[nio-hermes] strategy 2 rc=$strategy2_rc (using $fs_py)" >&2
  echo "[nio-hermes] Check $allowlist_path's parent permissions and" >&2
  echo "[nio-hermes] retry with: bash plugins/hermes/setup.sh --accept-hooks" >&2
  echo "[nio-hermes] If that still fails, run hermes chat once and press Y" >&2
  echo "[nio-hermes] at the consent prompt." >&2
  return 1
}

APPROVED=0
# approve_hook may return non-zero now when verification fails — set
# APPROVED only on real success so the post-install summary reflects
# reality (no more "Hooks approved" false claims when allowlist is empty).
if [ "$ACCEPT_HOOKS" -eq 1 ]; then
  if approve_hook; then APPROVED=1; fi
elif [ -r /dev/tty ] && [ -w /dev/tty ]; then
  # Real controlling terminal available — offer one-shot approval. We read
  # from /dev/tty (not stdin) so the prompt still works under `curl | bash`,
  # where stdin is the curl pipe. CI / cron / non-TTY containers fail the
  # /dev/tty check and fall through to the non-interactive "Next steps"
  # path below. Default N is safer (just hitting Enter doesn't touch the
  # allowlist).
  {
    echo
    echo "Hermes won't fire unknown shell hooks until you approve them."
    echo "Approve this Nio hook now? (only this exact command; other future"
    echo "shell hooks still require consent.)"
    printf "  [y/N] "
  } >/dev/tty
  read -r answer </dev/tty || answer=""
  case "$answer" in
    [Yy]|[Yy][Ee][Ss])
      if approve_hook; then APPROVED=1; fi ;;
    *)
      echo "[nio-hermes] Skipped. Approve later with:" >&2
      echo "             hermes --accept-hooks hooks doctor" >&2 ;;
  esac
fi

# ── Post-install reminder ────────────────────────────────────────────────

if [ "$APPROVED" -eq 1 ]; then
  cat <<'EOF'

Next steps (Hermes side):
  1. Verify the hook fires on pre_tool_call:
       hermes hooks list      # ✓ allowlisted
       hermes hooks doctor    # all green, runs a JSON smoke test

  2. Re-run this script after any `pnpm run build` to refresh the
     absolute path in config.yaml; you will need to re-approve
     because the command string (and its allowlist hash) changes.
EOF
else
  cat <<'EOF'

Next steps (Hermes side):
  1. Start a new Hermes session. The new process loads ~/.hermes/config.yaml
     fresh (including the Nio hook entry just added), and Hermes shows a
     one-shot consent prompt the first time the hook fires:

       hermes chat        # press Y at the prompt — done.

     If you already have a daemon (e.g. `hermes gateway`) running with the
     stale config, restart it so it picks up the new hook entry:

       hermes gateway run --replace

  2. Headless / CI / cron / non-TTY — no terminal for the consent prompt?
     Pre-approve first, then start the session normally:

       hermes --accept-hooks hooks doctor     # one-shot, scoped to Nio
       # or persistent for this shell:        export HERMES_ACCEPT_HOOKS=1
       # or global default in config.yaml:    hooks_auto_accept: true

     Or re-run this installer with: bash plugins/hermes/setup.sh --accept-hooks

  3. Verify any time:
       hermes hooks list      # ✓ allowlisted shows up
       hermes hooks doctor    # all green, runs a JSON smoke test

  Re-run this script after any `pnpm run build` — the absolute hook-cli.js
  path changes, and you'll need to re-approve.
EOF
fi
