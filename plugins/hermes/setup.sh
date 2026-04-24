#!/usr/bin/env bash
# Copyright 2026 core0-io
# SPDX-License-Identifier: Apache-2.0
#
# Installs the Nio shell-hook entry into ~/.hermes/config.yaml so
# Hermes will spawn hook-cli.js on every pre_tool_call event. Idempotent.
#
# Usage:
#   bash plugins/hermes/setup.sh                # normal install
#   bash plugins/hermes/setup.sh --dry-run      # print resulting YAML, no write
#   bash plugins/hermes/setup.sh --yes          # skip interactive merge prompts
#   bash plugins/hermes/setup.sh --accept-hooks # also pre-approve in Hermes's
#                                               # allowlist (so the hook fires
#                                               # immediately, non-interactive)
#   bash plugins/hermes/setup.sh --uninstall    # remove the Nio entry
#
# Environment:
#   HERMES_CONFIG_PATH   override target (default: ~/.hermes/config.yaml)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

HOOK_CLI="$REPO_ROOT/plugins/claude-code/skills/nio/scripts/hook-cli.js"
SNIPPET="$SCRIPT_DIR/config-snippet.yaml"
HERMES_CONFIG="${HERMES_CONFIG_PATH:-$HOME/.hermes/config.yaml}"

# Partition args: `--accept-hooks` is ours (handled post-install below);
# everything else is forwarded to install-hook.py verbatim.
ACCEPT_HOOKS=0
DRY_RUN=0
UNINSTALL=0
FORWARD_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --accept-hooks|--approve)
      ACCEPT_HOOKS=1 ;;
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

"$INSTALL_PY" "$SCRIPT_DIR/install-hook.py" \
  --config "$HERMES_CONFIG" \
  --hook-cli "$HOOK_CLI" \
  --snippet "$SNIPPET" \
  "${FORWARD_ARGS[@]+"${FORWARD_ARGS[@]}"}"

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

APPROVED=0
if [ "$ACCEPT_HOOKS" -eq 1 ]; then
  approve_hook
  APPROVED=1
elif [ -t 0 ] && [ -t 1 ]; then
  # Real interactive TTY — offer one-shot approval. Default N is safer
  # (just hitting Enter doesn't touch the allowlist).
  echo
  echo "Hermes won't fire unknown shell hooks until you approve them."
  echo "Approve this Nio hook now? (only this exact command; other future"
  echo "shell hooks still require consent.)"
  printf "  [y/N] "
  read -r answer || answer=""
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
  1. Approve the hook on first run. Either interactive:
       hermes chat             # first pre_tool_call prompts for consent
     — or pre-approve (required for gateway / CI / cron / non-TTY runs):
       hermes --accept-hooks hooks doctor     # one-shot, scoped to Nio
       export HERMES_ACCEPT_HOOKS=1           # blanket for this shell
       # or add hooks_auto_accept: true to ~/.hermes/config.yaml (global)

     Or re-run this installer with: bash plugins/hermes/setup.sh --accept-hooks

  2. Verify registration at any time:
       hermes hooks list
       hermes hooks doctor

  3. Test the hook end-to-end without running the agent:
       hermes hooks test pre_tool_call --for-tool terminal \
         --payload-file <(echo '{"tool_input":{"command":"ls /tmp"}}')

  Re-run this script after any `pnpm run build` to refresh the absolute
  path in config.yaml (and re-approve — the command string changes).
EOF
fi
