#!/usr/bin/env bash
set -euo pipefail

# FFWD AgentGuard — All-in-one setup
# Detects platform and runs the appropriate plugin setup script(s).
# Supports: Claude Code, OpenClaw, ClawHub

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "  FFWD AgentGuard — AI Agent Security Guard"
echo "  ============================================="
echo ""

# ---- Uninstall mode ----
if [ "${1:-}" = "--uninstall" ] || [ "${1:-}" = "uninstall" ]; then
  echo "  Uninstalling FFWD AgentGuard (all platforms)..."
  [ -f "$SCRIPT_DIR/plugins/claude-code/setup.sh" ] && bash "$SCRIPT_DIR/plugins/claude-code/setup.sh" --uninstall
  [ -f "$SCRIPT_DIR/plugins/openclaw/setup.sh" ] && bash "$SCRIPT_DIR/plugins/openclaw/setup.sh" --uninstall
  echo ""
  echo "  FFWD AgentGuard has been uninstalled from all platforms."
  echo ""
  exit 0
fi

INSTALLED=0

# ---- Claude Code ----
if [ -d "$HOME/.claude" ] || [ "${INSTALL_ALL:-}" = "1" ]; then
  echo "  Detected: Claude Code"
  echo ""
  bash "$SCRIPT_DIR/plugins/claude-code/setup.sh" "$@"
  INSTALLED=1
fi

# ---- OpenClaw / ClawHub ----
if [ -d "$HOME/.openclaw" ] || [ "${INSTALL_ALL:-}" = "1" ]; then
  echo "  Detected: OpenClaw"
  echo ""
  bash "$SCRIPT_DIR/plugins/openclaw/setup.sh" "$@"
  INSTALLED=1
fi

# ---- No platform detected ----
if [ "$INSTALLED" -eq 0 ]; then
  echo "  No supported platform detected."
  echo ""
  echo "  Supported platforms:"
  echo "    - Claude Code  (~/.claude)"
  echo "    - OpenClaw     (~/.openclaw)"
  echo ""
  echo "  To install for a specific platform:"
  echo "    plugins/claude-code/setup.sh"
  echo "    plugins/openclaw/setup.sh"
  echo ""
  echo "  To force install for all platforms:"
  echo "    INSTALL_ALL=1 ./setup.sh"
  echo ""
  exit 1
fi
