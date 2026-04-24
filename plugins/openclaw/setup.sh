#!/usr/bin/env bash
set -euo pipefail

# Nio — OpenClaw plugin setup
# Registers the plugin and installs hooks for OpenClaw / ClawHub.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NIO_DIR="$HOME/.nio"
MIN_NODE_VERSION=18

# ---- Parse args ----
UNINSTALL=0
RESET_CONFIG=0
OPENCLAW_HOME_ARG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall|uninstall)
      UNINSTALL=1; shift ;;
    --reset-config)
      RESET_CONFIG=1; shift ;;
    --openclaw-home)
      OPENCLAW_HOME_ARG="${2:-}"; shift 2 ;;
    --openclaw-home=*)
      OPENCLAW_HOME_ARG="${1#*=}"; shift ;;
    -h|--help)
      echo "Usage: $(basename "$0") [--openclaw-home <path>] [--reset-config] [--uninstall]"
      echo ""
      echo "  --openclaw-home <path>  Path to .openclaw directory."
      echo "                          Defaults to \$OPENCLAW_STATE_DIR, then \$HOME/.openclaw."
      echo "  --reset-config          Overwrite existing nio config with defaults."
      echo "  --uninstall             Remove the plugin and config."
      exit 0 ;;
    *)
      echo "  ERROR: Unknown option: $1"
      echo "  Run with --help for usage."
      exit 1 ;;
  esac
done

# Resolve OpenClaw home: --openclaw-home > $OPENCLAW_STATE_DIR > $HOME/.openclaw
if [ -n "$OPENCLAW_HOME_ARG" ]; then
  OPENCLAW_HOME="$OPENCLAW_HOME_ARG"
elif [ -n "${OPENCLAW_STATE_DIR:-}" ]; then
  OPENCLAW_HOME="$OPENCLAW_STATE_DIR"
else
  OPENCLAW_HOME="$HOME/.openclaw"
fi

# Keep `openclaw` CLI aligned with our resolved path
export OPENCLAW_STATE_DIR="$OPENCLAW_HOME"

echo ""
echo "  Nio — OpenClaw Plugin Setup"
echo "  ============================================="
echo "  OpenClaw home: $OPENCLAW_HOME"
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
  echo "  Uninstalling Nio (OpenClaw)..."
  if command -v openclaw >/dev/null 2>&1; then
    echo y | openclaw plugins uninstall nio >/dev/null 2>&1 \
      && echo "  Removed plugin" || true
  fi
  rm -rf "$OPENCLAW_HOME/skills/nio" 2>/dev/null && echo "  Removed skill" || true
  rm -rf "$OPENCLAW_HOME/workspace/skills/nio" 2>/dev/null && echo "  Removed workspace skill" || true
  rm -rf "$NIO_DIR" 2>/dev/null && echo "  Removed config" || true
  echo ""
  echo "  Nio has been uninstalled."
  echo ""
  exit 0
fi

# ---- Detect OpenClaw install type ----
if [ -d "$OPENCLAW_HOME/workspace" ]; then
  SKILLS_DIR="$OPENCLAW_HOME/workspace/skills/nio"
  PLATFORM="openclaw-workspace"
elif [ -d "$OPENCLAW_HOME" ]; then
  SKILLS_DIR="$OPENCLAW_HOME/skills/nio"
  PLATFORM="openclaw-managed"
else
  echo "  ERROR: OpenClaw is not installed ($OPENCLAW_HOME not found)."
  echo "  Install OpenClaw first, then re-run this script."
  echo "  Or pass --openclaw-home <path> if your .openclaw lives elsewhere."
  exit 1
fi

echo "  Platform: $PLATFORM"
echo "  Install target: $SKILLS_DIR"
echo ""

SKILL_SRC="$SCRIPT_DIR/skills/nio"

# ---- Step 1: Register OpenClaw plugin ----
echo "[1/3] Registering OpenClaw plugin..."
if command -v openclaw &>/dev/null; then
  # Scrub any stale paths from openclaw.json before install. OpenClaw's CLI
  # validates every entry in plugins.load.paths upfront, so a single dangling
  # path (e.g. a previous release-zip install at ~/Work/.../nio-openclaw/plugin
  # that has since been removed) fails the whole `plugins install` command.
  OC_CONFIG="$OPENCLAW_HOME/openclaw.json"
  if [[ -f "$OC_CONFIG" ]] && command -v node &>/dev/null; then
    node -e '
      const fs = require("fs");
      const p = process.argv[1];
      const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
      let changed = false;
      const paths = cfg?.plugins?.load?.paths;
      if (Array.isArray(paths)) {
        const kept = paths.filter((q) => {
          try { return fs.statSync(q).isDirectory(); }
          catch { changed = true; return false; }
        });
        if (changed) cfg.plugins.load.paths = kept;
      }
      const nio = cfg?.plugins?.installs?.nio;
      if (nio?.installPath) {
        try { fs.statSync(nio.installPath); }
        catch { delete cfg.plugins.installs.nio; changed = true; }
      }
      if (changed) {
        fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
        console.log("  Cleaned stale plugin paths from openclaw.json");
      }
    ' "$OC_CONFIG" || true
  fi
  openclaw plugins install -l "$SCRIPT_DIR/plugin"
  echo "  OK: Plugin registered (nio)"

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

# ---- Step 2: Install skill files ----
echo "[2/3] Installing skill files..."
if [ -d "$SKILL_SRC" ]; then
  mkdir -p "$SKILLS_DIR"
  for f in SKILL.md SCAN-RULES.md ACTION-POLICIES.md README.md .clawignore; do
    [ -f "$SKILL_SRC/$f" ] && cp "$SKILL_SRC/$f" "$SKILLS_DIR/" 2>/dev/null || true
  done
  if [ -d "$SKILL_SRC/scripts" ]; then
    rm -rf "$SKILLS_DIR/scripts"
    mkdir -p "$SKILLS_DIR/scripts"
    cp -r "$SKILL_SRC/scripts/"* "$SKILLS_DIR/scripts/"
  fi
  echo "  OK: Skill installed to $SKILLS_DIR"
else
  echo "  WARN: Skill source not found at $SKILL_SRC"
  echo "        Run 'npm run build' first to generate skill files."
fi

# ---- Step 3: Create config directory ----
echo "[3/3] Setting up configuration..."
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
echo "  Nio (OpenClaw) is installed!"
echo ""
echo "  Hooks take effect on the next OpenClaw task."
echo ""
echo "  Send your OpenClaw bot:"
echo ""
echo "    /nio scan <path>"
echo ""
echo "  To uninstall: $(basename "$0") --uninstall"
echo ""
