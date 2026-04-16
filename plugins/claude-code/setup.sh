#!/usr/bin/env bash
set -euo pipefail

# FFWD AgentGuard — Claude Code plugin setup
# Installs skill files, scripts, and hooks for Claude Code.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_SRC="$SCRIPT_DIR/skills/ffwd-agent-guard"
FFWD_AGENT_GUARD_DIR="$HOME/.ffwd-agent-guard"
MIN_NODE_VERSION=18

# ---- Parse args ----
UNINSTALL=0
RESET_CONFIG=0
CC_HOME_ARG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall|uninstall)
      UNINSTALL=1; shift ;;
    --reset-config)
      RESET_CONFIG=1; shift ;;
    --cc-home)
      CC_HOME_ARG="${2:-}"; shift 2 ;;
    --cc-home=*)
      CC_HOME_ARG="${1#*=}"; shift ;;
    -h|--help)
      echo "Usage: $(basename "$0") [--cc-home <path>] [--reset-config] [--uninstall]"
      echo ""
      echo "  --cc-home <path>  Path to .claude directory."
      echo "                    Defaults to \$CLAUDE_CONFIG_DIR, then \$HOME/.claude."
      echo "  --reset-config    Overwrite existing ffwd-agent-guard config with defaults."
      echo "  --uninstall       Remove the plugin and config."
      exit 0 ;;
    *)
      echo "  ERROR: Unknown option: $1"
      echo "  Run with --help for usage."
      exit 1 ;;
  esac
done

# Resolve Claude Code home: --cc-home > $CLAUDE_CONFIG_DIR > $HOME/.claude
if [ -n "$CC_HOME_ARG" ]; then
  CC_HOME="$CC_HOME_ARG"
elif [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
  CC_HOME="$CLAUDE_CONFIG_DIR"
else
  CC_HOME="$HOME/.claude"
fi

# Keep Claude Code CLI aligned with our resolved path
export CLAUDE_CONFIG_DIR="$CC_HOME"

echo ""
echo "  FFWD AgentGuard — Claude Code Plugin Setup"
echo "  ============================================="
echo "  Claude Code home: $CC_HOME"
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
if [ "$UNINSTALL" -eq 1 ]; then
  echo "  Uninstalling FFWD AgentGuard (Claude Code)..."
  rm -rf "$CC_HOME/skills/ffwd-agent-guard" 2>/dev/null && echo "  Removed skill" || true
  rm -rf "$FFWD_AGENT_GUARD_DIR" 2>/dev/null && echo "  Removed config" || true
  echo ""
  echo "  FFWD AgentGuard has been uninstalled."
  echo ""
  exit 0
fi

SKILLS_DIR="$CC_HOME/skills/ffwd-agent-guard"

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
PLUGIN_CACHE_BASE="$CC_HOME/plugins/cache/ffwd-agent-guard/ffwd-agent-guard"
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
