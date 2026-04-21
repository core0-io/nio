#!/usr/bin/env bash
set -euo pipefail

# Nio — Claude Code plugin setup
# Installs skill files, scripts, and hooks for Claude Code.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NIO_DIR="$HOME/.nio"
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
      echo "  --reset-config    Overwrite existing nio config with defaults."
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
echo "  Nio — Claude Code Plugin Setup"
echo "  ============================================="
echo "  Claude Code home: $CC_HOME"
echo ""

# ---- Pre-check: Node.js ----
if ! command -v node &>/dev/null; then
  echo "  ERROR: Node.js is not installed."
  echo "  Nio requires Node.js >= $MIN_NODE_VERSION."
  echo "  Install from: https://nodejs.org"
  exit 1
fi

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt "$MIN_NODE_VERSION" ]; then
  echo "  ERROR: Node.js v$(node -v) is too old."
  echo "  Nio requires Node.js >= $MIN_NODE_VERSION."
  exit 1
fi

# ---- Uninstall mode ----
if [ "$UNINSTALL" -eq 1 ]; then
  echo "  Uninstalling Nio (Claude Code)..."
  if command -v claude >/dev/null 2>&1; then
    claude plugin uninstall "nio@nio" >/dev/null 2>&1 \
      && echo "  Removed plugin" || true
    claude plugin marketplace remove "nio" >/dev/null 2>&1 \
      && echo "  Removed marketplace" || true
  fi
  rm -rf "$NIO_DIR" 2>/dev/null && echo "  Removed config" || true
  echo ""
  echo "  Nio has been uninstalled."
  echo ""
  exit 0
fi

# ---- Step 1: Register Claude Code plugin (marketplace + install) ----
# Hooks, skill files, and scripts all live in the plugin cache managed by CC.
# This handles three states:
#   1. Fresh user — register marketplace + install plugin
#   2. Stale marketplace path (e.g. pre-restructure repo layout) — fix + reinstall
#   3. Already installed — sync the plugin cache with local source changes
echo "[1/2] Registering Claude Code plugin..."
MARKETPLACE_NAME="nio"
PLUGIN_NAME="nio"
PLUGIN_ID="$PLUGIN_NAME@$MARKETPLACE_NAME"
MARKETPLACE_MANIFEST="$SCRIPT_DIR/.claude-plugin/marketplace.json"
KNOWN_MARKETPLACES="$CC_HOME/plugins/known_marketplaces.json"
INSTALLED_PLUGINS="$CC_HOME/plugins/installed_plugins.json"

if [ ! -f "$MARKETPLACE_MANIFEST" ]; then
  echo "  ERROR: Marketplace manifest missing at $MARKETPLACE_MANIFEST"
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "  WARN: 'claude' CLI not in PATH. Skipping plugin registration."
  echo "        After installing Claude Code CLI, run:"
  echo "          claude plugin marketplace add '$SCRIPT_DIR'"
  echo "          claude plugin install $PLUGIN_ID"
