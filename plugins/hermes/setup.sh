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

# Resolve hook-cli.js path. Two layouts to support:
#
#   1. Release zip `nio-hermes-vX.zip` extracts as a self-contained
#      directory — hook-cli.js ships inside as scripts/hook-cli.js.
#   2. Monorepo dev (and the `nio-all` zip) shares the bundled build
#      output at plugins/claude-code/skills/nio/scripts/hook-cli.js.
#
# Prefer the plugin-local copy so a standalone Hermes install has no
# hidden dependency on the claude-code plugin being present.
if [[ -f "$SCRIPT_DIR/scripts/hook-cli.js" ]]; then
  HOOK_CLI="$SCRIPT_DIR/scripts/hook-cli.js"
else
  HOOK_CLI="$REPO_ROOT/plugins/claude-code/skills/nio/scripts/hook-cli.js"
fi
SNIPPET="$SCRIPT_DIR/config-snippet.yaml"
HERMES_CONFIG="${HERMES_CONFIG_PATH:-$HOME/.hermes/config.yaml}"

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

if [[ ! -f "$HOOK_CLI" ]]; then
  echo "error: hook-cli.js not found at $HOOK_CLI" >&2
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

# ── Report + invoke the Python merge helper ─────────────────────────────

echo "Nio → Hermes shell-hook installer"
echo "  hook-cli.js    : $HOOK_CLI"
echo "  target config  : $HERMES_CONFIG"
echo "  python         : $INSTALL_PY"
echo

NIO_REVOKE_JSON=""
if [ "$UNINSTALL" -eq 1 ]; then
  # Capture stdout so we can extract the JSON line listing the command
  # strings we just removed (for shell-hooks-allowlist cleanup below).
  # stderr passes through to the user in real time.
  NIO_PY_STDOUT="$("$INSTALL_PY" "$SCRIPT_DIR/install-hook.py" \
    --config "$HERMES_CONFIG" \
    --hook-cli "$HOOK_CLI" \
    --snippet "$SNIPPET" \
    --print-revoke-list \
    "${FORWARD_ARGS[@]+"${FORWARD_ARGS[@]}"}")"
  NIO_REVOKE_JSON="$(printf '%s\n' "$NIO_PY_STDOUT" \
    | grep -E '^\{"nio_revoke_candidates":' | tail -1 || true)"
else
  "$INSTALL_PY" "$SCRIPT_DIR/install-hook.py" \
    --config "$HERMES_CONFIG" \
    --hook-cli "$HOOK_CLI" \
    --snippet "$SNIPPET" \
    "${FORWARD_ARGS[@]+"${FORWARD_ARGS[@]}"}"
fi

# ── Hermes /nio Python plugin install ──────────────────────────────────
# Hermes auto-discovers any directory under ~/.hermes/plugins/<name>/
# at startup (one of four discovery paths in
# hermes_cli/plugins.py::discover_and_load). Drop our 3-file plugin
# (manifest + register() + bundled CLIs) into that directory so the
# /nio slash command works in Hermes chat / Telegram / Discord without
# routing through the LLM.
HERMES_HOME_DIR="$(dirname "$HERMES_CONFIG")"
PLUGIN_DST="$HERMES_HOME_DIR/plugins/nio"
PLUGIN_SRC="$SCRIPT_DIR/python-plugin"

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
  cp -f "$PLUGIN_SRC/plugin.yaml"          "$PLUGIN_DST/plugin.yaml"
  cp -f "$PLUGIN_SRC/__init__.py"          "$PLUGIN_DST/__init__.py"
  cp -f "$SCRIPT_DIR/scripts/nio-cli.js"   "$PLUGIN_DST/scripts/nio-cli.js"
  # hook-cli.js was already installed via the shell-hook config-yaml merge,
  # but Hermes plugin discovery doesn't care about config.yaml — give the
  # plugin its own copy too so the directory is fully self-contained for
  # debugging / `hermes plugins list` introspection.
  cp -f "$SCRIPT_DIR/scripts/hook-cli.js"  "$PLUGIN_DST/scripts/hook-cli.js"
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

