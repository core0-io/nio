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
#   bash plugins/hermes/setup.sh --yes          # skip interactive prompts
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

# ── Report + invoke the Python merge helper ─────────────────────────────

echo "Nio → Hermes shell-hook installer"
echo "  hook-cli.js    : $HOOK_CLI"
echo "  target config  : $HERMES_CONFIG"
echo

python3 "$SCRIPT_DIR/install-hook.py" \
  --config "$HERMES_CONFIG" \
  --hook-cli "$HOOK_CLI" \
  --snippet "$SNIPPET" \
  "$@"

# ── Post-install reminder (skip for dry-run / uninstall) ────────────────

for arg in "$@"; do
  case "$arg" in
    --dry-run|--uninstall) exit 0 ;;
  esac
done

cat <<'EOF'

Next steps (Hermes side):
  1. Approve the hook on first run. Either interactive:
       hermes chat             # first pre_tool_call prompts for consent
     — or pre-approve (required for gateway / CI / cron / non-TTY runs):
       hermes --accept-hooks <command>
       export HERMES_ACCEPT_HOOKS=1
       # or add hooks_auto_accept: true to ~/.hermes/config.yaml

  2. Verify registration at any time:
       hermes hooks list
       hermes hooks doctor

  3. Test the hook end-to-end without running the agent:
       hermes hooks test pre_tool_call --for-tool terminal \
         --payload-file <(echo '{"tool_input":{"command":"ls /tmp"}}')

  Re-run this script any time you update the Nio install (e.g. after
  a new `pnpm run build`) to rewrite the absolute path in config.yaml.
EOF