else
  # Read current marketplace registration (if any).
  REGISTERED_PATH=""
  if [ -f "$KNOWN_MARKETPLACES" ]; then
    REGISTERED_PATH=$(
      KNOWN_MARKETPLACES="$KNOWN_MARKETPLACES" \
      MARKETPLACE_NAME="$MARKETPLACE_NAME" \
      node -e '
        try {
          const fs = require("fs");
          const j = JSON.parse(fs.readFileSync(process.env.KNOWN_MARKETPLACES, "utf8"));
          const m = j[process.env.MARKETPLACE_NAME];
          if (m && m.source && m.source.path) process.stdout.write(m.source.path);
        } catch {}
      ' 2>/dev/null
    )
  fi

  # Fix marketplace if missing or pointing at the wrong path.
  MARKETPLACE_CHANGED=0
  if [ "$REGISTERED_PATH" != "$SCRIPT_DIR" ]; then
    if [ -n "$REGISTERED_PATH" ]; then
      echo "  Marketplace path is stale ($REGISTERED_PATH), re-registering..."
      claude plugin marketplace remove "$MARKETPLACE_NAME" >/dev/null 2>&1 || true
      # A stale marketplace means the cached plugin entry is pointing at the
      # wrong source too — force a clean reinstall.
      claude plugin uninstall "$PLUGIN_ID" >/dev/null 2>&1 || true
    else
      echo "  Registering marketplace..."
    fi
    if claude plugin marketplace add "$SCRIPT_DIR" >/dev/null 2>&1; then
      echo "  OK: Marketplace registered at $SCRIPT_DIR"
      MARKETPLACE_CHANGED=1
    else
      echo "  WARN: Could not register marketplace. Run manually:"
      echo "        claude plugin marketplace add '$SCRIPT_DIR'"
    fi
  else
    echo "  OK: Marketplace already registered"
  fi

  # Check if plugin is installed; install if not (or if marketplace just changed).
  PLUGIN_INSTALLED=0
  if [ "$MARKETPLACE_CHANGED" -eq 0 ] && [ -f "$INSTALLED_PLUGINS" ]; then
    PLUGIN_INSTALLED=$(
      INSTALLED_PLUGINS="$INSTALLED_PLUGINS" \
      PLUGIN_ID="$PLUGIN_ID" \
      node -e '
        try {
          const fs = require("fs");
          const j = JSON.parse(fs.readFileSync(process.env.INSTALLED_PLUGINS, "utf8"));
          const e = j.plugins[process.env.PLUGIN_ID];
          process.stdout.write(Array.isArray(e) && e.length ? "1" : "0");
        } catch { process.stdout.write("0"); }
      ' 2>/dev/null
    )
  fi

  if [ "$PLUGIN_INSTALLED" != "1" ]; then
    echo "  Installing plugin $PLUGIN_ID..."
    if claude plugin install "$PLUGIN_ID" >/dev/null 2>&1; then
      echo "  OK: Plugin installed"
    else
      echo "  WARN: Could not install plugin. Run manually:"
      echo "        claude plugin install $PLUGIN_ID"
    fi
  else
    echo "  OK: Plugin already installed"
  fi

  # Sync plugin cache with local source (dev iteration: re-running setup.sh
  # after editing scripts/hooks should take effect without a full reinstall).
  PLUGIN_CACHE_BASE="$CC_HOME/plugins/cache/$MARKETPLACE_NAME/$PLUGIN_NAME"
  if [ -d "$PLUGIN_CACHE_BASE" ]; then
    for CACHE_VERSION_DIR in "$PLUGIN_CACHE_BASE"/*/; do
      [ -d "$CACHE_VERSION_DIR" ] || continue
      rm -rf "$CACHE_VERSION_DIR/skills/nio/scripts"
      mkdir -p "$CACHE_VERSION_DIR/skills/nio/scripts"
      cp -r "$SCRIPT_DIR/skills/nio/scripts/"* "$CACHE_VERSION_DIR/skills/nio/scripts/"
      mkdir -p "$CACHE_VERSION_DIR/hooks"
      cp "$SCRIPT_DIR/hooks/hooks.json" "$CACHE_VERSION_DIR/hooks/hooks.json" 2>/dev/null || true
    done
    echo "  OK: Plugin cache synced"
  fi
fi

# ---- Step 2: Create config directory ----
echo "[2/2] Setting up configuration..."
mkdir -p "$NIO_DIR"
if [ "$RESET_CONFIG" -eq 1 ] || [ ! -f "$NIO_DIR/config.yaml" ]; then
  if [ -f "$SCRIPT_DIR/config.default.yaml" ]; then
    cp "$SCRIPT_DIR/config.default.yaml" "$NIO_DIR/config.yaml"
  fi
  [ "$RESET_CONFIG" -eq 1 ] && echo "  OK: Config reset to defaults" || echo "  OK: Default config written"
else
  echo "  OK: Existing config kept"
fi

# ---- Done ----
echo ""
echo "  Nio (Claude Code) is installed!"
echo ""
echo "  Hooks take effect on the next Claude Code session."
echo ""
echo "  Open Claude Code and type:"
echo ""
echo "    /nio scan <path>"
echo ""
echo "  Other commands:"
echo "    /nio scan <path>    Scan code for security risks"
echo "    /nio action <desc>  Evaluate action safety"
echo "    /nio report         View security event log"
echo ""
echo "  To uninstall: $(basename "$0") --uninstall"
echo ""
