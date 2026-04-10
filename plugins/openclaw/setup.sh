#!/usr/bin/env bash
set -euo pipefail

# FFWD AgentGuard — OpenClaw plugin setup
# Registers the plugin and installs hooks for OpenClaw / ClawHub.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FFWD_AGENT_GUARD_DIR="$HOME/.ffwd-agent-guard"
MIN_NODE_VERSION=18

echo ""
echo "  FFWD AgentGuard — OpenClaw Plugin Setup"
echo "  ============================================="
echo ""

# ---- Pre-check: Node.js ----
if ! command -v node &>/dev/null; then
  echo "  ERROR: Node.js is not installed."
  echo "  FFWD AgentGuard requires Node.js >= $MIN_NODE_VERSION."
  echo "  Install from: https://nodejs.org"
  exit 1
fi

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt "$MIN_NODE_VERSION" ]; then
  echo "  ERROR: Node.js v$(node -v) is too old."
  echo "  FFWD AgentGuard requires Node.js >= $MIN_NODE_VERSION."
  exit 1
fi

# ---- Uninstall mode ----
if [ "${1:-}" = "--uninstall" ] || [ "${1:-}" = "uninstall" ]; then
  echo "  Uninstalling FFWD AgentGuard (OpenClaw)..."
  rm -rf "$HOME/.openclaw/skills/ffwd-agent-guard" 2>/dev/null && echo "  Removed skill" || true
  rm -rf "$HOME/.openclaw/workspace/skills/ffwd-agent-guard" 2>/dev/null && echo "  Removed workspace skill" || true
  rm -rf "$FFWD_AGENT_GUARD_DIR" 2>/dev/null && echo "  Removed config" || true
  echo ""
  echo "  FFWD AgentGuard has been uninstalled."
  echo ""
  exit 0
fi

# ---- Detect OpenClaw install type ----
if [ -d "$HOME/.openclaw/workspace" ]; then
  SKILLS_DIR="$HOME/.openclaw/workspace/skills/ffwd-agent-guard"
  PLATFORM="openclaw-workspace"
elif [ -d "$HOME/.openclaw" ]; then
  SKILLS_DIR="$HOME/.openclaw/skills/ffwd-agent-guard"
  PLATFORM="openclaw-managed"
else
  echo "  ERROR: OpenClaw is not installed (~/.openclaw not found)."
  echo "  Install OpenClaw first, then re-run this script."
  exit 1
fi

echo "  Platform: $PLATFORM"
echo "  Install target: $SKILLS_DIR"
echo ""

# ---- Step 1: Register OpenClaw plugin ----
echo "[1/2] Registering OpenClaw plugin..."
if command -v openclaw &>/dev/null; then
  # Remove stale registration from old path (pre-restructure)
  echo y | openclaw plugins uninstall ffwd-agent-guard 2>/dev/null || true
  openclaw plugins install -l "$SCRIPT_DIR"
  echo "  OK: Plugin registered (ffwd-agent-guard)"

  # Restart gateway so it picks up the new plugin
  GW_PID=$(pgrep -x openclaw-gateway 2>/dev/null || true)
  if [ -n "$GW_PID" ]; then
    echo "  Restarting OpenClaw gateway (pid $GW_PID)..."
    if launchctl bootout "gui/$UID/ai.openclaw.gateway" 2>/dev/null; then
      sleep 1
      launchctl bootstrap "gui/$UID" "$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist" 2>/dev/null \
        || openclaw gateway &>/dev/null &
    else
      kill "$GW_PID" 2>/dev/null || true
      sleep 1
      openclaw gateway &>/dev/null &
    fi
    echo "  OK: Gateway restarted"
  fi
else
  echo "  WARN: openclaw CLI not found, skipping plugin install"
  echo "        Run manually: openclaw plugins install -l $SCRIPT_DIR"
fi

# ---- Step 2: Create config directory ----
echo "[2/2] Setting up configuration..."
mkdir -p "$FFWD_AGENT_GUARD_DIR"
if [ ! -f "$FFWD_AGENT_GUARD_DIR/config.json" ]; then
  if [ -f "$SCRIPT_DIR/config.default.yaml" ] && command -v node &>/dev/null; then
    node -e "
      const yaml = require('js-yaml');
      const fs = require('fs');
      const cfg = yaml.load(fs.readFileSync('$SCRIPT_DIR/config.default.yaml', 'utf8'));
      fs.writeFileSync('$FFWD_AGENT_GUARD_DIR/config.json', JSON.stringify(cfg, null, 2));
    " 2>/dev/null || cp "$SCRIPT_DIR/config.default.yaml" "$FFWD_AGENT_GUARD_DIR/config.yaml"
  fi
  echo "  OK: Default config written"
else
  echo "  OK: Existing config kept"
fi

# ---- Done ----
echo ""
echo "  FFWD AgentGuard (OpenClaw) is installed!"
echo ""
echo "  Hooks take effect on the next OpenClaw task."
echo ""
echo "  Send your OpenClaw bot:"
echo ""
echo "    /ffwd-agent-guard scan <path>"
echo ""
echo "  To uninstall: $(basename "$0") --uninstall"
echo ""