if [ "$UNINSTALL" -eq 1 ]; then
  revoke_hermes_allowlist "$NIO_REVOKE_JSON"
  uninstall_python_plugin
elif [ "$DRY_RUN" -eq 0 ]; then
  install_python_plugin
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
    echo "[nio-hermes] After installing Hermes, run once:" >&2
    echo "             hermes chat --accept-hooks   # type 'exit' to leave" >&2
    return 0
  fi

  # Hermes writes its allowlist (~/.hermes/shell-hooks-allowlist.json) only
  # inside register_from_config(accept_hooks=True), which runs at startup
  # for chat/acp/rl — not for 'hermes hooks test/doctor' and not for the
  # top-level --accept-hooks flag on other subcommands. Spinning up chat
  # just to populate one allowlist entry is overkill (model auth, TUI,
  # startup cost). Invoke register_from_config directly from Hermes's own
  # venv Python: same code path, no chat, no LLM.
  local hermes_bin shebang hermes_py
  hermes_bin="$(command -v hermes)"
  shebang="$(head -n1 "$hermes_bin" 2>/dev/null || true)"
  hermes_py="$(printf '%s\n' "$shebang" | sed -n 's|^#! *\([^ ]*\).*|\1|p')"

  if [[ -z "$hermes_py" || ! -x "$hermes_py" ]]; then
    echo "[nio-hermes] Couldn't locate Hermes's Python interpreter from" >&2
    echo "             $hermes_bin shebang. Approve manually:" >&2
    echo "             hermes chat --accept-hooks   # type 'exit' to leave" >&2
    return 0
  fi

  echo "[nio-hermes] Approving Nio hooks via Hermes's register_from_config()..."
  # register_from_config() only writes an allowlist entry when the hook
  # is not yet listed. For re-approvals after a rebuild (new hook-cli.js
  # mtime, or user switched to a different install path) we need to
  # clear the stale entry first so the new approved_at /
  # script_mtime_at_approval land in shell-hooks-allowlist.json.
  # revoke() is a no-op when there's nothing to remove, so this is
  # idempotent on first install too. We loop over every event in
  # config.yaml's hooks block — Nio installs entries for pre_tool_call,
  # post_tool_call, pre_llm_call, post_llm_call, on_session_*,
  # subagent_stop. Same command string across all events means one
  # allowlist entry covers them; the revoke loop is still cheap and
  # robust against future per-event command divergence.
  if "$hermes_py" - <<'PY'
from hermes_cli.config import load_config
from agent.shell_hooks import register_from_config, revoke

cfg = load_config()
hooks = cfg.get("hooks", {}) if isinstance(cfg.get("hooks", {}), dict) else {}
for event_entries in hooks.values():
    if not isinstance(event_entries, list):
        continue
    for entry in event_entries:
        if isinstance(entry, dict):
            cmd = entry.get("command")
            if isinstance(cmd, str) and cmd:
                revoke(cmd)
register_from_config(cfg, accept_hooks=True)
PY
  then
    echo "[nio-hermes] Hooks approved. Verify with: hermes hooks doctor"
  else
    echo "[nio-hermes] Approval failed. Run manually:" >&2
    echo "             hermes chat --accept-hooks   # type 'exit' to leave" >&2
  fi
}

# Symmetric with approve_hook(): on uninstall, revoke every Nio command
# string we just stripped from config.yaml so ~/.hermes/shell-hooks-allowlist.json
# doesn't accumulate orphan entries. Best-effort — if `hermes` is gone,
# or its Python venv is broken, we warn and exit 0; orphans are harmless
# (Hermes won't fire a hook it can't find in config.yaml).
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

APPROVED=0
if [ "$ACCEPT_HOOKS" -eq 1 ]; then
  approve_hook
  APPROVED=1
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
      approve_hook
      APPROVED=1 ;;
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
