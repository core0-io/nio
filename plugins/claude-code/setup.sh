#!/usr/bin/env bash
set -euo pipefail

# FFWD AgentGuard — Claude Code plugin setup
# Installs skill files, scripts, and hooks for Claude Code.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_SRC="$SCRIPT_DIR/skills/ffwd-agent-guard"
FFWD_AGENT_GUARD_DIR="$HOME/.ffwd-agent-guard"
MIN_NODE_VERSION=18

echo ""
echo "  FFWD AgentGuard — Claude Code Plugin Setup"
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
  echo "  Uninstalling FFWD AgentGuard (Claude Code)..."
  rm -rf "$HOME/.claude/skills/ffwd-agent-guard" 2>/dev/null && echo "  Removed skill" || true
  rm -rf "$FFWD_AGENT_GUARD_DIR" 2>/dev/null && echo "  Removed config" || true
  echo ""
  echo "  FFWD AgentGuard has been uninstalled."
  echo ""
  exit 0
fi

SKILLS_DIR="$HOME/.claude/skills/ffwd-agent-guard"

# ---- Step 1: Install skill files ----
echo "[1/3] Installing skill files..."
mkdir -p "$SKILLS_DIR"
for f in SKILL.md README.md scan-rules.md action-policies.md .clawignore; do
  [ -f "$SKILL_SRC/$f" ] && cp "$SKILL_SRC/$f" "$SKILLS_DIR/" 2>/dev/null || true
done
echo "  OK: Skill files installed"

# ---- Step 2: Install scripts ----
echo "[2/3] Installing scripts..."
mkdir -p "$SKILLS_DIR/scripts/lib"
cp -r "$SKILL_SRC/scripts/"* "$SKILLS_DIR/scripts/"

# Copy node_modules if present (production dependencies)
if [ -d "$SKILL_SRC/node_modules" ]; then
  rm -rf "$SKILLS_DIR/node_modules"
  cp -r "$SKILL_SRC/node_modules" "$SKILLS_DIR/node_modules"
fi
echo "  OK: Scripts installed"

# ---- Sync plugin cache (if installed via Claude Code plugin manager) ----
PLUGIN_CACHE_BASE="$HOME/.claude/plugins/cache/ffwd-agent-guard/ffwd-agent-guard"
if [ -d "$PLUGIN_CACHE_BASE" ]; then
  for CACHE_VERSION_DIR in "$PLUGIN_CACHE_BASE"/*/; do
    [ -d "$CACHE_VERSION_DIR" ] || continue
    echo "  Syncing plugin cache: $CACHE_VERSION_DIR"
    mkdir -p "$CACHE_VERSION_DIR/skills/ffwd-agent-guard/scripts"
    cp -r "$SKILL_SRC/scripts/"* "$CACHE_VERSION_DIR/skills/ffwd-agent-guard/scripts/"
    cp "$SCRIPT_DIR/hooks/hooks.json" "$CACHE_VERSION_DIR/hooks/hooks.json" 2>/dev/null || true
    if [ -d "$SKILL_SRC/node_modules" ]; then
      rm -rf "$CACHE_VERSION_DIR/skills/ffwd-agent-guard/node_modules"
      cp -r "$SKILL_SRC/node_modules" "$CACHE_VERSION_DIR/skills/ffwd-agent-guard/node_modules"
    fi
  done
fi

# ---- Step 3: Create config directory ----
echo "[3/3] Setting up configuration..."
mkdir -p "$FFWD_AGENT_GUARD_DIR"
RESET_CONFIG=0
if [ "${1:-}" = "--reset-config" ]; then
  RESET_CONFIG=1
fi
if [ "$RESET_CONFIG" -eq 1 ] || [ ! -f "$FFWD_AGENT_GUARD_DIR/config.json" ]; then
  if command -v node &>/dev/null && [ -f "$SCRIPT_DIR/config.default.yaml" ]; then
    node -e "
      const yaml = require('js-yaml');
      const fs = require('fs');
      const cfg = yaml.load(fs.readFileSync('$SCRIPT_DIR/config.default.yaml', 'utf8'));
      fs.writeFileSync('$FFWD_AGENT_GUARD_DIR/config.json', JSON.stringify(cfg, null, 2));
    " 2>/dev/null || cp "$SCRIPT_DIR/config.default.yaml" "$FFWD_AGENT_GUARD_DIR/config.yaml"
  fi
  [ "$RESET_CONFIG" -eq 1 ] && echo "  OK: Config reset to defaults" || echo "  OK: Default config written"
else
  echo "  OK: Existing config kept"
fi

# ---- Done ----
echo ""
echo "  FFWD AgentGuard (Claude Code) is installed!"
echo ""
echo "  Hooks take effect on the next Claude Code session."
echo ""
echo "  Open Claude Code and type:"
echo ""
echo "    /ffwd-agent-guard scan <path>"
echo ""
echo "  Installed to: $SKILLS_DIR"
echo ""
echo "  Other commands:"
echo "    /ffwd-agent-guard scan <path>    Scan code for security risks"
echo "    /ffwd-agent-guard action <desc>  Evaluate action safety"
echo "    /ffwd-agent-guard report         View security event log"
echo ""
echo "  To uninstall: $(basename "$0") --uninstall"
echo ""
